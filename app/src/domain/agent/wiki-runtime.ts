import { z } from 'zod'
import type {
  AgentRepository,
  AuditRepository,
  TicketRepository,
  ToolBrokerRepository,
} from '@/repositories/interfaces'
import { composeSystemPrompt } from '@/lib/agent-prompt'
import { buildRunAsAuthorization } from '@/lib/run-as-payload'
import { readWikiTicketPayload, wikiSearchQuery, wikiUserPrompt } from '@/lib/wiki-ticket-payload'
import { formatHitsForPrompt, type KbHit } from '@/lib/kb-format'
import { buildThreadContextPrompt, latestHumanTicketComment } from '@/lib/ticket-thread-prompt'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import type { GatewayMessage, ModelGateway } from '../gateway/model-gateway'
import type { ToolBrokerService } from '../tool-broker/tool-broker-service'
import type { PlaybookService } from '../playbook/playbook-service'
import type { ConversationService } from '../conversation/conversation-service'
import { assembleContext, type ContextAssemblyMessage } from '../conversation/context-assembly'
import { TicketService } from '../ticket/ticket-service'
import type { ReportTemplate } from '../report/report-templates'
import { listAllowedChatTools, runAgentToolLoop, type ChatPlatformToolName } from './chat-tool-loop'

// Re-export so callers don't need to import from kb-format separately.
export type { KbHit }

const wikiAnswerSchema = z.object({
  answer: z.string().trim().min(1),
  sources: z
    .array(
      z.object({
        docId: z.string().trim().min(1),
        sectionRef: z
          .string()
          .trim()
          .min(1)
          .nullable()
          .optional()
          .transform((v) => v ?? 'unknown'),
      }),
    )
    .default([]),
  rationale: z.string().trim().default(''),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
})

export type WikiAnswer = z.infer<typeof wikiAnswerSchema>

function extractJsonObject(content: string): unknown {
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Agent did not return valid wiki answer JSON')
  return JSON.parse(jsonMatch[0])
}

type AgentDetails = NonNullable<Awaited<ReturnType<AgentRepository['findByIdWithDetails']>>>

function assertAgentReachableForWiki(
  agentTenantId: string | null,
  actorTenantId: string | null,
): void {
  if (!isAgentReachableFromTenant(agentTenantId, actorTenantId)) {
    throw new Error('Agent not found')
  }
}

type ModelConfig = {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
}

type InferenceContext =
  | { conversationId: string; ticketId?: never; actingUserId?: string }
  | { ticketId: string; conversationId?: never; actingUserId?: never }

type InferenceResult = {
  answer: WikiAnswer
  hits: KbHit[]
}

export class WikiAgentRuntime {
  constructor(
    private agents: AgentRepository,
    private tickets: TicketRepository,
    private gateway: ModelGateway,
    private ticketService: TicketService,
    private toolBroker: ToolBrokerService,
    private toolCaps: ToolBrokerRepository,
    private playbooks: PlaybookService,
    private conversations: ConversationService,
    private audit: AuditRepository,
  ) {}

  /**
   * CR-MVP-003: beszélgetés-elsődleges wiki-flow — ticket nélkül, conversation/message alapon.
   */
  async askWiki(params: {
    agentId: string
    question: string
    createdById: string
    tenantId?: string | null
    conversationId?: string
  }) {
    const question = params.question.trim()
    if (!question) throw new Error('Question is required')

    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')
    assertAgentReachableForWiki(agentDetails.agent.tenantId, params.tenantId ?? null)

    let conversationId = params.conversationId
    if (conversationId) {
      const existing = await this.conversations.getConversation(conversationId, params.tenantId ?? null)
      if (existing.conversation.agentId !== params.agentId) {
        throw new Error('Conversation agent mismatch')
      }
    } else {
      const created = await this.conversations.createConversation({
        agentId: params.agentId,
        createdById: params.createdById,
        tenantId: params.tenantId ?? null,
        title: question.slice(0, 80),
      })
      conversationId = created.id
    }

    await this.conversations.appendMessage({
      conversationId,
      tenantId: params.tenantId ?? null,
      role: 'user',
      content: question,
      actingUserId: params.createdById,
      actorType: 'human',
      actorId: params.createdById,
    })

    const result = await this.processConversation({
      conversationId,
      agentId: params.agentId,
      question,
      actingUserId: params.createdById,
      tenantId: params.tenantId ?? null,
    })

    return {
      conversationId,
      messageId: result.agentMessageId,
      answer: result.answer,
      sources: result.answer.sources,
      rationale: result.answer.rationale,
      confidence: result.answer.confidence,
    }
  }

