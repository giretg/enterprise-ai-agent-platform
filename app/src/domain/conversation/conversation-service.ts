import type {
  AuditActorType,
  ChannelType,
  Conversation,
  Message,
  MessageCriticality,
  MessageRole,
  Ticket,
} from '@prisma/client'
import type {
  AuditRepository,
  ConversationRepository,
  TicketRepository,
} from '@/repositories/interfaces'
import type { PlaybookService } from '../playbook/playbook-service'

export type ConversationMessageView = {
  id: string
  seq: number
  role: string
  actingUserId: string | null
  content: string | null
  contentHash: string | null
  agentVersion: number | null
  model: string | null
  contentDeletedAt: Date | null
  ticketRefId: string | null
  auditEventRef: string | null
  criticality: string | null
  createdAt: Date
}

export class ConversationService {
  constructor(
    private conversations: ConversationRepository,
    private tickets: TicketRepository,
    private audit: AuditRepository,
    private playbooks: PlaybookService,
  ) {}

  private async findConversationScoped(params: {
    conversationId: string
    tenantId?: string | null
    actorId?: string | null
  }): Promise<Conversation | null> {
    if (params.tenantId === undefined) {
      return this.conversations.findById(params.conversationId)
    }

    const conversation = await this.conversations.findByIdForTenant(
      params.conversationId,
      params.tenantId,
    )
    if (conversation) return conversation

    const existing = await this.conversations.findById(params.conversationId)
    if (existing) {
      await this.audit.append({
        actorType: params.actorId ? 'human' : 'system',
        actorId: params.actorId ?? null,
        agentVersion: null,
        action: 'access.denied',
        targetType: 'conversation',
        targetId: params.conversationId,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: 'denied',
        metadata: {
          reason: 'cross_tenant',
          tenantId: params.tenantId,
          conversationTenantId: existing.tenantId,
        },
      })
    }

    return null
  }

  async createConversation(params: {
    agentId: string
    createdById: string
    tenantId?: string | null
    title?: string | null
    retentionPolicyId?: string | null
    legalHold?: boolean
    /** Memória-hatókör projektkulcsa (D9). Alap: gyűjtő. Csatorna-beszélgetésnél az engedélyről. */
    projectKey?: string | null
    /** Csatorna-megjelölés (D14): Telegram-szál esetén a webes felület ebből tudja, honnan jön. */
    channel?: ChannelType | null
    channelExternalId?: string | null
    /** Ticket → Megbeszélés (#219): forrás ticket (prior kontextus a chat runtime-nak). */
    continuedFromTicketId?: string | null
  }) {
    const conversation = await this.conversations.create({
      tenantId: params.tenantId ?? null,
      agentId: params.agentId,
      title: params.title ?? null,
      createdById: params.createdById,
      retentionPolicyId: params.retentionPolicyId ?? null,
      legalHold: params.legalHold ?? false,
      projectKey: params.projectKey ?? null,
      channel: params.channel ?? null,
      channelExternalId: params.channelExternalId ?? null,
      continuedFromTicketId: params.continuedFromTicketId ?? null,
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
      outputRef: conversation.id,
      policyDecision: 'allowed',
      metadata: {
        conversationId: conversation.id,
        tenantId: params.tenantId ?? null,
        agentId: params.agentId,
        createdBy: params.createdById,
        retentionPolicyId: conversation.retentionPolicyId,
        retainUntil: conversation.retainUntil?.toISOString() ?? null,
        legalHold: conversation.legalHold,
        continuedFromTicketId: conversation.continuedFromTicketId,
      },
    })

    return conversation
  }

