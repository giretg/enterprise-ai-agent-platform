import type { AuditActorType, Ticket } from '@prisma/client'
import type { AuditRepository, ConversationRepository, TicketRepository } from '@/repositories/interfaces'
import type { PlaybookService } from '../playbook/playbook-service'

export type ConversationMessageView = {
  id: string
  seq: number
  role: string
  content: string | null
  agentVersion: number | null
  model: string | null
  contentDeletedAt: Date | null
  ticketRefId: string | null
  createdAt: Date
}

export class ConversationService {
  constructor(
    private conversations: ConversationRepository,
    private tickets: TicketRepository,
    private audit: AuditRepository,
    private playbooks: PlaybookService,
  ) {}

  async createConversation(params: {
    agentId: string
    createdById: string
    tenantId?: string | null
    title?: string | null
  }) {
    const conversation = await this.conversations.create({
      tenantId: params.tenantId ?? null,
      agentId: params.agentId,
      title: params.title ?? null,
      createdById: params.createdById,
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.createdById,
      agentVersion: null,
      action: 'conversation.create',
      targetType: 'conversation',
      targetId: conversation.id,
      modelUsed: null,
      inputRef: params.agentId,
      outputRef: conversation.title ?? null,
      policyDecision: 'allowed',
      metadata: { tenantId: params.tenantId ?? null },
    })

    return conversation
  }

  async appendMessage(params: {
    conversationId: string
    role: 'user' | 'agent' | 'system'
    content: string
    agentVersion?: number | null
    model?: string | null
    actorType?: AuditActorType
    actorId?: string | null
  }) {
    const message = await this.conversations.appendMessage({
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      agentVersion: params.agentVersion ?? null,
      model: params.model ?? null,
    })

    await this.audit.append({
      actorType: params.actorType ?? 'system',
      actorId: params.actorId ?? null,
      agentVersion: params.agentVersion ?? null,
      action: 'message.append',
      targetType: 'conversation',
      targetId: params.conversationId,
      modelUsed: params.model ?? null,
      inputRef: message.id,
      outputRef: `seq:${message.seq}`,
      policyDecision: 'allowed',
      metadata: { role: params.role, messageId: message.id },
    })

    return message
  }

  async getConversation(conversationId: string, tenantId?: string | null) {
    const conversation = tenantId
      ? await this.conversations.findByIdForTenant(conversationId, tenantId)
      : await this.conversations.findById(conversationId)
    if (!conversation) throw new Error('Conversation not found')

    const messages = await this.conversations.findMessages(conversationId)
    return {
      conversation,
      messages: messages satisfies ConversationMessageView[],
    }
  }

  async listForAgentUser(params: {
    agentId: string
    createdById: string
    tenantId?: string | null
    limit?: number
  }) {
    return this.conversations.findManyForAgentUser(params)
  }

  async deleteMessageContent(params: { messageId: string; actorId: string }) {
    const existing = await this.conversations.findMessageById(params.messageId)
    if (!existing) throw new Error('Message not found')

    const updated = await this.conversations.deleteMessageContent(params.messageId)

    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: existing.agentVersion,
      action: 'message.content_deleted',
      targetType: 'conversation',
      targetId: existing.conversationId,
      modelUsed: null,
      inputRef: existing.id,
      outputRef: `seq:${existing.seq}`,
      policyDecision: 'allowed',
      metadata: { messageId: existing.id },
    })

    return updated
  }

  async promoteToTicket(params: {
    conversationId: string
    createdById: string
    reason?: string
    answerPayload: Record<string, unknown>
    agentMessageId?: string | null
  }): Promise<Ticket> {
    const conversation = await this.conversations.findById(params.conversationId)
    if (!conversation) throw new Error('Conversation not found')

    const question =
      typeof params.answerPayload.question === 'string' ? params.answerPayload.question : 'Wiki válasz'
    const playbookRef =
      (await this.playbooks.getActiveRefByName('wiki-interaction')) ?? null

    const ticket = await this.tickets.create({
      tenantId: conversation.tenantId,
      type: 'interaction',
      title: `Wiki jóváhagyás: ${question.slice(0, 80)}`,
      state: 'awaiting_human',
      assigneeType: 'human',
      assigneeId: null,
      agentId: conversation.agentId,
      playbookRef,
      conversationId: conversation.id,
      payload: {
        ...params.answerPayload,
        conversationId: conversation.id,
        promoteReason: params.reason ?? 'approval',
      },
      sourceDocumentId: null,
      executeAfter: null,
      dueBy: null,
      createdById: params.createdById,
    })

    if (params.agentMessageId) {
      await this.conversations.linkMessageToTicket(params.agentMessageId, ticket.id)
    }

    if (playbookRef) {
      await this.playbooks.auditProcessStart({
        ticket,
        playbookRef,
        actorType: 'human',
        actorId: params.createdById,
      })
    }

    await this.audit.append({
      actorType: 'human',
      actorId: params.createdById,
      agentVersion: null,
      action: 'conversation.promote_to_ticket',
      targetType: 'conversation',
      targetId: conversation.id,
      modelUsed: null,
      inputRef: params.reason ?? 'approval',
      outputRef: ticket.id,
      policyDecision: 'allowed',
      metadata: { ticketId: ticket.id },
    })

    return ticket
  }
}
