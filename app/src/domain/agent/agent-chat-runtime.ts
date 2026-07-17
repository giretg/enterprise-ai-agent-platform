import type { Message, ToolCall } from '@prisma/client'
import type {
  AgentRepository,
  AuditRepository,
  DocumentRepository,
  PlaybookV2Repository,
  ProcessDefinitionRepository,
  TicketRepository,
  ToolBrokerRepository,
} from '@/repositories/interfaces'
import { composeSystemPrompt } from '@/lib/agent-prompt'
import { formatOrgRoster } from '@/lib/agent-org-roster'
import { buildRunAsAuthorization } from '@/lib/run-as-payload'
import { formatHitsForPrompt, type KbHit } from '@/lib/kb-format'
import { attachmentPageCount } from '@/lib/document-read'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import {
  chatTriggerSlotDescriptors,
  missingRequiredTriggerSlots,
  resolveChatTriggerInputPayload,
} from '@/lib/playbook-v2/trigger-input'
import type { ModelGateway } from '../gateway/model-gateway'
import { StreamingSensitiveTextRedactor } from '../gateway/sensitivity-router'
import type { ConversationService } from '../conversation/conversation-service'
import {
  assembleContext,
  buildMemoryRetrievalQuery,
  type ContextAssemblyMessage,
} from '../conversation/context-assembly'
import { MEMORY_RETRIEVAL_USAGE_PROMPT, kbSearchAnswerInstruction } from '@/lib/memory-prompt'
import {
  buildMemoryRetrievalRequest,
  loadProjectMemoryContext,
  memoryContextSystemMessages,
} from '../memory/memory-runtime-helper'
import type { MemoryRetrievalService } from '../memory/memory-retrieval-service'
import type { ToolBrokerService } from '../tool-broker/tool-broker-service'
import type { WorkspaceStorage } from '../file-editor/workspace-storage'
import type { CompiledSpec } from '../playbook/playbook-compiler'
import type { ProcessService } from '../playbook/process-service'
import {
  AgentToolLoopCancelledError,
  listAllowedChatTools,
  resolveToolLoopMaxTurns,
  runAgentToolLoop,
  type LoadSkillFn,
  type ToolLoopActivityEvent,
  type ToolLoopMemoryCandidateEvent,
} from './chat-tool-loop'
import type { SkillService } from '../skill/skill-service'
import { assembleGatewayMessages, type PromptSegments } from './prompt-assembler'
import {
  isChatTurnCancelRequested,
  registerActiveChatTurn,
  unregisterActiveChatTurn,
} from '@/lib/agent-chat-active-turn-registry'

const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)$/i
const IMAGE_MARKER = /^(\[image:([^\]]+)\])([\s\S]*)$/

function safeToolResultName(value: string): string {
  const cleaned = value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 80) || 'tool-result'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const TOOL_CALL_META_NOISE_KEYS = new Set([
  'ticketId',
  'conversationId',
  'actingUserId',
  'acting_user_id',
  'connector_id',
  'connectorId',
  'connector_type',
  'access_mode',
  'grant_id',
])

/**
 * A korábbi fordulók agent-válaszai eddig csak nyers szövegként kerültek a
 * promptba — a ténylegesen lefutott tool-hívások (pl. melyik fájlt szerkesztette
 * a file_edit) elvesztek, ezért a modell a következő körben nem tudott a saját
 * korábbi munkájára hivatkozni (l. repo_prepare/file_edit → PR-kérés eset).
 * Ez a szinopszis a ToolCall.resultMeta releváns mezőit adja vissza tömören.
 */
function formatToolCallSynopsisLine(call: ToolCall): string {
  const status = call.status === 'ok' ? 'siker' : call.status === 'denied' ? 'megtagadva' : 'hiba'
  const meta = isRecord(call.resultMeta) ? call.resultMeta : {}
  const details = Object.entries(meta)
    .filter(([key, value]) => !TOOL_CALL_META_NOISE_KEYS.has(key) && value !== null && value !== undefined)
    .slice(0, 8)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ')
  return `  • ${call.toolName} (${status})${details ? `: ${details}` : ''}`
}

function formatToolCallSynopsisBlock(calls: ToolCall[]): string {
  if (calls.length === 0) return ''
  return `\n\n[Ebben a körben lefutott eszközhívások]\n${calls.map(formatToolCallSynopsisLine).join('\n')}`
}

function upsertToolLoopActivity(
  activities: ToolLoopActivityEvent[],
  next: ToolLoopActivityEvent,
): ToolLoopActivityEvent[] {
  const index = activities.findIndex((activity) => activity.id === next.id)
  if (index < 0) return [...activities, next]
  return activities.map((activity, i) => (i === index ? { ...activity, ...next } : activity))
}

export type CancelledTurnSnapshot = {
  completedReply?: string | null
  activities?: ToolLoopActivityEvent[]
  turnToolCalls?: ToolCall[]
}

/**
 * Megszakított chat-forduló értelmes, DB-be menthető összefoglalója. Nem stream-chunkot
 * tárol, hanem a lefutott tool-hívások szinopszisát és — ha már kész volt — a teljes választ.
 */
export function buildCancelledTurnMessage(snapshot: CancelledTurnSnapshot): string {
  const completedReply = snapshot.completedReply?.trim() ?? ''
  const turnToolCalls = snapshot.turnToolCalls ?? []
  const activities = snapshot.activities ?? []

  const parts: string[] = ['⏹️ Megszakítva — a felhasználó leállította a választ.']

  const okTools = turnToolCalls.filter((call) => call.status === 'ok')
  const deniedTools = turnToolCalls.filter((call) => call.status === 'denied')
  if (okTools.length > 0 || deniedTools.length > 0) {
    const labels = [
      ...okTools.map((call) => call.toolName),
      ...deniedTools.map((call) => `${call.toolName} (megtagadva)`),
    ]
    parts.push(`\nLefutott eszközök: ${labels.join(', ')}.`)
  } else {
    const doneToolActivities = activities.filter(
      (activity) => activity.status === 'done' && activity.kind === 'tool',
    )
    if (doneToolActivities.length > 0) {
      parts.push('\n[Lefutott lépések]')
      for (const activity of doneToolActivities) {
        parts.push(
          `• ${activity.title}${activity.detail ? ` — ${activity.detail}` : ''}`,
        )
      }
    }
  }

  if (completedReply) {
    parts.push('\n[Válasz]')
    parts.push(completedReply)
  } else if (okTools.length > 0 || deniedTools.length > 0 || activities.some((activity) => activity.status === 'done')) {
    parts.push(
      '\nA válasz kidolgozása félbemaradt. Folytatáshoz írd: *folytasd*, vagy pontosítsd, mit szeretnél a fenti eredményből.',
    )
  } else {
    parts.push(
      '\nA válasz generálása még nem kezdődött el. Folytatáshoz ismételd meg a kérdést, vagy írd: *folytasd*.',
    )
  }

  return parts.join('\n')
}

