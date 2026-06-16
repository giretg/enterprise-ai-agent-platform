import { z } from 'zod'
import type { AgentRepository, TicketRepository } from '@/repositories/interfaces'
import type { ModelGateway } from '../gateway/model-gateway'
import type { ToolBrokerService } from '../tool-broker/tool-broker-service'
import { TicketService } from '../ticket/ticket-service'

const wikiAnswerSchema = z.object({
  answer: z.string().trim().min(1),
  sources: z
    .array(
      z.object({
        docId: z.string().trim().min(1),
        sectionRef: z.string().trim().min(1),
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
  ) {}

  async askWiki(params: { agentId: string; question: string; createdById: string }) {
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

    const ticket = await this.tickets.create({
      type: 'interaction',
      title: `Wiki kérdés: ${question.slice(0, 80)}`,
      state: 'ready',
      assigneeType: 'agent',
      assigneeId: params.agentId,
      agentId: params.agentId,
      payload: {
        question,
        agentVersion,
        model: modelConfig.model,
        memoryVersion: agentDetails.memoryVersion,
      },
      sourceDocumentId: null,
      executeAfter: null,
      dueBy: null,
      createdById: params.createdById,
    })

    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'in_progress',
      actor: { type: 'system' },
      agentVersion,
    })

    const search = await this.toolBroker.invoke({
      agentId: params.agentId,
      agentVersion,
      ticketId: ticket.id,
      tool: 'kb_search',
      args: { query: question, k: 6 },
    })
    if (search.denied) {
      throw new Error(`kb_search denied: ${search.reason}`)
    }

    const hits = 'hits' in search.result ? search.result.hits : []
    const sourceContext = formatHitsForPrompt(hits)
    const answerInstruction =
      hits.length === 0
        ? 'Nincs elég forrás. Ezt mondd ki, és ne találj ki tényt.'
        : 'Kizárólag a megadott forrásrészletekre támaszkodj.'

    const { content } = await this.gateway.call({
      agentId: params.agentId,
      ticketId: ticket.id,
      messages: [
        { role: 'system', content: agentDetails.agent.systemPrompt },
        {
          role: 'system',
          content: `${answerInstruction}\n\nForrásrészletek:\n${sourceContext}`,
        },
        {
          role: 'user',
          content: `Válaszolj az alábbi kérdésre magyarul, tömören. Adj vissza CSAK valid JSON-t ebben a formában:
{
  "answer": "...",
  "sources": [{"docId": "...", "sectionRef": "..."}],
  "rationale": "...",
  "confidence": "high|medium|low"
}

Kérdés:
${question}`,
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
