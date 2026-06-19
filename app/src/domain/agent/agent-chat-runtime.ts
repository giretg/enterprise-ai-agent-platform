import type { AgentRepository, DocumentRepository, TicketRepository, ToolBrokerRepository } from '@/repositories/interfaces'
import { composeSystemPrompt } from '@/lib/agent-prompt'
import { formatOrgRoster } from '@/lib/agent-org-roster'
import { buildRunAsAuthorization } from '@/lib/run-as-payload'
import type { ModelGateway } from '../gateway/model-gateway'
import type { ConversationService } from '../conversation/conversation-service'
import type { ToolBrokerService } from '../tool-broker/tool-broker-service'
import { listAllowedChatTools, runAgentChatWithTools } from './chat-tool-loop'

const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)$/i
const IMAGE_MARKER = /^(\[image:([^\]]+)\])([\s\S]*)$/

type KbSearchHit = {
  docId: string
  snippet: string
  sourceRef: string
  memoryVersion: number | null
}

function formatKbHitsForPrompt(hits: KbSearchHit[]): string {
  if (hits.length === 0) return '(nincs találat)'
  return hits
    .map(
      (hit, index) =>
        `[${index + 1}] docId=${hit.docId}; sourceRef=${hit.sourceRef}; memoryVersion=${hit.memoryVersion ?? 'unknown'}\n${hit.snippet}`,
    )
    .join('\n\n')
}

function isImageDocument(doc: { filename: string; extractedText: string | null }): boolean {
  if (IMAGE_EXT.test(doc.filename)) return true
  return Boolean(doc.extractedText?.startsWith('[image:'))
}

function formatAttachmentBlock(
  docs: Array<{ id: string; filename: string; extractedText: string | null }>,
): string {
  if (docs.length === 0) return ''
  const parts = docs.map((doc) => {
    if (isImageDocument(doc)) {
      return `[Csatolmány (kép): ${doc.filename}, documentId=${doc.id}]`
    }
    const text = doc.extractedText?.trim()
    if (text) {
      return `[Csatolmány: ${doc.filename}]\n${text.slice(0, 4000)}`
    }
    return `[Csatolmány: ${doc.filename}, documentId=${doc.id}]`
  })
  return `\n\n--- Csatolmányok ---\n${parts.join('\n\n')}`
}

export type ChatAttachmentView = {
  documentId: string
  filename: string
  kind: 'text' | 'image'
  previewDataUrl?: string | null
}

export type ChatMessageView = {
  id: string
  role: 'user' | 'agent' | 'system'
  text: string
  attachments: ChatAttachmentView[]
  createdAt: Date
}

export type ChatSessionView = {
  id: string
  title: string
  preview: string | null
  lastMessageAt: string
  createdAt: string
}

function parseStoredMessage(content: string): { text: string; attachmentIds: string[] } {
  try {
    const parsed = JSON.parse(content) as { text?: string; attachmentIds?: string[] }
    if (typeof parsed.text === 'string') {
      return {
        text: parsed.text,
        attachmentIds: Array.isArray(parsed.attachmentIds)
          ? parsed.attachmentIds.filter((id): id is string => typeof id === 'string')
          : [],
      }
    }
  } catch {
    // plain text legacy
  }
  return { text: content, attachmentIds: [] }
}

function encodeStoredMessage(text: string, attachmentIds: string[]): string {
  if (attachmentIds.length === 0) return text
  return JSON.stringify({ text, attachmentIds })
}

export class AgentChatRuntime {
  constructor(
    private agents: AgentRepository,
    private documents: DocumentRepository,
    private tickets: TicketRepository,
    private gateway: ModelGateway,
    private conversations: ConversationService,
    private toolBroker: ToolBrokerService,
    private toolCaps: ToolBrokerRepository,
  ) {}