  async appendMessage(params: {
    conversationId: string
    role: MessageRole
    content: string
    tenantId?: string | null
    actingUserId?: string | null
    agentVersion?: number | null
    model?: string | null
    ticketRefId?: string | null
    criticality?: MessageCriticality | null
    actorType?: AuditActorType
    actorId?: string | null
    /** A repository-tranzakció commitja után, még az audit-kapcsolás előtt fut. */
    onPersisted?: (message: Message) => void
  }) {
    if (params.tenantId !== undefined) {
      const conversation = await this.findConversationScoped({
        conversationId: params.conversationId,
        tenantId: params.tenantId,
        actorId: params.actorId ?? null,
      })
      if (!conversation) throw new Error('Conversation not found')
    }

    const message = await this.conversations.appendMessage({
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      actingUserId: params.actingUserId ?? null,
      agentVersion: params.agentVersion ?? null,
      model: params.model ?? null,
      ticketRefId: params.ticketRefId ?? null,
      criticality: params.criticality ?? null,
    })
    params.onPersisted?.(message)

    const auditEvent = await this.audit.append({
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
      metadata: {
        messageId: message.id,
        conversationId: params.conversationId,
        seq: message.seq,
        role: params.role,
        actingUserId: message.actingUserId,
        agentVersion: message.agentVersion,
        model: message.model,
        contentHash: message.contentHash,
        criticality: message.criticality,
      },
    })

    return this.conversations.setMessageAuditEventRef(message.id, auditEvent.id)
  }

  async getConversation(
    conversationId: string,
    tenantId?: string | null,
    options?: { limit?: number; beforeSeq?: number; actorId?: string | null },
  ) {
    const conversation = await this.findConversationScoped({
      conversationId,
      tenantId,
      actorId: options?.actorId ?? null,
    })
    if (!conversation) throw new Error('Conversation not found')

    const messages = await this.conversations.findMessages(conversationId, {
      limit: options?.limit,
      beforeSeq: options?.beforeSeq,
    })
    return {
      conversation,
      messages: messages satisfies ConversationMessageView[],
    }
  }

  async listConversations(params: {
    tenantId?: string | null
    agentId?: string
    status?: Conversation['status']
    mine?: boolean
    createdById?: string
    limit?: number
    cursor?: Date
  }) {
    const conversations = await this.conversations.list(params)
    const last = conversations[conversations.length - 1]
    return {
      conversations,
      nextCursor: last ? last.lastMessageAt : null,
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

  async deleteMessageContent(params: {
    messageId: string
    actorId: string
    tenantId?: string | null
    reason?: string | null
  }) {
    const existing =
      params.tenantId === undefined
        ? await this.conversations.findMessageById(params.messageId)
        : await this.conversations.findMessageByIdForTenant(params.messageId, params.tenantId)
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
      metadata: {
        messageId: existing.id,
        conversationId: existing.conversationId,
        seq: existing.seq,
        contentHash: existing.contentHash,
        reason: params.reason ?? null,
      },
    })

    return updated
  }

