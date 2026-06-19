import type { Agent, Connector, Document, Ticket, UserRole } from '@prisma/client'
import type {
  AgentRepository,
  AuditRepository,
  DocumentRepository,
  TicketRepository,
} from '@/repositories/interfaces'
import { ensureAgentKnowledgeBase } from '@/lib/agent-knowledge-base'
import type { TicketService } from '../ticket/ticket-service'

type EnsureKnowledgeBase = (
  agent: Pick<Agent, 'id' | 'name' | 'role'>,
) => Promise<Connector | null>

/**
 * §9.3 / §4.6: a tudásbázis-frissítés jóváhagyott tanítási ticketen megy.
 * A KB-dokumentum a `training` tickettípust használja (a memóriától eltérő
 * altípus), `kind: 'kb_document'` diszkriminátorral — így nem keveredik a
 * memória-write-gate (TrainingService) jóváhagyásával.
 */
export const KB_DOCUMENT_TICKET_KIND = 'kb_document'

export type KbDocumentTicketPayload = {
  kind: typeof KB_DOCUMENT_TICKET_KIND
  documentId: string
  connectorId: string
  filename: string
}

/** Visszaadja a KB-dokumentum payloadot, ha a ticket valóban KB-jóváhagyás. */
export function asKbDocumentPayload(payload: Ticket['payload']): KbDocumentTicketPayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const candidate = payload as Record<string, unknown>
  if (candidate.kind !== KB_DOCUMENT_TICKET_KIND) return null
  if (typeof candidate.documentId !== 'string') return null
  if (typeof candidate.connectorId !== 'string') return null
  return {
    kind: KB_DOCUMENT_TICKET_KIND,
    documentId: candidate.documentId,
    connectorId: candidate.connectorId,
    filename: typeof candidate.filename === 'string' ? candidate.filename : 'dokumentum',
  }
}

export class KnowledgeBaseService {
  constructor(
    private tickets: TicketRepository,
    private documents: DocumentRepository,
    private agents: AgentRepository,
    private audit: AuditRepository,
    private ticketService: TicketService,
    // Injektálható a teszteléshez; alapból a valós provisioning.
    private ensureKnowledgeBase: EnsureKnowledgeBase = ensureAgentKnowledgeBase,
  ) {}

  /**
   * Feltöltött (de még nem csatolt) dokumentumhoz jóváhagyási ticketet nyit.
   * A dokumentum csak a jóváhagyás után kerül a KB connectorba — addig a
   * kb_search nem találja meg.
   */
  async requestDocument(params: {
    agentId: string
    documentId: string
    createdById: string
  }): Promise<Ticket> {
    const agent = await this.agents.findById(params.agentId)
    if (!agent) throw new Error('Agent not found')
    if (agent.role === 'orchestrator') {
      throw new Error('Orchestrator agents do not use a knowledge base')
    }

    const document = await this.documents.findById(params.documentId)
    if (!document) throw new Error('Document not found')
    if (document.connectorId) throw new Error('Document already attached to a knowledge base')

    const connector = await this.ensureKnowledgeBase(agent)
    if (!connector) throw new Error('Agent has no knowledge_base connector')

    const payload: KbDocumentTicketPayload = {
      kind: KB_DOCUMENT_TICKET_KIND,
      documentId: document.id,
      connectorId: connector.id,
      filename: document.filename,
    }

    const ticket = await this.tickets.create({
      type: 'training',
      title: `KB jóváhagyás: ${document.filename}`,
      state: 'backlog',
      assigneeType: 'human',
      assigneeId: null,
      agentId: params.agentId,
      payload,
      sourceDocumentId: document.id,
      executeAfter: null,
      dueBy: null,
      createdById: params.createdById,
    })

    // Az állapotgépen át vezetjük a jóváhagyási kapuig — minden lépés auditált.
    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'ready',
      actor: { type: 'system' },
    })
    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'in_progress',
      actor: { type: 'system' },
    })
    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'awaiting_human',
      actor: { type: 'system' },
    })

    const updated = await this.tickets.findById(ticket.id)
    return updated ?? ticket
  }

  /** Jóváhagyás: a dokumentum bekerül a KB connectorba és kereshetővé válik. */
  async approveDocument(params: {
    ticketId: string
    approverId: string
    approverRole: UserRole
  }): Promise<Document> {
    const ticket = await this.tickets.findById(params.ticketId)
    if (!ticket || ticket.type !== 'training') throw new Error('KB ticket not found')
    const payload = asKbDocumentPayload(ticket.payload)
    if (!payload) throw new Error('Not a KB document ticket')
    if (ticket.state !== 'awaiting_human') throw new Error('Ticket not awaiting approval')

    const updated = await this.documents.update(payload.documentId, {
      connectorId: payload.connectorId,
      status: 'processed',
    })

    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'approved',
      actor: { type: 'human', userId: params.approverId, role: params.approverRole },
    })
    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'done',
      actor: { type: 'system' },
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.approverId,
      agentVersion: null,
      action: 'kb.document.approved',
      targetType: 'document',
      targetId: payload.documentId,
      modelUsed: null,
      inputRef: ticket.id,
      outputRef: payload.connectorId,
      policyDecision: 'kb_document_approved',
      metadata: { filename: payload.filename, agentId: ticket.agentId },
    })

    return updated
  }

  /** Elutasítás: a dokumentum nem kerül be, `failed` státuszt kap. */
  async rejectDocument(params: {
    ticketId: string
    approverId: string
    approverRole: UserRole
  }): Promise<{ rejected: true }> {
    const ticket = await this.tickets.findById(params.ticketId)
    if (!ticket || ticket.type !== 'training') throw new Error('KB ticket not found')
    const payload = asKbDocumentPayload(ticket.payload)
    if (!payload) throw new Error('Not a KB document ticket')
    if (ticket.state !== 'awaiting_human') throw new Error('Ticket not awaiting approval')

    await this.documents.update(payload.documentId, { status: 'failed' })

    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'rejected',
      actor: { type: 'human', userId: params.approverId, role: params.approverRole },
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.approverId,
      agentVersion: null,
      action: 'kb.document.rejected',
      targetType: 'document',
      targetId: payload.documentId,
      modelUsed: null,
      inputRef: ticket.id,
      outputRef: payload.connectorId,
      policyDecision: 'kb_document_rejected',
      metadata: { filename: payload.filename, agentId: ticket.agentId },
    })

    return { rejected: true }
  }

  /** Az agenthez tartozó, jóváhagyásra váró KB-dokumentum ticketek. */
  async listPendingDocuments(agentId: string): Promise<
    Array<{ ticketId: string; documentId: string; filename: string; createdAt: Date }>
  > {
    const tickets = await this.tickets.findMany({
      type: 'training',
      agentId,
      state: 'awaiting_human',
    })
    return tickets
      .map((ticket) => {
        const payload = asKbDocumentPayload(ticket.payload)
        if (!payload) return null
        return {
          ticketId: ticket.id,
          documentId: payload.documentId,
          filename: payload.filename,
          createdAt: ticket.createdAt,
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
  }
}