  async processConversation(params: {
    conversationId: string
    agentId: string
    question: string
    actingUserId?: string
    tenantId?: string | null
  }) {
    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')
    assertAgentReachableForWiki(agentDetails.agent.tenantId, params.tenantId ?? null)

    const modelConfig = agentDetails.agent.modelConfig as ModelConfig
    const agentVersion = agentDetails.agent.currentVersion

    const allowedTools = await listAllowedChatTools(this.toolCaps, params.agentId)
    if (allowedTools.length > 0) {
      const { content } = await this.runWikiChatToolLoop({
        agentId: params.agentId,
        agentDetails,
        modelConfig,
        agentVersion,
        question: params.question,
        conversationId: params.conversationId,
        actingUserId: params.actingUserId,
        tenantId: params.tenantId,
        allowedTools,
      })

      const agentMessage = await this.conversations.appendMessage({
        conversationId: params.conversationId,
        tenantId: params.tenantId ?? null,
        role: 'agent',
        content,
        actingUserId: params.actingUserId ?? null,
        agentVersion,
        model: modelConfig.model,
        actorType: 'agent',
        actorId: params.agentId,
      })

      return {
        conversationId: params.conversationId,
        agentMessageId: agentMessage.id,
        answer: { answer: content, sources: [], rationale: '', confidence: 'high' as const },
        hits: [] as KbHit[],
      }
    }

    const payload = this.buildPayload(params.question, agentDetails, modelConfig)

    const { answer, hits } = await this.runWikiInference({
      agentId: params.agentId,
      agentDetails,
      modelConfig,
      agentVersion,
      payload,
      context: { conversationId: params.conversationId, actingUserId: params.actingUserId },
      tenantId: params.tenantId,
    })

    const agentMessage = await this.conversations.appendMessage({
      conversationId: params.conversationId,
      tenantId: params.tenantId ?? null,
      role: 'agent',
      content: JSON.stringify({
        answer: answer.answer,
        sources: answer.sources,
        rationale: answer.rationale,
        confidence: answer.confidence,
        retrievedSources: hits,
        ...payload,
      }),
      actingUserId: params.actingUserId ?? null,
      agentVersion,
      model: modelConfig.model,
      actorType: 'agent',
      actorId: params.agentId,
    })

    return {
      conversationId: params.conversationId,
      agentMessageId: agentMessage.id,
      answer,
      hits,
    }
  }