  async archiveConversation(params: {
    conversationId: string
    actorId: string
    tenantId?: string | null
  }) {
    const conversation = await this.findConversationScoped({
      conversationId: params.conversationId,
      tenantId: params.tenantId,
      actorId: params.actorId,
    })
    if (!conversation) throw new Error('Conversation not found')

    const archived = await this.conversations.archive(conversation.id)
    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'conversation.archive',
      targetType: 'conversation',
      targetId: conversation.id,
      modelUsed: null,
      inputRef: conversation.id,
      outputRef: archived.status,
      policyDecision: 'allowed',
      metadata: { conversationId: conversation.id, by: params.actorId },
    })

    return archived
  }

  async deleteConversationContent(params: {
    conversationId: string
    actorId: string
    tenantId?: string | null
    reason?: string | null
  }) {
    const conversation = await this.findConversationScoped({
      conversationId: params.conversationId,
      tenantId: params.tenantId,
      actorId: params.actorId,
    })
    if (!conversation) throw new Error('Conversation not found')

    const deletedMessages = await this.conversations.deleteConversationContent(conversation.id)
    for (const message of deletedMessages) {
      await this.audit.append({
        actorType: 'human',
        actorId: params.actorId,
        agentVersion: message.agentVersion,
        action: 'message.content_deleted',
        targetType: 'conversation',
        targetId: conversation.id,
        modelUsed: null,
        inputRef: message.id,
        outputRef: `seq:${message.seq}`,
        policyDecision: 'allowed',
        metadata: {
          messageId: message.id,
          conversationId: conversation.id,
          seq: message.seq,
          contentHash: message.contentHash,
          reason: params.reason ?? null,
        },
      })
    }

    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'conversation.content_deleted',
      targetType: 'conversation',
      targetId: conversation.id,
      modelUsed: null,
      inputRef: conversation.id,
      outputRef: String(deletedMessages.length),
      policyDecision: 'allowed',
      metadata: {
        conversationId: conversation.id,
        deletedCount: deletedMessages.length,
        reason: params.reason ?? null,
        by: params.actorId,
      },
    })

    return { deletedCount: deletedMessages.length }
  }

  async promoteToTicket(params: {
    conversationId: string
    createdById: string
    reason?: string
    tenantId: string | null
    type?: Ticket['type']
    answerPayload: Record<string, unknown>
    fromMessageId?: string | null
    agentMessageId?: string | null
  }): Promise<Ticket> {
    const conversation = await this.findConversationScoped({
      conversationId: params.conversationId,
      tenantId: params.tenantId,
      actorId: params.createdById,
    })
    if (!conversation) throw new Error('Conversation not found')

    const sourceMessageId = params.fromMessageId ?? params.agentMessageId ?? null
    if (sourceMessageId) {
      const sourceMessage = await this.conversations.findMessageById(sourceMessageId)
      if (!sourceMessage || sourceMessage.conversationId !== conversation.id) {
        throw new Error('Source message not found')
      }
    }

    const question =
      typeof params.answerPayload.question === 'string'
        ? params.answerPayload.question
        : 'Wiki válasz'
    const playbookRef = (await this.playbooks.getActiveRefByName('wiki-interaction')) ?? null

    const ticket = await this.tickets.create({
      tenantId: conversation.tenantId,
      type: params.type ?? 'interaction',
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

    if (sourceMessageId) {
      await this.conversations.linkMessageToTicket(sourceMessageId, ticket.id)
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
      metadata: {
        conversationId: conversation.id,
        fromMessageId: sourceMessageId,
        ticketId: ticket.id,
        type: ticket.type,
        by: params.createdById,
      },
    })

    return ticket
  }

  /**
   * Megőrzési takarítás a MI tárolónkban (#117): a lejárt `retainUntil`-ú beszélgetések
   * üzenet-tartalmát ürítjük (a metaadat és az audit-nyom marad). A takarító a dispatcher
   * ciklusából fut (`run-dispatch-cycle.ts`), körönként `limit` darabbal — így egy nagy
   * hátralék sem fogja meg a kört, a maradékot a következő kör viszi tovább.
   *
   * ÜRES futásra NEM írunk audit-sort: minden `audit.append` globális advisory lockot vesz a
   * hash-láncra, tehát a percenkénti „nem volt mit takarítani" bejegyzés zajjal töltené a
   * láncot és sorosítaná az írásokat. Ami nem történt, az nem esemény.
   */
  async retentionSweep(params?: { now?: Date; actorId?: string | null; limit?: number }) {
    const result = await this.conversations.retentionSweep(params?.now ?? new Date(), params?.limit)
    if (result.sweptCount === 0) return result

    await this.audit.append({
      actorType: 'system',
      actorId: params?.actorId ?? null,
      agentVersion: null,
      action: 'retention.sweep',
      targetType: 'conversation',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: String(result.deletedCount),
      policyDecision: 'allowed',
      metadata: {
        sweptCount: result.sweptCount,
        deletedCount: result.deletedCount,
        conversationIds: result.conversationIds,
      },
    })

    return result
  }
}