  async sendMessage(params: {
    agentId: string
    content: string
    createdById: string
    tenantId?: string | null
    conversationId?: string
    attachmentDocumentIds?: string[]
  }) {
    const text = params.content.trim()
    const attachmentIds = params.attachmentDocumentIds ?? []
    if (!text && attachmentIds.length === 0) throw new Error('Message is required')

    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')

    let conversationId = params.conversationId
    if (conversationId) {
      const existing = await this.conversations.getConversation(conversationId, params.tenantId ?? null)
      if (existing.conversation.agentId !== params.agentId) {
        throw new Error('Conversation agent mismatch')
      }
    } else {
      const title = (text || 'Új beszélgetés').slice(0, 80)
      const created = await this.conversations.createConversation({
        agentId: params.agentId,
        createdById: params.createdById,
        tenantId: params.tenantId ?? null,
        title,
      })
      conversationId = created.id
    }

    const attachmentDocs = await this.loadDocuments(attachmentIds)
    const attachmentBlock = formatAttachmentBlock(attachmentDocs)
    const userFacingText = text || '(csatolmányok)'

    await this.conversations.appendMessage({
      conversationId,
      role: 'user',
      content: encodeStoredMessage(userFacingText, attachmentIds),
      actorType: 'human',
      actorId: params.createdById,
    })

    const history = await this.conversations.getConversation(conversationId, params.tenantId ?? null)
    const kbSearch = await this.fetchKbSearchContext({
      agentId: params.agentId,
      agentVersion: agentDetails.agent.currentVersion,
      conversationId,
      actingUserId: params.createdById,
      query: text,
    })
    const gatewayMessages = await this.buildGatewayMessages(
      agentDetails,
      history.messages,
      attachmentBlock,
      kbSearch,
    )

    const modelConfig = agentDetails.agent.modelConfig as {
      provider: string
      model: string
      temperature?: number
      maxTokens?: number
    }

    const allowedChatTools = await listAllowedChatTools(this.toolCaps, params.agentId)
    const reply =
      allowedChatTools.length > 0
        ? (
            await runAgentChatWithTools({
              gateway: this.gateway,
              toolBroker: this.toolBroker,
              toolCaps: this.toolCaps,
              agentId: params.agentId,
              agentVersion: agentDetails.agent.currentVersion,
              conversationId,
              actingUserId: params.createdById,
              messages: gatewayMessages,
              modelConfig,
              allowedTools: allowedChatTools,
            })
          ).content
        : (
            await this.gateway.call({
              agentId: params.agentId,
              conversationId,
              messages: gatewayMessages,
              modelConfig,
            })
          ).content

    const agentMessage = await this.conversations.appendMessage({
      conversationId,
      role: 'agent',
      content: reply.trim(),
      agentVersion: agentDetails.agent.currentVersion,
      model: modelConfig.model,
      actorType: 'agent',
      actorId: params.agentId,
    })

    return {
      conversationId,
      messageId: agentMessage.id,
      reply: reply.trim(),
    }
  }

  async createTaskTicket(params: {
    agentId: string
    content: string
    createdById: string
    tenantId?: string | null
    conversationId?: string | null
    attachmentDocumentIds?: string[]
    executeAfter?: Date | null
    authorizeRunAs?: boolean
  }) {
    const text = params.content.trim()
    const attachmentIds = params.attachmentDocumentIds ?? []
    if (!text && attachmentIds.length === 0) throw new Error('Task description is required')

    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')

    const attachmentDocs = await this.loadDocuments(attachmentIds)
    const modelConfig = agentDetails.agent.modelConfig as {
      provider: string
      model: string
      temperature?: number
      maxTokens?: number
    }

    const titleSource = text || attachmentDocs[0]?.filename || 'Feladat'
    const runAsPayload = params.authorizeRunAs
      ? buildRunAsAuthorization({ userId: params.createdById })
      : {}
    const ticket = await this.tickets.create({
      type: 'interaction',
      title: `Feladat: ${titleSource.slice(0, 80)}`,
      state: 'ready',
      assigneeType: 'agent',
      assigneeId: params.agentId,
      agentId: params.agentId,
      playbookRef: null,
      conversationId: params.conversationId ?? null,
      payload: {
        question: text,
        source: 'agent_chat',
        attachmentDocumentIds: attachmentIds,
        agentVersion: agentDetails.agent.currentVersion,
        model: modelConfig.model,
        memoryVersion: agentDetails.memoryVersion,
        scheduledRun: params.executeAfter ? true : undefined,
        ...runAsPayload,
      },
      sourceDocumentId: attachmentIds[0] ?? null,
      executeAfter: params.executeAfter ?? null,
      dueBy: null,
      createdById: params.createdById,
    })

    return ticket
  }

  async getConversationMessages(
    conversationId: string,
    tenantId?: string | null,
    agentId?: string,
  ): Promise<ChatMessageView[]> {
    const { conversation, messages } = await this.conversations.getConversation(
      conversationId,
      tenantId,
    )
    if (agentId && conversation.agentId !== agentId) {
      throw new Error('Conversation agent mismatch')
    }
    const views: ChatMessageView[] = []

    for (const message of messages) {
      if (!message.content || message.contentDeletedAt) continue
      const parsed = parseStoredMessage(message.content)
      const attachments: ChatAttachmentView[] = []

      for (const documentId of parsed.attachmentIds) {
        const doc = await this.documents.findById(documentId)
        if (!doc) continue
        const kind = isImageDocument(doc) ? 'image' : 'text'
        let previewDataUrl: string | null = null
        if (kind === 'image' && doc.extractedText) {
          const imageMatch = doc.extractedText.match(IMAGE_MARKER)
          if (imageMatch?.[2] && imageMatch[3]) {
            previewDataUrl = `data:${imageMatch[2]};base64,${imageMatch[3]}`
          }
        }
        attachments.push({
          documentId: doc.id,
          filename: doc.filename,
          kind,
          previewDataUrl,
        })
      }

      views.push({
        id: message.id,
        role: message.role as ChatMessageView['role'],
        text: parsed.text,
        attachments,
        createdAt: message.createdAt,
      })
    }

    return views
  }