  /** Legacy ticket-alapú flow — harness / playbook pin teszt / visszafelé kompatibilitás. */
  async askWikiViaTicket(params: {
    agentId: string
    question: string
    createdById: string
    tenantId?: string | null
  }) {
    const ticket = await this.createQuestionTicket(params)
    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')
    assertAgentReachableForWiki(agentDetails.agent.tenantId, params.tenantId ?? null)
    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'in_progress',
      actor: { type: 'system' },
      agentVersion: agentDetails.agent.currentVersion,
    })
    return this.processTicket({ ticketId: ticket.id, agentId: params.agentId })
  }

  async createQuestionTicket(params: {
    agentId: string
    question: string
    createdById: string
    tenantId?: string | null
    executeAfter?: Date | null
    authorizeRunAs?: boolean
    title?: string
    extraPayload?: Record<string, unknown>
  }) {
    const question = params.question.trim()
    if (!question) throw new Error('Question is required')

    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')
    assertAgentReachableForWiki(agentDetails.agent.tenantId, params.tenantId ?? null)

    const modelConfig = agentDetails.agent.modelConfig as ModelConfig
    const agentVersion = agentDetails.agent.currentVersion
    const recipe = agentDetails.recipe
    const playbookRef =
      (await this.playbooks.getActiveRefByName('wiki-interaction')) ?? null
    const runAsPayload = params.authorizeRunAs
      ? buildRunAsAuthorization({ userId: params.createdById })
      : {}

    const ticket = await this.tickets.create({
      tenantId: params.tenantId ?? null,
      type: 'interaction',
      title: params.title ?? `Wiki kérdés: ${question.slice(0, 80)}`,
      state: 'ready',
      assigneeType: 'agent',
      assigneeId: params.agentId,
      agentId: params.agentId,
      playbookRef,
      payload: {
        question,
        agentVersion,
        model: modelConfig.model,
        memoryVersion: agentDetails.memoryVersion,
        recipeName: recipe?.name ?? null,
        recipeVersion: recipe?.version ?? null,
        playbookRef,
        scheduledRun: params.executeAfter ? true : undefined,
        ...runAsPayload,
        ...params.extraPayload,
      },
      sourceDocumentId: null,
      executeAfter: params.executeAfter ?? null,
      dueBy: null,
      createdById: params.createdById,
    })

    if (playbookRef) {
      await this.playbooks.auditProcessStart({
        ticket,
        playbookRef,
        actorType: 'human',
        actorId: params.createdById,
      })
    }

    return ticket
  }

  /**
   * §5.10 generateReport — előre definiált sablonból riport-ticketet hoz létre.
   * A ticket `ready` állapotban indul; a dispatcher a wiki-runtime-mal dolgozza
   * fel (kb_search → Model Gateway → board_write), így a riport a tudásbázisból,
   * citáltan, a két átjárón át, auditáltan készül.
   */
  async generateReport(params: {
    agentId: string
    template: ReportTemplate
    createdById: string
    tenantId?: string | null
  }) {
    return this.createQuestionTicket({
      agentId: params.agentId,
      question: params.template.prompt,
      createdById: params.createdById,
      tenantId: params.tenantId ?? null,
      title: `Riport: ${params.template.name}`,
      extraPayload: {
        source: 'wiki',
        reportTemplateId: params.template.id,
        reportTemplateName: params.template.name,
      },
    })
  }

  async processTicket(params: { ticketId: string; agentId: string }) {
    const ticket = await this.tickets.findById(params.ticketId)
    if (!ticket) throw new Error('Ticket not found')
    if (ticket.agentId !== params.agentId) throw new Error('Ticket not assigned to this agent')
    if (ticket.type !== 'interaction') throw new Error('Wiki runtime only handles interaction tickets')

    const rawPayload =
      typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
        ? (ticket.payload as Record<string, unknown>)
        : {}
    const { question: rawQuestion } = readWikiTicketPayload(rawPayload)
    const question = rawQuestion || ticket.title
    if (!question) throw new Error('Ticket payload is missing question')

    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')

    const modelConfig = agentDetails.agent.modelConfig as ModelConfig
    const agentVersion = agentDetails.agent.currentVersion
    const payload = this.buildPayload(question, agentDetails, modelConfig)

    const { answer, hits } = await this.runWikiInference({
      agentId: params.agentId,
      agentDetails,
      modelConfig,
      agentVersion,
      payload,
      context: { ticketId: ticket.id },
    })

    const write = await this.toolBroker.invoke({
      agentId: params.agentId,
      agentVersion,
      ticketId: ticket.id,
      tool: 'board_write',
      args: {
        ticketId: ticket.id,
        patch: {
          payload: {
            answer: answer.answer,
            sources: answer.sources,
            rationale: answer.rationale,
            confidence: answer.confidence,
            retrievedSources: hits,
            agentVersion,
            model: modelConfig.model,
            memoryVersion: agentDetails.memoryVersion,
            recipeName: agentDetails.recipe?.name ?? null,
            recipeVersion: agentDetails.recipe?.version ?? null,
          },
          state: answer.confidence === 'high' ? 'done' : 'awaiting_human',
        },
      },
    })
    if (write.denied) {
      throw new Error(`board_write denied: ${write.reason}`)
    }

    await this.tickets.appendComment({
      ticketId: ticket.id,
      kind: 'agent_answer',
      authorType: 'agent',
      authorAgentId: params.agentId,
      authorDisplayName: agentDetails.agent.name,
      agentVersion,
      body: answer.answer,
      structured: {
        sources: answer.sources,
        rationale: answer.rationale,
        confidence: answer.confidence,
        model: modelConfig.model,
        memoryVersion: agentDetails.memoryVersion,
        retrievedSourceCount: hits.length,
      },
    })

    const updated = await this.tickets.findById(ticket.id)
    return {
      ticketId: ticket.id,
      answer: answer satisfies WikiAnswer,
      ticket: updated,
    }
  }

  private buildPayload(
    question: string,
    agentDetails: AgentDetails,
    modelConfig: ModelConfig,
  ): Record<string, unknown> {
    return {
      question,
      agentVersion: agentDetails.agent.currentVersion,
      model: modelConfig.model,
      memoryVersion: agentDetails.memoryVersion,
      recipeName: agentDetails.recipe?.name ?? null,
      recipeVersion: agentDetails.recipe?.version ?? null,
    }
  }

  private async runWikiChatToolLoop(params: {
    agentId: string
    agentDetails: AgentDetails
    modelConfig: ModelConfig
    agentVersion: number
    question: string
    conversationId: string
    allowedTools: ChatPlatformToolName[]
    actingUserId?: string
    tenantId?: string | null
  }): Promise<{ content: string }> {
    const search = await this.toolBroker.invoke({
      agentId: params.agentId,
      agentVersion: params.agentVersion,
      conversationId: params.conversationId,
      actingUserId: params.actingUserId,
      tool: 'kb_search',
      args: { query: params.question, k: 6 },
    })
    const hits: KbHit[] =
      !search.denied && 'hits' in search.result && Array.isArray(search.result.hits)
        ? (search.result.hits as KbHit[])
        : []

    const docHits = hits.filter((h) => h.memoryVersion === null)
    const memHits = hits.filter((h) => h.memoryVersion !== null)

    const answerInstruction =
      hits.length === 0
        ? 'A tudásbázis nem adott találatot erre a kérdésre. Fájl vagy egyéb adat kérésnél használd az elérhető platform eszközöket. Fontos: a tudásbázis dokumentumai NEM érhetők el file_read/file_glob eszközökkel — azok csak a munkaterület saját fájljait látják.'
        : memHits.length > 0
          ? 'Az alábbi tudásbázis-forrásokra támaszkodj. A fájltartalmak az előzmény-üzenetekben már szerepelnek — ne olvasd be újra őket.'
          : 'A fájltartalmak az előzmény-üzenetekben már szerepelnek — ne olvasd be újra őket.'

    const { messages: histMessages } = await this.conversations.getConversation(
      params.conversationId,
      params.tenantId,
    )
    const assembledContext = await assembleContext({
      audit: this.audit,
      conversationId: params.conversationId,
      agentId: params.agentId,
      agentVersion: params.agentVersion,
      actingUserId: params.actingUserId,
      messages: histMessages,
      memoryVersion: params.agentDetails.memoryVersion,
      memoryContent: params.agentDetails.memoryContent,
      documentAliases: this.documentAliasesFromHits(hits),
    })

    const messages: GatewayMessage[] = [
      { role: 'system', content: composeSystemPrompt(params.agentDetails.agent) },
    ]

    if (memHits.length > 0) {
      messages.push({
        role: 'system',
        content: `${answerInstruction}\n\nMemória-forrásrészletek:\n${formatHitsForPrompt(memHits)}`,
      })
    } else {
      messages.push({ role: 'system', content: answerInstruction })
    }

    // KB dokumentum-találatokat fake file_read tool call + result páronként illesztjük be.
    // Így a modell azt hiszi, már elvégezte a file_read-et — és nem próbálja újra.
    for (const hit of docHits) {
      const filename = hit.sourceRef.match(/:([^:]+)$/)?.[1] ?? hit.docId
      const fakeCallId = `call_kb${hit.docId.replace(/[^a-z0-9]/gi, '').slice(0, 20)}`
      messages.push({
        role: 'assistant',
        toolCalls: [{ id: fakeCallId, name: 'file_read', input: { path: filename } }],
      })
      messages.push({
        role: 'tool',
        toolCallId: fakeCallId,
        toolName: 'file_read',
        content: hit.snippet,
      })
    }

    for (const msg of assembledContext.messages) {
      if (msg.role === 'user') {
        messages.push({ role: 'user', content: msg.content! })
      } else if (msg.role === 'agent') {
        try {
          const parsed = JSON.parse(msg.content!) as { answer?: string }
          messages.push({
            role: 'user',
            content: `[Korábbi agent válasz]\n${parsed.answer ?? msg.content!}`,
          })
        } catch {
          messages.push({ role: 'user', content: `[Korábbi agent válasz]\n${msg.content!}` })
        }
      }
    }

    return runAgentToolLoop({
      gateway: this.gateway,
      toolBroker: this.toolBroker,
      toolCaps: this.toolCaps,
      agentId: params.agentId,
      agentVersion: params.agentVersion,
      context: { conversationId: params.conversationId },
      mode: 'chat',
      actingUserId: params.actingUserId,
      messages,
      modelConfig: params.modelConfig,
      allowedTools: params.allowedTools,
    })
  }

  private async runWikiInference(params: {
    agentId: string
    agentDetails: AgentDetails
    modelConfig: ModelConfig
    agentVersion: number
    payload: Record<string, unknown>
    context: InferenceContext
    tenantId?: string | null
  }): Promise<InferenceResult> {
    const threadComments = params.context.ticketId
      ? await this.tickets.listComments(params.context.ticketId)
      : []
    const searchQuery = [wikiSearchQuery(params.payload), latestHumanTicketComment(threadComments)]
      .filter((part): part is string => Boolean(part?.trim()))
      .join(' ')
    const search = await this.toolBroker.invoke({
      agentId: params.agentId,
      agentVersion: params.agentVersion,
      ...params.context,
      tool: 'kb_search',
      args: { query: searchQuery || wikiSearchQuery(params.payload), k: 6 },
    })
    if (search.denied) {
      throw new Error(`kb_search denied: ${search.reason}`)
    }

    const hits: KbHit[] =
      !search.denied && 'hits' in search.result && Array.isArray(search.result.hits)
        ? search.result.hits
        : []

    const answerInstruction =
      hits.length === 0
        ? 'Nincs elég forrás. Ezt mondd ki, és ne találj ki tényt.'
        : 'Kizárólag a megadott forrásrészletekre támaszkodj.'

    const contextMessages =
      params.context.conversationId
        ? await this.assembleWikiInferenceMessages({
            conversationId: params.context.conversationId,
            agentId: params.agentId,
            agentVersion: params.agentVersion,
            actingUserId: params.context.actingUserId,
            tenantId: params.tenantId,
            agentDetails: params.agentDetails,
            hits,
          })
        : []

    const threadPrompt =
      threadComments.length > 0
        ? buildThreadContextPrompt({
            comments: threadComments,
            originalTask: readWikiTicketPayload(params.payload).question,
          })
        : null
    const userPayload = threadPrompt
      ? { ...params.payload, question: threadPrompt }
      : params.payload

    const { content } = await this.gateway.call({
      agentId: params.agentId,
      agentVersion: params.agentVersion,
      ...params.context,
      messages: [
        { role: 'system', content: composeSystemPrompt(params.agentDetails.agent) },
        {
          role: 'system',
          content: `${answerInstruction}\n\nForrásrészletek:\n${formatHitsForPrompt(hits)}`,
        },
        ...contextMessages,
        {
          role: 'user',
          content: wikiUserPrompt(userPayload),
        },
      ],
      modelConfig: params.modelConfig,
    })

    const parsed = wikiAnswerSchema.parse(extractJsonObject(content))
    const sources =
      parsed.sources.length > 0
        ? parsed.sources
        : hits.map((hit) => ({ docId: hit.docId, sectionRef: hit.sourceRef }))

    return { answer: { ...parsed, sources }, hits }
  }

  private async assembleWikiInferenceMessages(params: {
    conversationId: string
    agentId: string
    agentVersion: number
    actingUserId?: string
    tenantId?: string | null
    agentDetails: AgentDetails
    hits: KbHit[]
  }): Promise<GatewayMessage[]> {
    const { messages } = await this.conversations.getConversation(
      params.conversationId,
      params.tenantId,
    )
    const assembledContext = await assembleContext({
      audit: this.audit,
      conversationId: params.conversationId,
      agentId: params.agentId,
      agentVersion: params.agentVersion,
      actingUserId: params.actingUserId,
      messages,
      memoryVersion: params.agentDetails.memoryVersion,
      memoryContent: params.agentDetails.memoryContent,
      documentAliases: this.documentAliasesFromHits(params.hits),
    })

    return this.toWikiHistoryMessages(assembledContext.messages)
  }

  private toWikiHistoryMessages(messages: ContextAssemblyMessage[]): GatewayMessage[] {
    const result: GatewayMessage[] = []
    const latestUserSeq = [...messages].reverse().find((message) => message.role === 'user')?.seq
    for (const msg of messages) {
      if (msg.seq === latestUserSeq || !msg.content) continue
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content })
      } else if (msg.role === 'agent') {
        try {
          const parsed = JSON.parse(msg.content) as { answer?: string }
          result.push({
            role: 'user',
            content: `[Korábbi agent válasz]\n${parsed.answer ?? msg.content}`,
          })
        } catch {
          result.push({ role: 'user', content: `[Korábbi agent válasz]\n${msg.content}` })
        }
      }
    }
    return result
  }

  private documentAliasesFromHits(hits: KbHit[]): string[] {
    return hits.map((hit) => hit.sourceRef || hit.docId)
  }
}
