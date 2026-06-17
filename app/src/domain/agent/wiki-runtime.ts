import { z } from 'zod'
import type { AgentRepository, TicketRepository } from '@/repositories/interfaces'
import { composeSystemPrompt } from '@/lib/agent-prompt'
import { readWikiTicketPayload, wikiSearchQuery, wikiUserPrompt } from '@/lib/wiki-ticket-payload'
import type { ModelGateway } from '../gateway/model-gateway'
import type { ToolBrokerService } from '../tool-broker/tool-broker-service'
import type { PlaybookService } from '../playbook/playbook-service'
import type { ConversationService } from '../conversation/conversation-service'
import { TicketService } from '../ticket/ticket-service'

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

function formatHitsForPrompt(
  hits: Array<{ docId: string; snippet: string; sourceRef: string; memoryVersion: number | null }>,
): string {
  if (hits.length === 0) return '(nincs találat)'
  return hits
    .map(
      (hit, index) =>
        `[${index + 1}] docId=${hit.docId}; sourceRef=${hit.sourceRef}; memoryVersion=${hit.memoryVersion ?? 'unknown'}\n${hit.snippet}`,
    )
    .join('\n\n')
}

export class WikiAgentRuntime {
  constructor(
    private agents: AgentRepository,
    private tickets: TicketRepository,
    private gateway: ModelGateway,
    private ticketService: TicketService,
    private toolBroker: ToolBrokerService,
    private playbooks: PlaybookService,
    private conversations: ConversationService,
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
      role: 'user',
      content: question,
      actorType: 'human',
      actorId: params.createdById,
    })

    const result = await this.processConversation({
      conversationId,
      agentId: params.agentId,
      question,
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

  async processConversation(params: { conversationId: string; agentId: string; question: string }) {
    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')

    const modelConfig = agentDetails.agent.modelConfig as {
      provider: string
      model: string
      temperature?: number
      maxTokens?: number
    }
    const agentVersion = agentDetails.agent.currentVersion

    const payload = {
      question: params.question,
      agentVersion,
      model: modelConfig.model,
      memoryVersion: agentDetails.memoryVersion,
      recipeName: agentDetails.recipe?.name ?? null,
      recipeVersion: agentDetails.recipe?.version ?? null,
    }

    const search = await this.toolBroker.invoke({
      agentId: params.agentId,
      agentVersion,
      conversationId: params.conversationId,
      tool: 'kb_search',
      args: { query: wikiSearchQuery(payload), k: 6 },
    })
    if (search.denied) {
      throw new Error(`kb_search denied: ${search.reason}`)
    }

    const hits =
      !search.denied && 'hits' in search.result && Array.isArray(search.result.hits)
        ? search.result.hits
        : []
    const sourceContext = formatHitsForPrompt(hits)
    const answerInstruction =
      hits.length === 0
        ? 'Nincs elég forrás. Ezt mondd ki, és ne találj ki tényt.'
        : 'Kizárólag a megadott forrásrészletekre támaszkodj.'

    const { content } = await this.gateway.call({
      agentId: params.agentId,
      conversationId: params.conversationId,
      messages: [
        { role: 'system', content: composeSystemPrompt(agentDetails.agent) },
        {
          role: 'system',
          content: `${answerInstruction}\n\nForrásrészletek:\n${sourceContext}`,
        },
        {
          role: 'user',
          content: wikiUserPrompt(payload),
        },
      ],
      modelConfig,
    })

    const parsed = wikiAnswerSchema.parse(extractJsonObject(content))
    const sources =
      parsed.sources.length > 0
        ? parsed.sources
        : hits.map((hit) => ({ docId: hit.docId, sectionRef: hit.sourceRef }))

    const answer: WikiAnswer = { ...parsed, sources }
    const agentMessage = await this.conversations.appendMessage({
      conversationId: params.conversationId,
      role: 'agent',
      content: JSON.stringify({
        answer: answer.answer,
        sources: answer.sources,
        rationale: answer.rationale,
        confidence: answer.confidence,
        retrievedSources: hits,
        ...payload,
      }),
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
  async askWikiViaTicket(params: { agentId: string; question: string; createdById: string }) {
    const ticket = await this.createQuestionTicket(params)
    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')
    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'in_progress',
      actor: { type: 'system' },
      agentVersion: agentDetails.agent.currentVersion,
    })
    return this.processTicket({ ticketId: ticket.id, agentId: params.agentId })
  }

  async createQuestionTicket(params: { agentId: string; question: string; createdById: string }) {
    const question = params.question.trim()
    if (!question) throw new Error('Question is required')

    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')

    const modelConfig = agentDetails.agent.modelConfig as {
      provider: string
      model: string
      temperature?: number
      maxTokens?: number
    }
    const agentVersion = agentDetails.agent.currentVersion
    const recipe = agentDetails.recipe
    const playbookRef =
      (await this.playbooks.getActiveRefByName('wiki-interaction')) ?? null

    const ticket = await this.tickets.create({
      type: 'interaction',
      title: `Wiki kérdés: ${question.slice(0, 80)}`,
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
      },
      sourceDocumentId: null,
      executeAfter: null,
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

  async processTicket(params: { ticketId: string; agentId: string }) {
    const ticket = await this.tickets.findById(params.ticketId)
    if (!ticket) throw new Error('Ticket not found')
    if (ticket.agentId !== params.agentId) throw new Error('Ticket not assigned to this agent')
    if (ticket.type !== 'interaction') throw new Error('Wiki runtime only handles interaction tickets')

    const payload =
      typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
        ? (ticket.payload as Record<string, unknown>)
        : {}
    const { question } = readWikiTicketPayload(payload)
    if (!question) throw new Error('Ticket payload is missing question')
    const searchQuery = wikiSearchQuery(payload)

    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')

    const modelConfig = agentDetails.agent.modelConfig as {
      provider: string
      model: string
      temperature?: number
      maxTokens?: number
    }
    const agentVersion = agentDetails.agent.currentVersion

    const search = await this.toolBroker.invoke({
      agentId: params.agentId,
      agentVersion,
      ticketId: ticket.id,
      tool: 'kb_search',
      args: { query: searchQuery, k: 6 },
    })
    if (search.denied) {
      throw new Error(`kb_search denied: ${search.reason}`)
    }

    const hits =
      !search.denied && 'hits' in search.result && Array.isArray(search.result.hits)
        ? search.result.hits
        : []
    const sourceContext = formatHitsForPrompt(hits)
    const answerInstruction =
      hits.length === 0
        ? 'Nincs elég forrás. Ezt mondd ki, és ne találj ki tényt.'
        : 'Kizárólag a megadott forrásrészletekre támaszkodj.'

    const { content } = await this.gateway.call({
      agentId: params.agentId,
      ticketId: ticket.id,
      messages: [
        { role: 'system', content: composeSystemPrompt(agentDetails.agent) },
        {
          role: 'system',
          content: `${answerInstruction}\n\nForrásrészletek:\n${sourceContext}`,
        },
        {
          role: 'user',
          content: wikiUserPrompt(payload),
        },
      ],
      modelConfig,
    })

    const parsed = wikiAnswerSchema.parse(extractJsonObject(content))
    const sources =
      parsed.sources.length > 0
        ? parsed.sources
        : hits.map((hit) => ({ docId: hit.docId, sectionRef: hit.sourceRef }))

    const write = await this.toolBroker.invoke({
      agentId: params.agentId,
      agentVersion,
      ticketId: ticket.id,
      tool: 'board_write',
      args: {
        ticketId: ticket.id,
        patch: {
          payload: {
            answer: parsed.answer,
            sources,
            rationale: parsed.rationale,
            confidence: parsed.confidence,
            retrievedSources: hits,
            agentVersion,
            model: modelConfig.model,
            memoryVersion: agentDetails.memoryVersion,
            recipeName: agentDetails.recipe?.name ?? null,
            recipeVersion: agentDetails.recipe?.version ?? null,
          },
          state: parsed.confidence === 'high' ? 'done' : 'awaiting_human',
        },
      },
    })
    if (write.denied) {
      throw new Error(`board_write denied: ${write.reason}`)
    }

    const updated = await this.tickets.findById(ticket.id)
    return {
      ticketId: ticket.id,
      answer: {
        ...parsed,
        sources,
      } satisfies WikiAnswer,
      ticket: updated,
    }
  }
}