type StreamTurnContext = {
  conversationId: string
  userMessageCreatedAt: Date
  agentId: string
  agentVersion: number
  createdById: string
  model: string
  activities: ToolLoopActivityEvent[]
  completedReply: string | null
  finalized: boolean
}

/**
 * A korábbi (user/agent) fordulókat gateway-üzenetekké alakítja VALÓDI
 * párbeszéd-szerepekkel: a felhasználó fordulói `user`, az agent korábbi
 * válaszai `assistant` szerepűek. Ez kritikus a többfordulós kontextushoz — ha
 * minden korábbi üzenet `user` szerepet kap (mint korábban a `[Korábbi agent
 * válasz]` prefix-szel), a gyenge modellek (pl. qwen3) nem látják, hogy ők maguk
 * már válaszoltak, és a következő fordulóban „nem volt előző kérésed"-et
 * mondanak. Az agent-fordulóhoz a saját tool-hívásainak szinopszisát is
 * hozzáfűzzük (melyik fájlt szerkesztette stb.). Exportálva, hogy a
 * kontextus-átvitel DB/gateway nélkül is tesztelhető legyen.
 */
export function buildHistoryGatewayMessages(
  historyMessages: ContextAssemblyMessage[],
  toolCalls: ToolCall[],
  latestAttachmentBlock: string,
  latestUserTextOverride?: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const result: Array<{ role: 'user' | 'assistant'; content: string }> = []
  const visible = historyMessages.filter((m) => m.content && !m.contentDeletedAt)
  for (let i = 0; i < visible.length; i++) {
    const message = visible[i]
    if (!message.content) continue

    if (message.role === 'user') {
      const parsed = parseStoredMessage(message.content)
      const isLatest = i === visible.length - 1
      const userText =
        isLatest && latestUserTextOverride !== undefined
          ? latestUserTextOverride
          : parsed.text
      const content =
        isLatest && latestAttachmentBlock
          ? `${userText || '(csatolmányok)'}${latestAttachmentBlock}`.trim()
          : userText
      result.push({ role: 'user', content })
    } else if (message.role === 'agent') {
      // A fordulóhoz tartozó tool-hívások: az előző (user) üzenet és ez az
      // agent-üzenet létrejötte közötti időablakban lefutott ToolCall-ok —
      // e nélkül a modell csak a nyers válaszszövegből következtethetne
      // vissza arra, mit módosított (l. repo_prepare/file_edit → PR-kérés eset).
      const windowStart = i > 0 ? visible[i - 1].createdAt : new Date(0)
      const turnToolCalls = toolCalls.filter(
        (call) => call.createdAt > windowStart && call.createdAt <= message.createdAt,
      )
      result.push({
        role: 'assistant',
        content: `${message.content}${formatToolCallSynopsisBlock(turnToolCalls)}`,
      })
    }
  }
  return result
}

/**
 * Egy kész szöveget streamelhető darabokra bont (a szóközöket a darabhoz
 * tartva), hogy szimulált token-by-token megjelenítést adjon a tool-os ágon,
 * ahol a modellhívás nem streamelhető élőben.
 */
function chunkForStreaming(text: string): string[] {
  if (!text) return []
  return text.match(/\S+\s*/g) ?? [text]
}

function isImageDocument(doc: { filename: string; extractedText: string | null }): boolean {
  if (IMAGE_EXT.test(doc.filename)) return true
  return Boolean(doc.extractedText?.startsWith('[image:'))
}

