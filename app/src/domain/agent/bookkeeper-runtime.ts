import { z } from 'zod'
import { prisma } from '@/lib/db'
import type { AgentRepository, DocumentRepository, TicketRepository } from '@/repositories/interfaces'
import { composeSystemPrompt } from '@/lib/agent-prompt'
import type { ModelGateway } from '../gateway/model-gateway'
import { TicketService } from '../ticket/ticket-service'

const llmString = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (v ?? '').trim())

const llmNumber = z.union([z.number(), z.string(), z.null(), z.undefined()]).transform((v) => {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : 0
})

export const invoiceProposalSchema = z.object({
  supplier: llmString,
  invoiceNumber: llmString,
  date: llmString,
  netAmount: llmNumber,
  vatAmount: llmNumber,
  grossAmount: llmNumber,
  lineItems: z
    .array(z.object({ description: llmString, amount: llmNumber }))
    .optional(),
  suggestedAccount: llmString,
  suggestedAccountName: llmString,
  costCenter: llmString,
  reasoning: llmString,
})

export type InvoiceProposal = z.infer<typeof invoiceProposalSchema>

export class BookkeeperAgentRuntime {
  constructor(
    private agents: AgentRepository,
    private documents: DocumentRepository,
    private tickets: TicketRepository,
    private gateway: ModelGateway,
    private ticketService: TicketService,
  ) {}

  async processDocument(documentId: string, agentId: string, createdById: string) {
    const document = await this.documents.findById(documentId)
    if (!document) throw new Error('Document not found')
    if (document.status === 'processing' || document.status === 'processed') {
      throw new Error('Document already processed or in progress')
    }
    if (!document.extractedText?.trim()) {
      throw new Error('Document has no extracted text')
    }

    const agentDetails = await this.agents.findByIdWithDetails(agentId)
    if (!agentDetails) throw new Error('Agent not found')

    await this.documents.update(documentId, { status: 'processing' })

    try {
      const modelConfig = agentDetails.agent.modelConfig as {
        provider: string
        model: string
        temperature?: number
      }

      const { content } = await this.gateway.call({
        agentId,
        messages: [
          { role: 'system', content: composeSystemPrompt(agentDetails.agent) },
          {
            role: 'system',
            content: `Memória (aktív verzió):\n${agentDetails.memoryContent ?? '(üres)'}`,
          },
          {
            role: 'user',
            content: `Elemezd az alábbi számlát és adj vissza CSAK valid JSON-t, semmi mást:
{
  "supplier": "...",
  "invoiceNumber": "...",
  "date": "YYYY-MM-DD",
  "netAmount": 0,
  "vatAmount": 0,
  "grossAmount": 0,
  "lineItems": [{"description": "...", "amount": 0}],
  "suggestedAccount": "...",
  "suggestedAccountName": "...",
  "costCenter": "...",
  "reasoning": "..."
}

Dokumentum:
${document.extractedText}`,
          },
        ],
        modelConfig,
      })

      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('Agent did not return valid JSON')

      const parsed = invoiceProposalSchema.parse(JSON.parse(jsonMatch[0]))

      const ticket = await this.tickets.create({
        type: 'interaction',
        title: `Számla: ${parsed.supplier} — ${parsed.invoiceNumber}`,
        state: 'in_progress',
        assigneeType: 'human',
        assigneeId: null,
        agentId,
        payload: {
          proposal: parsed,
          sourceFileName: document.filename,
          agentVersion: agentDetails.agent.currentVersion,
          model: modelConfig.model,
        },
        sourceDocumentId: documentId,
        executeAfter: null,
        dueBy: null,
        createdById,
      })

      await prisma.modelCall.updateMany({
        where: {
          agentId,
          ticketId: null,
          createdAt: { gte: new Date(Date.now() - 120_000) },
        },
        data: { ticketId: ticket.id },
      })

      await this.documents.update(documentId, { status: 'processed' })

      await this.ticketService.transition({
        ticketId: ticket.id,
        toState: 'awaiting_human',
        actor: { type: 'system' },
        agentVersion: agentDetails.agent.currentVersion,
      })

      return { ticketId: ticket.id, proposal: parsed }
    } catch (error) {
      await this.documents.update(documentId, { status: 'failed' })
      throw error
    }
  }
}
