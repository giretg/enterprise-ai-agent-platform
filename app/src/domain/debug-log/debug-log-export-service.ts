import type { PrismaClient } from '@prisma/client'
import type { AuditRepository, TicketRepository, ToolBrokerRepository } from '@/repositories/interfaces'
import type { ConversationService } from '@/domain/conversation/conversation-service'
import {
  buildConversationDebugLogBundle,
  buildTicketDebugLogBundle,
  serializeDebugLogBundle,
  type ConversationDebugLogBundle,
  type DebugLogExportFile,
  type TicketDebugLogSlice,
} from './debug-log-export'

const DEFAULT_AUDIT_LIMIT = 500
const DEFAULT_MODEL_CALL_LIMIT = 500
const DEFAULT_TOOL_CALL_LIMIT = 500
const DEFAULT_TURN_LIMIT = 200
const DEFAULT_MESSAGE_LIMIT = 2000

export class DebugLogExportService {
  constructor(
    private prisma: PrismaClient,
    private conversations: ConversationService,
    private tickets: TicketRepository,
    private audit: AuditRepository,
    private toolBroker: ToolBrokerRepository,
  ) {}

  async exportConversation(params: {
    conversationId: string
    tenantId: string | null
    actorId: string
  }): Promise<DebugLogExportFile> {
    const bundle = await this.buildConversationBundle(params)
    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'conversation.debug_log.export',
      targetType: 'conversation',
      targetId: params.conversationId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      metadata: {
        schemaVersion: bundle.schemaVersion,
        messageCount: bundle.messages.length,
        agentTurnCount: bundle.agentTurns.length,
        modelCallCount: bundle.modelCalls.length,
        toolCallCount: bundle.toolCalls.length,
        auditCount: bundle.audit.length,
        linkedTicketCount: bundle.linkedTickets.length,
      },
    })
    return serializeDebugLogBundle(bundle, params.conversationId)
  }

  async exportTicket(params: {
    ticketId: string
    tenantId: string | null
    actorId: string
  }): Promise<DebugLogExportFile> {
    const ticket = await this.tickets.findById(params.ticketId)
    if (!ticket || ticket.tenantId !== params.tenantId) {
      throw new Error('Ticket not found')
    }

    const [comments, transitions, modelCalls, toolCalls, auditRows] = await Promise.all([
      this.tickets.listComments(params.ticketId),
      this.tickets.findTransitions(params.ticketId),
      this.prisma.modelCall.findMany({
        where: { ticketId: params.ticketId },
        orderBy: { createdAt: 'asc' },
        take: DEFAULT_MODEL_CALL_LIMIT,
      }),
      this.prisma.toolCall.findMany({
        where: { ticketId: params.ticketId },
        orderBy: { createdAt: 'asc' },
        take: DEFAULT_TOOL_CALL_LIMIT,
      }),
      this.audit.findMany({
        ticketId: params.ticketId,
        limit: DEFAULT_AUDIT_LIMIT,
      }),
    ])

    const audit = [...auditRows].reverse()

    let linkedConversation: ConversationDebugLogBundle | null = null
    if (ticket.conversationId) {
      try {
        linkedConversation = await this.buildConversationBundle({
          conversationId: ticket.conversationId,
          tenantId: params.tenantId,
          actorId: params.actorId,
        })
      } catch {
        // Kapcsolt beszélgetés hiányzik / más tenant — a ticket export így is hasznos.
        linkedConversation = null
      }
    }

    const bundle = buildTicketDebugLogBundle({
      ticket,
      comments,
      transitions,
      modelCalls,
      toolCalls,
      audit,
      linkedConversation,
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'ticket.debug_log.export',
      targetType: 'ticket',
      targetId: params.ticketId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      tenantId: params.tenantId,
      ticketId: params.ticketId,
      conversationId: ticket.conversationId,
      metadata: {
        schemaVersion: bundle.schemaVersion,
        commentCount: bundle.comments.length,
        transitionCount: bundle.transitions.length,
        modelCallCount: bundle.modelCalls.length,
        toolCallCount: bundle.toolCalls.length,
        auditCount: bundle.audit.length,
        hasLinkedConversation: Boolean(linkedConversation),
      },
    })

    return serializeDebugLogBundle(bundle, params.ticketId)
  }

  private async buildConversationBundle(params: {
    conversationId: string
    tenantId: string | null
    actorId: string
  }): Promise<ConversationDebugLogBundle> {
    const { conversation, messages } = await this.conversations.getConversation(
      params.conversationId,
      params.tenantId,
      { limit: DEFAULT_MESSAGE_LIMIT, actorId: params.actorId },
    )

    const [agentTurns, modelCalls, toolCalls, auditRows, linkedTicketRows] = await Promise.all([
      this.prisma.agentTurn.findMany({
        where: { conversationId: params.conversationId },
        orderBy: { startedAt: 'asc' },
        take: DEFAULT_TURN_LIMIT,
      }),
      this.prisma.modelCall.findMany({
        where: { conversationId: params.conversationId },
        orderBy: { createdAt: 'asc' },
        take: DEFAULT_MODEL_CALL_LIMIT,
      }),
      this.toolBroker.listToolCallsForConversation(params.conversationId, DEFAULT_TOOL_CALL_LIMIT),
      this.audit.findMany({
        conversationId: params.conversationId,
        limit: DEFAULT_AUDIT_LIMIT,
      }),
      this.prisma.ticket.findMany({
        where: { conversationId: params.conversationId },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
    ])

    const audit = [...auditRows].reverse()

    const linkedTickets: TicketDebugLogSlice[] = await Promise.all(
      linkedTicketRows.map(async (ticket) => {
        const [comments, transitions] = await Promise.all([
          this.tickets.listComments(ticket.id),
          this.tickets.findTransitions(ticket.id),
        ])
        return { ticket, comments, transitions }
      }),
    )

    return buildConversationDebugLogBundle({
      conversation,
      messages,
      agentTurns,
      modelCalls,
      toolCalls,
      audit,
      linkedTickets,
    })
  }
}