export function formatAttachmentBlock(
  docs: Array<{
    id: string
    filename: string
    extractedText: string | null
    metadata?: unknown
  }>,
): string {
  if (docs.length === 0) return ''
  const parts = docs.map((doc) => {
    if (isImageDocument(doc)) {
      return `[Csatolmány (kép): ${doc.filename}, documentId=${doc.id}]`
    }
    const text = doc.extractedText?.trim() ?? ''
    const pageCount = attachmentPageCount(doc.metadata, doc.extractedText)
    const preview = text.slice(0, 600)
    const pageLabel = pageCount > 0 ? `, ~${pageCount} oldal/blokk` : ''
    const guidance =
      `A teljes tartalom NEM a promptban van. Olvasd a document_read eszközzel:\n` +
      `  document_read({ documentId: "${doc.id}", pages: "1-2" })\n` +
      `  document_read({ documentId: "${doc.id}", query: "kulcsszó" })\n` +
      `Ne próbáld a teljes fájlt file_read-del végigolvasni.`
    if (preview) {
      return (
        `[Csatolmány: ${doc.filename}, documentId=${doc.id}${pageLabel}]\n` +
        `${guidance}\n` +
        `Előnézet (első ~600 kar):\n${preview}`
      )
    }
    return `[Csatolmány: ${doc.filename}, documentId=${doc.id}${pageLabel}]\n${guidance}`
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
  role: 'user' | 'agent' | 'system' | 'tool'
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

/**
 * A chat a legérzékenyebb agent-felület: prompt-kontextus, memória és workspace is
 * az agent tenantján fut. Idegen tenant agentje opak 'Agent not found'-ot kap, hogy
 * az azonosító ismerete se legyen felderítési csatorna.
 */
function assertAgentReachableForChat(
  agentTenantId: string | null,
  actorTenantId: string | null,
): void {
  if (!isAgentReachableFromTenant(agentTenantId, actorTenantId)) {
    throw new Error('Agent not found')
  }
}

type ChatProcessReply = {
  text: string
  ticketRefId?: string | null
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
    private workspaceStorage: WorkspaceStorage,
    private audit: AuditRepository,
    private processDefinitions?: ProcessDefinitionRepository,
    private playbooksV2?: PlaybookV2Repository,
    private processService?: ProcessService,
    private skills?: SkillService,
    private memoryRetrieval?: MemoryRetrievalService,
    /**
     * Chat "thinking-trace" spec §D7/WP-6 — tenant-szintű kapcsoló (fail-closed,
     * alapból kikapcsolva). Ha nincs injektálva vagy false-t ad, reasoning-esemény
     * sem generálódik (E4 — nem csak UI-szűrés, a bridge/loop szintjén sem).
     */
    private isThinkingTraceEnabled?: (tenantId: string | null) => Promise<boolean>,
  ) {}

  /**
   * Level-0 skill-index + `load_skill` végrehajtó összeállítása egy futáshoz
   * (skill-catalog-spec.md WP-5). Ha nincs SkillService bekötve vagy nincs
   * hozzárendelt skill, üres promptot és undefined callbacket ad — ilyenkor a
   * load_skill tool sem jelenik meg.
   */
  private async buildSkillBinding(
    agentId: string,
    tenantId: string | null,
  ): Promise<{ skillIndexPrompt: string; loadSkill?: LoadSkillFn }> {
    if (!this.skills) return { skillIndexPrompt: '' }
    const skills = this.skills
    const skillIndexPrompt = await skills.buildSkillIndexPrompt(agentId)
    if (!skillIndexPrompt) return { skillIndexPrompt: '' }
    const loadSkill: LoadSkillFn = (skillVersionId) =>
      skills.loadSkillForAgent({
        agentId,
        skillVersionId,
        actor: { actorId: null, actorTenantId: tenantId, isPlatformAdmin: false },
      })
    return { skillIndexPrompt, loadSkill }
  }

  private async resolveSlashSkillsForMessage(
    agentId: string,
    tenantId: string | null,
    messageText: string,
  ): Promise<{
    modelFacingText: string
    preloadedSkillPrompts: string[]
    loadedSkillNames: string[]
  }> {
    if (!this.skills) {
      return { modelFacingText: messageText, preloadedSkillPrompts: [], loadedSkillNames: [] }
    }
    const resolved = await this.skills.resolveSlashSkillLoads({
      agentId,
      messageText,
      actor: { actorId: null, actorTenantId: tenantId, isPlatformAdmin: false },
    })
    return {
      modelFacingText: resolved.modelFacingText,
      preloadedSkillPrompts: resolved.preloadedPrompts,
      loadedSkillNames: resolved.loadedSkillNames,
    }
  }

  async sendMessage(params: {
    agentId: string
    content: string
    createdById: string
    tenantId?: string | null
    conversationId?: string
    attachmentDocumentIds?: string[]
    processDefinitionId?: string
    processInputPayload?: Record<string, unknown>
  }) {
    const text = params.content.trim()
    const attachmentIds = params.attachmentDocumentIds ?? []
    if (!text && attachmentIds.length === 0) throw new Error('Message is required')

    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')
    assertAgentReachableForChat(agentDetails.agent.tenantId, params.tenantId ?? null)

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

    // A fájlokat a beszélgetés munkaterületére tükrözzük, hogy az agent
    // fájl-eszközei a pontos néven, teljes tartalommal elérjék őket (a prompt
    // szöveges/KB blokk csonkolt és nem géppel olvasható). Sorrend számít: a
    // chat-csatolmányok elsőbbséget élveznek az azonos nevű tudásbázis-fájllal
    // szemben, és a korábbi körök / agent által írt fájlokat nem írjuk felül.
    const tenantKey = params.tenantId ?? 'global'
    const presentFiles = new Set(await this.listWorkspaceFiles(tenantKey, conversationId))
    await this.materializeDocumentsToWorkspace(tenantKey, conversationId, attachmentDocs, presentFiles)
    const knowledgeDocs = await this.loadAgentKnowledgeDocuments(params.agentId)
    await this.materializeDocumentsToWorkspace(tenantKey, conversationId, knowledgeDocs, presentFiles)
    const workspaceFiles = await this.listWorkspaceFiles(tenantKey, conversationId)

    await this.conversations.appendMessage({
      conversationId,
      role: 'user',
      content: encodeStoredMessage(userFacingText, attachmentIds),
      actingUserId: params.createdById,
      actorType: 'human',
      actorId: params.createdById,
    })

    const processReply = await this.tryStartChatTriggeredProcess({
      tenantId: params.tenantId ?? null,
      processDefinitionId: params.processDefinitionId,
      message: text,
      explicitPayload: params.processInputPayload,
      conversationId,
      startedByUserId: params.createdById,
      agentId: params.agentId,
      agentVersion: agentDetails.agent.currentVersion,
      modelConfig: agentDetails.agent.modelConfig as {
        provider: string
        model: string
        temperature?: number
        maxTokens?: number
      },
    })
    if (processReply) {
      const agentMessage = await this.conversations.appendMessage({
        conversationId,
        role: 'agent',
        content: processReply.text,
        actingUserId: params.createdById,
        agentVersion: agentDetails.agent.currentVersion,
        actorType: 'agent',
        actorId: params.agentId,
        ticketRefId: processReply.ticketRefId ?? null,
      })
      return {
        conversationId,
        messageId: agentMessage.id,
        reply: processReply.text,
      }
    }

    const slashResolved = await this.resolveSlashSkillsForMessage(
      params.agentId,
      params.tenantId ?? null,
      text,
    )
    const latestUserTextOverride =
      slashResolved.modelFacingText !== text ? slashResolved.modelFacingText : undefined
    const kbSearch = await this.fetchKbSearchContext({
      agentId: params.agentId,
      agentVersion: agentDetails.agent.currentVersion,
      conversationId,
      actingUserId: params.createdById,
      query: slashResolved.modelFacingText || text,
    })
    const history = await this.conversations.getConversation(conversationId, params.tenantId ?? null)
    const modelConfig = agentDetails.agent.modelConfig as {
      provider: string
      model: string
      temperature?: number
      maxTokens?: number
    }
    const memoryContext = await this.retrieveProjectMemoryContext({
      agentDetails,
      projectKey: history.conversation.projectKey,
      query: buildMemoryRetrievalQuery({
        queryKind: 'chat',
        latestUserMessage: slashResolved.modelFacingText || text,
        recentMessages: history.messages,
      }),
      tenantId: params.tenantId ?? null,
      conversationId,
    })
    const assembledContext = await assembleContext({
      audit: this.audit,
      conversationId,
      agentId: params.agentId,
      agentVersion: agentDetails.agent.currentVersion,
      actingUserId: params.createdById,
      messages: history.messages,
      memoryVersion: agentDetails.memoryVersion,
      memoryContextTokens: memoryContext.tokens,
      documentAliases: this.contextDocumentAliases(attachmentDocs, workspaceFiles, kbSearch.hits),
    })
    const priorToolCalls = await this.toolCaps.listToolCallsForConversation(conversationId)
    const gatewayPrompt = await this.buildGatewayMessages(
      agentDetails,
      assembledContext.messages,
      attachmentBlock,
      kbSearch,
      workspaceFiles,
      priorToolCalls,
      latestUserTextOverride,
      memoryContext.block,
    )

    const allowedChatTools = await listAllowedChatTools(this.toolCaps, params.agentId)
    const maxTurns = resolveToolLoopMaxTurns(modelConfig, allowedChatTools)
    const skillBinding = await this.buildSkillBinding(params.agentId, params.tenantId ?? null)
    // Futásidejű skill-snapshot perzisztálás a reprodukálhatósághoz (WP-5/D9/D12):
    // a conversationhoz kötve rögzítjük, mely skill-verziók voltak élők a futáskor.
    if (this.skills && skillBinding.loadSkill) {
      await this.skills.recordRunSkillSnapshot({
        agentId: params.agentId,
        context: { conversationId },
        actorTenantId: params.tenantId ?? null,
      })
    }
    let reply: string
    // A tool-loop akkor is fut, ha nincs capability-tool, de van hozzárendelt skill
    // (a load_skill elérhetőségéhez), különben az index behúzhatatlan lenne (WP-5).
    if (
      allowedChatTools.length > 0 ||
      skillBinding.loadSkill ||
      slashResolved.preloadedSkillPrompts.length > 0
    ) {
      reply = (
        await runAgentToolLoop({
          gateway: this.gateway,
          toolBroker: this.toolBroker,
          toolCaps: this.toolCaps,
          agentId: params.agentId,
          agentVersion: agentDetails.agent.currentVersion,
          context: { conversationId },
          mode: 'chat',
          actingUserId: params.createdById,
          promptSegments: gatewayPrompt,
          modelConfig,
          allowedTools: allowedChatTools,
          maxTurns,
          skillIndexPrompt: skillBinding.skillIndexPrompt,
          preloadedSkillPrompts: slashResolved.preloadedSkillPrompts,
          loadSkill: skillBinding.loadSkill,
          archiveLargeToolResult: (input) =>
            this.archiveLargeToolResult(tenantKey, conversationId, input),
        })
      ).content
    } else {
      const gatewayInput = {
        agentId: params.agentId,
        agentVersion: agentDetails.agent.currentVersion,
        conversationId,
        actingUserId: params.createdById,
        messages: assembleGatewayMessages(gatewayPrompt),
        modelConfig,
      }
      reply = (await this.gateway.call(gatewayInput)).content
    }

    const agentMessage = await this.conversations.appendMessage({
      conversationId,
      role: 'agent',
      content: reply.trim(),
      actingUserId: params.createdById,
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

  private async findAgentReplyAfterTurn(turn: StreamTurnContext): Promise<string | null> {
    const { messages } = await this.conversations.getConversation(turn.conversationId)
    const existing = messages.find(
      (message) => message.role === 'agent' && message.createdAt > turn.userMessageCreatedAt,
    )
    return existing?.id ?? null
  }

  private async persistCancelledTurn(turn: StreamTurnContext): Promise<string | null> {
    if (await this.findAgentReplyAfterTurn(turn)) return null

    const toolCalls = await this.toolCaps.listToolCallsForConversation(turn.conversationId)
    const turnToolCalls = toolCalls.filter(
      (call) => call.createdAt > turn.userMessageCreatedAt,
    )
    const content = buildCancelledTurnMessage({
      completedReply: turn.completedReply,
      activities: turn.activities,
      turnToolCalls,
    })

    const agentMessage = await this.conversations.appendMessage({
      conversationId: turn.conversationId,
      role: 'agent',
      content,
      actingUserId: turn.createdById,
      agentVersion: turn.agentVersion,
      model: turn.model,
      actorType: 'agent',
      actorId: turn.agentId,
    })
    return agentMessage.id
  }

  private async finalizeAgentTurn(
    turn: StreamTurnContext,
    content: string,
    extras?: { ticketRefId?: string | null },
  ): Promise<string | null> {
    const existingId = await this.findAgentReplyAfterTurn(turn)
    if (existingId) return existingId

    const agentMessage = await this.conversations.appendMessage({
      conversationId: turn.conversationId,
      role: 'agent',
      content: content.trim(),
      actingUserId: turn.createdById,
      agentVersion: turn.agentVersion,
      model: turn.model,
      actorType: 'agent',
      actorId: turn.agentId,
      ticketRefId: extras?.ticketRefId ?? null,
    })
    return agentMessage.id
  }

  private async cancelTurnIfRequested(
    turn: StreamTurnContext,
    conversationId: string,
  ): Promise<string | null> {
    if (turn.finalized || !isChatTurnCancelRequested(conversationId)) return null
    const messageId = await this.persistCancelledTurn(turn)
    if (messageId) turn.finalized = true
    return messageId
  }

  async *sendMessageStream(
    params: {
      agentId: string
      content: string
      createdById: string
      tenantId?: string | null
      conversationId?: string
      attachmentDocumentIds?: string[]
      processDefinitionId?: string
      processInputPayload?: Record<string, unknown>
    },
  ): AsyncGenerator<
    | { type: 'meta'; conversationId: string; userMessageId: string }
    | { type: 'activity'; activity: ToolLoopActivityEvent }
    | { type: 'memory_candidate'; candidate: ToolLoopMemoryCandidateEvent }
    | { type: 'thinking'; turnId: string; delta: string }
    | { type: 'token'; chunk: string }
    | { type: 'done'; conversationId: string; messageId: string; ticketRefId?: string | null }
    | { type: 'cancelled'; conversationId: string; messageId: string }
    | { type: 'error'; message: string },
    void,
    unknown
  > {
    let turn: StreamTurnContext | null = null
    let activeConversationId: string | null = null

    try {
      const text = params.content.trim()
      const attachmentIds = params.attachmentDocumentIds ?? []
      if (!text && attachmentIds.length === 0) {
        yield { type: 'error', message: 'Message is required' }
        return
      }

      const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
      if (!agentDetails) {
        yield { type: 'error', message: 'Agent not found' }
        return
      }
      if (!isAgentReachableFromTenant(agentDetails.agent.tenantId, params.tenantId ?? null)) {
        yield { type: 'error', message: 'Agent not found' }
        return
      }

      const modelConfig = agentDetails.agent.modelConfig as {
        provider: string
        model: string
        temperature?: number
        maxTokens?: number
      }

      let conversationId = params.conversationId
      if (conversationId) {
        const existing = await this.conversations.getConversation(conversationId, params.tenantId ?? null)
        if (existing.conversation.agentId !== params.agentId) {
          yield { type: 'error', message: 'Conversation agent mismatch' }
          return
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

      const tenantKey = params.tenantId ?? 'global'
      const presentFiles = new Set(await this.listWorkspaceFiles(tenantKey, conversationId))
      await this.materializeDocumentsToWorkspace(tenantKey, conversationId, attachmentDocs, presentFiles)
      const knowledgeDocs = await this.loadAgentKnowledgeDocuments(params.agentId)
      await this.materializeDocumentsToWorkspace(tenantKey, conversationId, knowledgeDocs, presentFiles)
      const workspaceFiles = await this.listWorkspaceFiles(tenantKey, conversationId)

      let persistedUserMessage: Message | null = null
      let userMessage: Message
      try {
        userMessage = await this.conversations.appendMessage({
          conversationId,
          role: 'user',
          content: encodeStoredMessage(userFacingText, attachmentIds),
          actingUserId: params.createdById,
          actorType: 'human',
          actorId: params.createdById,
          onPersisted: (message) => {
            persistedUserMessage = message
          },
        })
      } catch (error) {
        // Az üzenet commitja után az audit/ref frissítés még hibázhat. Ilyenkor az
        // ACK-nak meg kell előznie a hibát, különben a kliens egy DB-ben lévő sort törölne.
        if (persistedUserMessage) {
          yield {
            type: 'meta',
            conversationId,
            userMessageId: (persistedUserMessage as Message).id,
          }
        }
        throw error
      }

      turn = {
        conversationId,
        userMessageCreatedAt: userMessage.createdAt,
        agentId: params.agentId,
        agentVersion: agentDetails.agent.currentVersion,
        createdById: params.createdById,
        model: modelConfig.model,
        activities: [],
        completedReply: null,
        finalized: false,
      }
      activeConversationId = conversationId
      registerActiveChatTurn(conversationId)

      // Persist-ACK: a kliens csak ettől a ponttól tarthatja meg hiba esetén az
      // optimista user-buborékot. Az id-val rögtön a perzisztált rekordra vált.
      yield { type: 'meta', conversationId, userMessageId: userMessage.id }

      const processReply = await this.tryStartChatTriggeredProcess({
        tenantId: params.tenantId ?? null,
        processDefinitionId: params.processDefinitionId,
        message: text,
        explicitPayload: params.processInputPayload,
        conversationId,
        startedByUserId: params.createdById,
        agentId: params.agentId,
        agentVersion: agentDetails.agent.currentVersion,
        modelConfig,
      })
      if (processReply) {
        turn.completedReply = processReply.text
        for (const chunk of chunkForStreaming(processReply.text)) {
          const cancelledId = await this.cancelTurnIfRequested(turn, conversationId)
          if (cancelledId) {
            yield { type: 'cancelled', conversationId, messageId: cancelledId }
            return
          }
          yield { type: 'token', chunk }
          await new Promise<void>((r) => setTimeout(r, 12))
        }
        const messageId = await this.finalizeAgentTurn(turn, processReply.text, {
          ticketRefId: processReply.ticketRefId ?? null,
        })
        if (!messageId) return
        turn.finalized = true
        yield {
          type: 'done',
          conversationId,
          messageId,
          ticketRefId: processReply.ticketRefId ?? null,
        }
        return
      }

      const slashResolved = await this.resolveSlashSkillsForMessage(
        params.agentId,
        params.tenantId ?? null,
        text,
      )
      const latestUserTextOverride =
        slashResolved.modelFacingText !== text ? slashResolved.modelFacingText : undefined
      const kbSearch = await this.fetchKbSearchContext({
        agentId: params.agentId,
        agentVersion: agentDetails.agent.currentVersion,
        conversationId,
        actingUserId: params.createdById,
        query: slashResolved.modelFacingText || text,
      })
      const history = await this.conversations.getConversation(conversationId, params.tenantId ?? null)
      const memoryContext = await this.retrieveProjectMemoryContext({
        agentDetails,
        projectKey: history.conversation.projectKey,
        query: buildMemoryRetrievalQuery({
          queryKind: 'chat',
          latestUserMessage: slashResolved.modelFacingText || text,
          recentMessages: history.messages,
        }),
        tenantId: params.tenantId ?? null,
        conversationId,
      })
      const assembledContext = await assembleContext({
        audit: this.audit,
        conversationId,
        agentId: params.agentId,
        agentVersion: agentDetails.agent.currentVersion,
        actingUserId: params.createdById,
        messages: history.messages,
        memoryVersion: agentDetails.memoryVersion,
        memoryContextTokens: memoryContext.tokens,
        documentAliases: this.contextDocumentAliases(attachmentDocs, workspaceFiles, kbSearch.hits),
      })
      const priorToolCalls = await this.toolCaps.listToolCallsForConversation(conversationId)
      const gatewayPrompt = await this.buildGatewayMessages(
        agentDetails,
        assembledContext.messages,
        attachmentBlock,
        kbSearch,
        workspaceFiles,
        priorToolCalls,
        latestUserTextOverride,
        memoryContext.block,
      )

      const allowedChatTools = await listAllowedChatTools(this.toolCaps, params.agentId)
      const maxTurns = resolveToolLoopMaxTurns(modelConfig, allowedChatTools)
      const skillBinding = await this.buildSkillBinding(params.agentId, params.tenantId ?? null)
      if (this.skills && skillBinding.loadSkill) {
        await this.skills.recordRunSkillSnapshot({
          agentId: params.agentId,
          context: { conversationId },
          actorTenantId: params.tenantId ?? null,
        })
      }

      for (const skillName of slashResolved.loadedSkillNames) {
        const activity: ToolLoopActivityEvent = {
          id: `skill-slash-${skillName}`,
          kind: 'tool',
          title: `Skill betöltve: ${skillName}`,
          detail: 'Felhasználói /slash parancs alapján',
          status: 'done',
        }
        turn.activities = upsertToolLoopActivity(turn.activities, activity)
        yield { type: 'activity', activity }
      }

      let reply: string
      if (
        allowedChatTools.length > 0 ||
        skillBinding.loadSkill ||
        slashResolved.preloadedSkillPrompts.length > 0
      ) {
        const thinkingEnabled = this.isThinkingTraceEnabled
          ? await this.isThinkingTraceEnabled(params.tenantId ?? null)
          : false
        type SideEvent =
          | { kind: 'activity'; activity: ToolLoopActivityEvent }
          | { kind: 'memory_candidate'; candidate: ToolLoopMemoryCandidateEvent }
          | { kind: 'thinking'; turnId: string; delta: string }
        const sideEventQueue: SideEvent[] = []
        let wakeSideEvent: (() => void) | null = null
        const pushSideEvent = (event: SideEvent) => {
          sideEventQueue.push(event)
          wakeSideEvent?.()
          wakeSideEvent = null
        }
        const waitForSideEvent = () =>
          new Promise<null>((resolve) => {
            wakeSideEvent = () => resolve(null)
          })
        const drainSideEvents = function* (activeTurn: StreamTurnContext) {
          while (sideEventQueue.length > 0) {
            const event = sideEventQueue.shift()
            if (!event) continue
            if (event.kind === 'activity') {
              activeTurn.activities = upsertToolLoopActivity(activeTurn.activities, event.activity)
              yield { type: 'activity' as const, activity: event.activity }
            } else if (event.kind === 'thinking') {
              yield { type: 'thinking' as const, turnId: event.turnId, delta: event.delta }
            } else {
              yield { type: 'memory_candidate' as const, candidate: event.candidate }
            }
          }
        }

        const resultPromise = runAgentToolLoop({
          gateway: this.gateway,
          toolBroker: this.toolBroker,
          toolCaps: this.toolCaps,
          agentId: params.agentId,
          agentVersion: agentDetails.agent.currentVersion,
          context: { conversationId },
          mode: 'chat',
          actingUserId: params.createdById,
          promptSegments: gatewayPrompt,
          modelConfig,
          allowedTools: allowedChatTools,
          maxTurns,
          skillIndexPrompt: skillBinding.skillIndexPrompt,
          preloadedSkillPrompts: slashResolved.preloadedSkillPrompts,
          loadSkill: skillBinding.loadSkill,
          archiveLargeToolResult: (input) =>
            this.archiveLargeToolResult(tenantKey, conversationId, input),
          shouldCancel: () => isChatTurnCancelRequested(conversationId),
          onActivity: (activity) => {
            turn!.activities = upsertToolLoopActivity(turn!.activities, activity)
            pushSideEvent({ kind: 'activity', activity })
          },
          ...(thinkingEnabled
            ? {
                onReasoning: (turnId: string, delta: string) =>
                  pushSideEvent({ kind: 'thinking', turnId, delta }),
              }
            : {}),
          onMemoryCandidate: (candidate) => pushSideEvent({ kind: 'memory_candidate', candidate }),
        }).then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        )

        let result: Awaited<typeof resultPromise> | null = null
        while (!result) {
          const cancelledId = await this.cancelTurnIfRequested(turn, conversationId)
          if (cancelledId) {
            yield { type: 'cancelled', conversationId, messageId: cancelledId }
            return
          }
          yield* drainSideEvents(turn)
          result = await Promise.race([resultPromise, waitForSideEvent()])
        }
        yield* drainSideEvents(turn)

        if (!result.ok) {
          if (result.error instanceof AgentToolLoopCancelledError) {
            const cancelledId = await this.cancelTurnIfRequested(turn, conversationId)
            if (cancelledId) {
              yield { type: 'cancelled', conversationId, messageId: cancelledId }
            }
            return
          }
          yield {
            type: 'error',
            message: result.error instanceof Error ? result.error.message : 'Tool loop failed',
          }
          return
        }
        reply = result.result.content
        turn.completedReply = reply
        for (const chunk of chunkForStreaming(reply)) {
          const cancelledId = await this.cancelTurnIfRequested(turn, conversationId)
          if (cancelledId) {
            yield { type: 'cancelled', conversationId, messageId: cancelledId }
            return
          }
          yield { type: 'token', chunk }
          await new Promise<void>((r) => setTimeout(r, 12))
        }
      } else {
        try {
          // Chat "thinking-trace" (tool nélküli ág): a reasoning-summary deltákat
          // közös stateful tartalom-őr (D5) mögött gyűjtjük, és a következő token-yield
          // előtt ürítjük ki `thinking` eseményként (a generátorból callbackből nem
          // lehet yield-elni). turnId egyetlen körre `reasoning-0`.
          const thinkingEnabled = this.isThinkingTraceEnabled
            ? await this.isThinkingTraceEnabled(params.tenantId ?? null)
            : false
          const pendingThinking: string[] = []
          const reasoningRedactor = new StreamingSensitiveTextRedactor((text) =>
            pendingThinking.push(text),
          )
          const onReasoningDelta = thinkingEnabled
            ? (delta: string) => reasoningRedactor.push(delta)
            : undefined
          const gatewayInput = {
            agentId: params.agentId,
            agentVersion: agentDetails.agent.currentVersion,
            conversationId,
            actingUserId: params.createdById,
            messages: assembleGatewayMessages(gatewayPrompt),
            modelConfig,
            ...(onReasoningDelta ? { onReasoningDelta } : {}),
          }
          let accumulated = ''
          for await (const chunk of this.gateway.callStream(gatewayInput)) {
            const cancelledId = await this.cancelTurnIfRequested(turn, conversationId)
            if (cancelledId) {
              yield { type: 'cancelled', conversationId, messageId: cancelledId }
              return
            }
            while (pendingThinking.length > 0) {
              yield { type: 'thinking', turnId: 'reasoning-0', delta: pendingThinking.shift()! }
            }
            accumulated += chunk
            yield { type: 'token', chunk }
          }
          reasoningRedactor.finish()
          while (pendingThinking.length > 0) {
            yield { type: 'thinking', turnId: 'reasoning-0', delta: pendingThinking.shift()! }
          }
          reply = accumulated
          turn.completedReply = reply
        } catch (err) {
          yield { type: 'error', message: err instanceof Error ? err.message : 'Model call failed' }
          return
        }
      }

      const messageId = await this.finalizeAgentTurn(turn, reply)
      if (!messageId) return
      turn.finalized = true
      yield { type: 'done', conversationId, messageId }
    } finally {
      if (activeConversationId) {
        unregisterActiveChatTurn(activeConversationId)
      }
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
    assertAgentReachableForChat(agentDetails.agent.tenantId, params.tenantId ?? null)

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
      tenantId: params.tenantId ?? null,
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

  private async tryStartChatTriggeredProcess(params: {
    tenantId: string | null
    processDefinitionId?: string
    message: string
    explicitPayload?: Record<string, unknown>
    conversationId: string
    startedByUserId: string
    agentId: string
    agentVersion: number
    modelConfig: { provider: string; model: string; temperature?: number; maxTokens?: number }
  }): Promise<ChatProcessReply | null> {
    if (!params.processDefinitionId) return null
    if (!this.processDefinitions || !this.playbooksV2 || !this.processService) {
      return { text: 'A chat-trigger indítás nincs bekötve ezen a környezeten.' }
    }

    // Folyamat/playbook scope: tenantOf(user) = user.tenantId ?? user.id (process actions).
    // A beszélgetés tenantId-ja ettől függetlenül maradhat null — ne keverjük össze.
    const processTenantId = params.tenantId ?? params.startedByUserId

    const def = await this.processDefinitions.findById(processTenantId, params.processDefinitionId)
    if (!def) return { text: 'A kiválasztott Folyamat nem található vagy nincs jogosultság.' }

    const chatTrigger = def.triggers.find((trigger) => trigger.type === 'chat' && trigger.enabled)
    if (!chatTrigger) {
      return { text: 'Ehhez a Folyamathoz nincs aktív chat trigger csatolva.' }
    }

    const version = await this.playbooksV2.findVersion(processTenantId, def.playbookVersionId)
    const compiled = version?.compiledSpec as CompiledSpec | null | undefined
    if (!compiled || typeof compiled !== 'object') {
      return { text: 'A Folyamat PIN-elt Playbook-verziójának nincs futtatható compiled spec-je.' }
    }

    let inputPayload = resolveChatTriggerInputPayload(
      chatTrigger.inputMap,
      params.message,
      params.explicitPayload,
    )
    let missing = missingRequiredTriggerSlots(compiled, inputPayload, compiled.entryStepId)

    // §4.4 „az LLM megkapja a kitöltendő mezőket, kinyeri őket az üzenetből":
    // a determinisztikus (JSON / kulcs:érték) feloldás fölé épülő LLM-fallback,
    // ha szabad szöveges üzenetből kellene még hiányzó réseket kinyerni.
    if (missing.length > 0) {
      const extracted = await this.extractChatTriggerSlotsWithLlm({
        message: params.message,
        compiled,
        missing,
        agentId: params.agentId,
        agentVersion: params.agentVersion,
        conversationId: params.conversationId,
        startedByUserId: params.startedByUserId,
        modelConfig: params.modelConfig,
      })
      if (extracted) {
        inputPayload = { ...inputPayload, ...extracted }
        missing = missingRequiredTriggerSlots(compiled, inputPayload, compiled.entryStepId)
      }
    }

    if (missing.length > 0) {
      return {
        text: `A Folyamat indításához még hiányzik: ${missing.join(', ')}. Add meg ezeket név: érték formában, vagy a chat indító payloadban.`,
      }
    }

    const run = await this.processService.startProcess({
      tenantId: processTenantId,
      processDefinitionId: def.id,
      triggerType: 'chat',
      inputPayload,
      conversationId: params.conversationId,
      startedBy: { type: 'user', id: params.startedByUserId },
    })

    const processLink = `/control-plane/processes/${run.id}`
    return {
      text: `Futás elindítva a(z) [${def.name}](${processLink}) Folyamatból. Futás azonosító: ${run.id}. Állapot: ${run.status}.`,
      ticketRefId: run.rootTicketId,
    }
  }

  /**
   * §4.4 LLM slot-filling fallback: csak a hiányzó, kötelező résekre kérdez rá
   * egy szűk, szigorúan-JSON kimenetet kérő promptban. Best-effort — hiba vagy
   * érvénytelen JSON esetén `null`-t ad vissza, és a hívó a szokásos hiányzó-rés
   * üzenettel kér vissza a felhasználótól.
   */
  private async extractChatTriggerSlotsWithLlm(params: {
    message: string
    compiled: CompiledSpec
    missing: string[]
    agentId: string
    agentVersion: number
    conversationId: string
    startedByUserId: string
    modelConfig: { provider: string; model: string; temperature?: number; maxTokens?: number }
  }): Promise<Record<string, unknown> | null> {
    const descriptors = chatTriggerSlotDescriptors(params.compiled).filter((slot) =>
      params.missing.includes(slot.name),
    )
    if (descriptors.length === 0) return null

    const slotList = descriptors
      .map((slot) => `- ${slot.name} (${slot.type}${slot.required ? ', kötelező' : ''})${slot.description ? `: ${slot.description}` : ''}`)
      .join('\n')

    const system =
      'Egy folyamatindító mezőkitöltő vagy. A felhasználó üzenetéből told ki a felsorolt mezőket. ' +
      'KIZÁRÓLAG egy JSON objektumot adj vissza (semmi mást, se magyarázatot, se kódblokkot), ' +
      'aminek a kulcsai a felsorolt mezőnevek. Ha egy mezőt nem tudsz kinyerni az üzenetből, hagyd ki a kulcsot.'
    const user = `Mezők:\n${slotList}\n\nFelhasználói üzenet:\n${params.message}`

    try {
      const result = await this.gateway.call({
        agentId: params.agentId,
        agentVersion: params.agentVersion,
        conversationId: params.conversationId,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        modelConfig: params.modelConfig,
      })
      const jsonMatch = result.content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null
      const parsed: unknown = JSON.parse(jsonMatch[0])
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      return parsed as Record<string, unknown>
    } catch {
      return null
    }
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

  /**
   * Dokumentumokat (chat-csatolmány vagy az agent tudásbázisa) a beszélgetés
   * munkaterületére ír, hogy az agent fájl-eszközei (file_read, xlsx_read_sheet,
   * ...) elérjék őket. A `documents.extractedText` tárolja a tartalmat: kép →
   * base64 dekódolva az eredeti bájtok; bináris office/pdf → a kinyert szöveg
   * `<név>.txt`-ként (az eredeti bináris nincs eltárolva); szöveges formátum
   * (json/csv/txt/md) → a tartalom az eredeti néven.
   *
   * A `skipExisting` halmazban szereplő (vagy oda ezalatt felvett) célútakat
   * kihagyja, így a korábbi körök fájljait és a chat-csatolmányokat nem írja
   * felül a tudásbázisból, és körönként nem másol feleslegesen újra.
   */
  private async materializeDocumentsToWorkspace(
    tenantId: string,
    conversationId: string,
    docs: Array<{ filename: string; extractedText: string | null }>,
    skipExisting: Set<string>,
  ): Promise<void> {
    const MAX_BYTES = 5 * 1024 * 1024
    for (const doc of docs) {
      const text = doc.extractedText
      if (!text) continue

      let targetPath = doc.filename
      let bytes: Buffer

      const imageMatch = text.match(IMAGE_MARKER)
      if (imageMatch?.[2] && imageMatch[3]) {
        bytes = Buffer.from(imageMatch[3], 'base64')
      } else {
        if (/\.(xlsx|xlsm|docx|pdf)$/i.test(doc.filename)) {
          // Az eltárolt szöveg a kinyert tartalom, nem az eredeti bináris —
          // .txt-ként tesszük elérhetővé, hogy az olvasás ne sérült fájlt kapjon.
          targetPath = `${doc.filename}.txt`
        }
        bytes = Buffer.from(text, 'utf8')
      }

      if (skipExisting.has(targetPath) || bytes.length > MAX_BYTES) continue

      try {
        await this.workspaceStorage.write(tenantId, conversationId, targetPath, bytes)
        skipExisting.add(targetPath)
      } catch {
        // Egy fájl kiírási hibája ne akassza meg a beszélgetést.
      }
    }
  }

  /** Az agenthez kötött tudásbázis-connectorok feldolgozott dokumentumai. */
  private async loadAgentKnowledgeDocuments(
    agentId: string,
  ): Promise<Array<{ id: string; filename: string; extractedText: string | null }>> {
    try {
      const links = await this.toolCaps.findConnectorsForAgent(agentId)
      const kbConnectorIds = links
        .filter((link) => link.connector.type === 'knowledge_base')
        .map((link) => link.connector.id)
      const lists = await Promise.all(
        kbConnectorIds.map((id) => this.toolCaps.findDocumentsForConnector(id)),
      )
      return lists.flat()
    } catch {
      return []
    }
  }

  private async listWorkspaceFiles(tenantId: string, conversationId: string): Promise<string[]> {
    try {
      return await this.workspaceStorage.list(tenantId, conversationId)
    } catch {
      return []
    }
  }

  private async archiveLargeToolResult(
    tenantId: string,
    conversationId: string,
    input: { toolName: string; callId: string; turn: number; content: string },
  ): Promise<{ path: string; bytes: number } | null> {
    const bytes = Buffer.from(input.content, 'utf8')
    const path = [
      '.tool-results',
      `${String(input.turn + 1).padStart(2, '0')}-${safeToolResultName(input.toolName)}-${safeToolResultName(input.callId)}.json`,
    ].join('/')

    try {
      await this.workspaceStorage.write(tenantId, conversationId, path, bytes)
      return { path, bytes: bytes.length }
    } catch {
      return null
    }
  }

  private contextDocumentAliases(
    attachmentDocs: Array<{ id: string; filename: string }>,
    workspaceFiles: string[],
    hits: KbHit[],
  ): string[] {
    return [
      ...attachmentDocs.map((doc) => doc.filename || doc.id),
      ...workspaceFiles,
      ...hits.map((hit) => hit.sourceRef || hit.docId),
    ]
  }

  private async fetchKbSearchContext(params: {
    agentId: string
    agentVersion: number
    conversationId: string
    actingUserId: string
    query: string
  }): Promise<{ enabled: boolean; hits: KbHit[] }> {
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

    return { enabled: true, hits: search.result.hits as KbHit[] }
  }

  /** agent-memory-persistent-cross-conversation-spec.md §10.3 — retrieval-only memória-blokk chatben. */
  private async retrieveProjectMemoryContext(params: {
    agentDetails: NonNullable<Awaited<ReturnType<AgentRepository['findByIdWithDetails']>>>
    projectKey: string
    query: string
    tenantId: string | null
    conversationId: string
  }) {
    return loadProjectMemoryContext({
      memoryRetrieval: this.memoryRetrieval,
      audit: this.audit,
      actorId: params.agentDetails.agent.id,
      agentVersion: params.agentDetails.agent.currentVersion,
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      request: buildMemoryRetrievalRequest({
        agentId: params.agentDetails.agent.id,
        memoryId: params.agentDetails.agent.memoryId,
        tenantId: params.tenantId,
        projectKey: params.projectKey,
        query: params.query,
        queryKind: 'chat',
        runRef: { threadId: params.conversationId },
      }),
    })
  }

  private async buildGatewayMessages(
    agentDetails: NonNullable<Awaited<ReturnType<AgentRepository['findByIdWithDetails']>>>,
    historyMessages: ContextAssemblyMessage[],
    latestAttachmentBlock: string,
    kbSearch: { enabled: boolean; hits: KbHit[] },
    workspaceFiles: string[],
    toolCalls: ToolCall[] = [],
    latestUserTextOverride?: string,
    memoryContextBlock?: string | null,
  ) {
    const allAgents = await this.agents.findMany()
    const orgRoster = formatOrgRoster(allAgents)

    const stablePreamble: PromptSegments['stablePreamble'] = [
      { role: 'system', content: composeSystemPrompt(agentDetails.agent) },
      { role: 'system', content: orgRoster },
      {
        role: 'system',
        content:
          'Ez egy közvetlen beszélgetés a felhasználóval. Válaszolj természetes, segítőkész hangnemben magyarul. Ha csatolmány érkezett, hivatkozz rá a válaszodban. Email, fájl, ticket vagy más agent feladat kérésénél használd a platform eszközöket — ne állítsd, hogy megcsináltad vagy nincs adat, ha nem hívtál eszközt.',
      },
    ]
    const stablePostamble: PromptSegments['stablePostamble'] = []
    const variableContext: PromptSegments['variableContext'] = []

    // agent-memory-persistent-cross-conversation-spec.md §10.3 — retrieval-only:
    // a legacy `agentDetails.memoryContent` teljes-inject blokk helyett a
    // `MemoryRetrievalService`-ből épített, elhatárolt `Project memory context`
    // blokk (§16 S4: adat, nem utasítás), a capture-policy prompt-tal együtt.
    if (memoryContextBlock) {
      const [capturePolicy, memoryData] = memoryContextSystemMessages(memoryContextBlock)
      if (capturePolicy) stablePostamble.push(capturePolicy)
      stablePostamble.push({ role: 'system', content: MEMORY_RETRIEVAL_USAGE_PROMPT })
      if (memoryData) variableContext.push(memoryData)
    }

    if (kbSearch.enabled) {
      const answerInstruction = kbSearchAnswerInstruction({
        hitCount: kbSearch.hits.length,
        hasMemoryContext: Boolean(memoryContextBlock),
        mode: 'chat',
      })
      stablePostamble.push({ role: 'system', content: answerInstruction })
      variableContext.push({
        role: 'system',
        content: `Tudásbázis találatok (kb_search):\n${formatHitsForPrompt(kbSearch.hits)}`,
      })
    }

    // A munkaterületen ténylegesen elérhető fájlok pontos listája. Ez a forrás
    // igazsága — a fájlnevekre ezekkel a pontos utakkal hivatkozz, NE találgass
    // tudásbázisból vett elérési utat.
    if (workspaceFiles.length > 0) {
      variableContext.push({
        role: 'system',
        content:
          `A beszélgetés munkaterületén jelenleg elérhető fájlok (pontos elérési utak):\n` +
          workspaceFiles.map((p) => `- ${p}`).join('\n') +
          `\n\nEzeket a file_read / xlsx_read_sheet / file_search stb. eszközökkel éred el a fenti pontos néven. ` +
          `Csatolmány PDF/DOCX tartalmához (documentId a csatolmány-blokkban) a document_read eszközt használd oldalra vagy keresésre — ne a teljes .txt-t file_read-del. ` +
          `Ha a kért adat egy itt felsorolt fájlban van, onnan dolgozz. Új fájlt (pl. Excel → xlsx_create, prezentáció → pptx_create, Word → docx_create, egyéb → file_write) az eszközökkel hozz létre — a felhasználó a chat „Workspace fájlok" panelről tölti le.`,
      })
    } else {
      variableContext.push({
        role: 'system',
        content:
          'A beszélgetés munkaterülete jelenleg üres (nincs feltöltött fájl). Ha a felhasználó létező fájlra hivatkozik, kérd meg, hogy csatolja (📎). Csatolt PDF/DOCX esetén a document_read eszközt használd (pages/query). Új fájlt (pl. Excel → xlsx_create, prezentáció → pptx_create, Word → docx_create, egyéb → file_write) az eszközökkel hozhatsz létre — a felhasználó a „Workspace fájlok" panelről tölti le.',
      })
    }

    return {
      stablePreamble,
      stablePostamble,
      variableContext,
      history: buildHistoryGatewayMessages(historyMessages, toolCalls, latestAttachmentBlock, latestUserTextOverride),
    } satisfies PromptSegments
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