  async listSessions(params: {
    agentId: string
    createdById: string
    tenantId?: string | null
  }): Promise<ChatSessionView[]> {
    const rows = await this.conversations.listForAgentUser({
      agentId: params.agentId,
      createdById: params.createdById,
      tenantId: params.tenantId ?? null,
    })

    return rows.map((row) => ({
      id: row.id,
      title: row.title?.trim() || row.previewText?.slice(0, 60) || 'Beszélgetés',
      preview: row.previewText?.slice(0, 120) ?? null,
      lastMessageAt: row.lastMessageAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    }))
  }

  private async loadDocuments(ids: string[]) {
    const docs = await Promise.all(ids.map((id) => this.documents.findById(id)))
    return docs.filter((doc): doc is NonNullable<(typeof docs)[number]> => Boolean(doc))
  }

  private async fetchKbSearchContext(params: {
    agentId: string
    agentVersion: number
    conversationId: string
    actingUserId: string
    query: string
  }): Promise<{ enabled: boolean; hits: KbSearchHit[] }> {
    const capability = await this.toolCaps.findCapability(params.agentId, 'kb_search')
    if (!capability?.allowed || !params.query.trim()) {
      return { enabled: false, hits: [] }
    }

    const search = await this.toolBroker.invoke({
      agentId: params.agentId,
      agentVersion: params.agentVersion,
      conversationId: params.conversationId,
      actingUserId: params.actingUserId,
      tool: 'kb_search',
      args: { query: params.query.trim(), k: 6 },
    })

    if (search.denied || !('hits' in search.result) || !Array.isArray(search.result.hits)) {
      return { enabled: true, hits: [] }
    }

    return { enabled: true, hits: search.result.hits as KbSearchHit[] }
  }

  private async buildGatewayMessages(
    agentDetails: NonNullable<Awaited<ReturnType<AgentRepository['findByIdWithDetails']>>>,
    historyMessages: Array<{ role: string; content: string | null; contentDeletedAt: Date | null }>,
    latestAttachmentBlock: string,
    kbSearch: { enabled: boolean; hits: KbSearchHit[] },
  ) {
    const allAgents = await this.agents.findMany()
    const orgRoster = formatOrgRoster(allAgents)

    const messages: Array<{ role: 'user' | 'system'; content: string }> = [
      { role: 'system', content: composeSystemPrompt(agentDetails.agent) },
    ]

    if (agentDetails.memoryContent?.trim()) {
      messages.push({
        role: 'system',
        content: `Memória (aktív verzió):\n${agentDetails.memoryContent.trim()}`,
      })
    }

    if (kbSearch.enabled) {
      const answerInstruction =
        kbSearch.hits.length === 0
          ? 'A tudásbázis (kb_search) nem adott találatot erre a kérdésre. Ez NEM jelenti, hogy nincs válasz: email/postafiók kérdésnél gmail_search, fájl/munkaterület kérdésnél file_* eszköz — ha engedélyezve van. Csak akkor mondd, hogy nincs elég forrás, ha a releváns eszközök sem adnak adatot.'
          : 'A belső tudásbázis tényállításaihoz kizárólag az alábbi kb_search találatokra támaszkodj. Minden lényegi állításhoz adj forráshivatkozást.'
      messages.push({
        role: 'system',
        content: `${answerInstruction}\n\nTudásbázis találatok (kb_search):\n${formatKbHitsForPrompt(kbSearch.hits)}`,
      })
    }

    messages.push({ role: 'system', content: orgRoster })

    messages.push({
      role: 'system',
      content:
        'Ez egy közvetlen beszélgetés a felhasználóval. Válaszolj természetes, segítőkész hangnemben magyarul. Ha csatolmány érkezett, hivatkozz rá a válaszodban. Email, fájl, ticket vagy más agent feladat kérésénél használd a platform eszközöket — ne állítsd, hogy megcsináltad vagy nincs adat, ha nem hívtál eszközt.',
    })

    const visible = historyMessages.filter((m) => m.content && !m.contentDeletedAt)
    for (let i = 0; i < visible.length; i++) {
      const message = visible[i]
      if (!message.content) continue

      if (message.role === 'user') {
        const parsed = parseStoredMessage(message.content)
        const isLatest = i === visible.length - 1
        const content =
          isLatest && latestAttachmentBlock
            ? `${parsed.text || '(csatolmányok)'}${latestAttachmentBlock}`.trim()
            : parsed.text
        messages.push({ role: 'user', content })
      } else if (message.role === 'agent') {
        messages.push({ role: 'user', content: `[Korábbi agent válasz]\n${message.content}` })
      }
    }

    return messages
  }
}

export function imageDataUrlFromExtractedText(extractedText: string | null): string | null {
  if (!extractedText) return null
  const match = extractedText.match(IMAGE_MARKER)
  if (!match?.[2] || !match[3]) return null
  return `data:${match[2]};base64,${match[3]}`
}

export function imageMimeFromFilename(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return null
}
