import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import type {
  ChannelType,
  Conversation,
  Message,
  MessageCriticality,
  MessageRole,
  RetentionPolicy,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ConversationRepository } from '../interfaces'

const MAX_APPEND_RETRIES = 5

function encodeContent(content: string): string {
  return `inline:${content}`
}

function decodeContent(contentRef: string | null | undefined): string | null {
  if (!contentRef) return null
  if (contentRef.startsWith('inline:')) return contentRef.slice('inline:'.length)
  return contentRef
}

function decodePreviewText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string }
    if (typeof parsed.text === 'string') return parsed.text
  } catch {
    // plain text
  }
  return content
}

function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function clampLimit(limit: number | undefined, fallback = 50): number {
  return Math.max(1, Math.min(limit ?? fallback, 100))
}

const RETRYABLE_APPEND_CODES = new Set([
  'P1001', // DB nem elérhető
  'P1002', // DB timeout
  'P1008', // műveleti timeout
  'P1017', // kapcsolat lezárult
  'P2002', // seq verseny
  'P2028', // lejárt tranzakció
  'P2034', // write conflict / deadlock
])

export function isRetryableMessageAppendError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return RETRYABLE_APPEND_CODES.has(String(error.code))
}

export class PostgresConversationRepository implements ConversationRepository {
  private async resolveRetentionPolicy(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string | null
      agentId: string
      retentionPolicyId?: string | null
    },
  ): Promise<RetentionPolicy | null> {
    if (params.retentionPolicyId) {
      return tx.retentionPolicy.findFirst({
        where: { id: params.retentionPolicyId, tenantId: params.tenantId },
      })
    }

    const agentPolicy = await tx.retentionPolicy.findFirst({
      where: {
        tenantId: params.tenantId,
        appliesTo: 'agent',
        agentId: params.agentId,
      },
      orderBy: { createdAt: 'asc' },
    })
    if (agentPolicy) return agentPolicy

    return tx.retentionPolicy.findFirst({
      where: { tenantId: params.tenantId, appliesTo: 'all' },
      orderBy: { createdAt: 'asc' },
    })
  }

  async create(data: {
    tenantId: string | null
    agentId: string
    title?: string | null
    createdById: string
    retentionPolicyId?: string | null
    legalHold?: boolean
    projectKey?: string | null
    channel?: ChannelType | null
    channelExternalId?: string | null
    continuedFromTicketId?: string | null
  }): Promise<Conversation> {
    return prisma.$transaction(async (tx) => {
      const now = new Date()
      const policy = await this.resolveRetentionPolicy(tx, data)
      return tx.conversation.create({
        data: {
          tenantId: data.tenantId,
          agentId: data.agentId,
          title: data.title ?? null,
          createdById: data.createdById,
          retentionPolicyId: policy?.id ?? data.retentionPolicyId ?? null,
          retainUntil: policy ? addDays(now, policy.ttlDays) : null,
          legalHold: data.legalHold ?? false,
          lastMessageAt: now,
          // D9 — a projekt a memória-hatókör; alap a gyűjtő (a séma default-ja is `__general__`).
          ...(data.projectKey != null ? { projectKey: data.projectKey } : {}),
          // D14 — csatorna-megjelölés, hogy a webes felület tudja, ez egy Telegram-szál.
          ...(data.channel != null ? { channel: data.channel } : {}),
          ...(data.channelExternalId != null ? { channelExternalId: data.channelExternalId } : {}),
          // #219 — ticket-megbeszélés forráskötés.
          ...(data.continuedFromTicketId != null
            ? { continuedFromTicketId: data.continuedFromTicketId }
            : {}),
        },
      })
    })
  }

  async findOrCreateEmbeddedThread(data: {
    tenantId: string
    agentId: string
    createdById: string
    channelExternalId: string
    title: string
  }): Promise<Conversation> {
    const where = {
      channel: 'embedded_app' as const,
      channelExternalId: data.channelExternalId,
      createdById: data.createdById,
    }
    const existing = await prisma.conversation.findFirst({ where })
    if (existing) return existing
    try {
      return await this.create({ ...data, channel: 'embedded_app', title: data.title.slice(0, 200) })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await prisma.conversation.findFirst({ where })
        if (raced) return raced
      }
      throw e
    }
  }

  async findById(id: string): Promise<Conversation | null> {
    return prisma.conversation.findUnique({ where: { id } })
  }

  async findByIdForTenant(id: string, tenantId: string | null): Promise<Conversation | null> {
    const row = await prisma.conversation.findUnique({ where: { id } })
    if (!row) return null
    if (row.tenantId !== tenantId) return null
    return row
  }

  async updateProjectKey(id: string, projectKey: string): Promise<Conversation> {
    return prisma.conversation.update({ where: { id }, data: { projectKey } })
  }

  async list(params: {
    tenantId?: string | null
    agentId?: string
    status?: Conversation['status']
    mine?: boolean
    createdById?: string
    limit?: number
    cursor?: Date
  }): Promise<Conversation[]> {
    return prisma.conversation.findMany({
      where: {
        ...(params.tenantId !== undefined ? { tenantId: params.tenantId } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.mine && params.createdById ? { createdById: params.createdById } : {}),
        ...(params.cursor ? { lastMessageAt: { lt: params.cursor } } : {}),
      },
      orderBy: { lastMessageAt: 'desc' },
      take: clampLimit(params.limit),
    })
  }

  async findManyForAgentUser(params: {
    agentId: string
    createdById: string
    tenantId?: string | null
    limit?: number
  }) {
    const rows = await prisma.conversation.findMany({
      where: {
        agentId: params.agentId,
        createdById: params.createdById,
        status: 'active',
        ...(params.tenantId !== undefined ? { tenantId: params.tenantId } : {}),
      },
      orderBy: { lastMessageAt: 'desc' },
      take: clampLimit(params.limit),
      include: {
        messages: {
          where: { role: 'user', contentDeletedAt: null },
          orderBy: { seq: 'asc' },
          take: 1,
          select: { contentRef: true },
        },
      },
    })

    return rows.map(({ messages, ...conversation }) => {
      const raw = messages[0]?.contentRef ? decodeContent(messages[0].contentRef) : null
      return {
        ...conversation,
        previewText: raw ? decodePreviewText(raw) : null,
      }
    })
  }

  async appendMessage(data: {
    conversationId: string
    role: MessageRole
    content: string
    actingUserId?: string | null
    agentVersion?: number | null
    model?: string | null
    ticketRefId?: string | null
    criticality?: MessageCriticality | null
  }): Promise<Message> {
    for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt += 1) {
      try {
        return await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${data.conversationId}))`

          const conversation = await tx.conversation.findUnique({
            where: { id: data.conversationId },
            select: {
              id: true,
              status: true,
              tenantId: true,
              agentId: true,
              retentionPolicyId: true,
            },
          })
          if (!conversation) throw new Error('conversation_not_found')
          if (conversation.status === 'archived') throw new Error('conversation_archived')

          const last = await tx.message.findFirst({
            where: { conversationId: data.conversationId },
            orderBy: { seq: 'desc' },
            select: { seq: true },
          })
          const seq = (last?.seq ?? 0) + 1
          const now = new Date()
          const policy = await this.resolveRetentionPolicy(tx, {
            tenantId: conversation.tenantId,
            agentId: conversation.agentId,
            retentionPolicyId: conversation.retentionPolicyId,
          })

          const message = await tx.message.create({
            data: {
              conversationId: data.conversationId,
              seq,
              role: data.role,
              actingUserId: data.actingUserId ?? null,
              agentVersion: data.agentVersion ?? null,
              model: data.model ?? null,
              contentRef: encodeContent(data.content),
              contentHash: hashContent(data.content),
              ticketRefId: data.ticketRefId ?? null,
              criticality: data.criticality ?? null,
              createdAt: now,
            },
          })

          await tx.conversation.update({
            where: { id: data.conversationId },
            data: {
              lastMessageAt: now,
              retainUntil: policy ? addDays(now, policy.ttlDays) : null,
            },
          })

          return message
        })
      } catch (error) {
        if (isRetryableMessageAppendError(error) && attempt < MAX_APPEND_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
          continue
        }
        throw error
      }
    }

    throw new Error('message_append_retry_exhausted')
  }

  async findMessages(
    conversationId: string,
    options?: { limit?: number; beforeSeq?: number },
  ): Promise<Array<Message & { content: string | null }>> {
    const limit = options?.limit ? clampLimit(options.limit) : undefined
    const rows = await prisma.message.findMany({
      where: {
        conversationId,
        ...(options?.beforeSeq ? { seq: { lt: options.beforeSeq } } : {}),
      },
      orderBy: limit ? { seq: 'desc' } : { seq: 'asc' },
      ...(limit ? { take: limit } : {}),
    })
    const orderedRows = limit ? [...rows].reverse() : rows
    return orderedRows.map((row) => ({
      ...row,
      content: row.contentDeletedAt ? null : decodeContent(row.contentRef),
    }))
  }

  async findMessageById(id: string): Promise<Message | null> {
    return prisma.message.findUnique({ where: { id } })
  }

  async findMessageByIdForTenant(id: string, tenantId: string | null): Promise<Message | null> {
    return prisma.message.findFirst({
      where: { id, conversation: { tenantId } },
    })
  }

  async archive(id: string): Promise<Conversation> {
    return prisma.conversation.update({
      where: { id },
      data: { status: 'archived' },
    })
  }

  async deleteMessageContent(messageId: string): Promise<Message> {
    return prisma.message.update({
      where: { id: messageId },
      data: {
        contentRef: null,
        contentDeletedAt: new Date(),
      },
    })
  }

  async deleteConversationContent(conversationId: string): Promise<Message[]> {
    return prisma.$transaction(async (tx) => {
      const messages = await tx.message.findMany({
        where: {
          conversationId,
          contentDeletedAt: null,
          contentRef: { not: null },
        },
        orderBy: { seq: 'asc' },
      })
      if (messages.length === 0) return []

      const now = new Date()
      await tx.message.updateMany({
        where: { id: { in: messages.map((message) => message.id) } },
        data: { contentRef: null, contentDeletedAt: now },
      })

      return tx.message.findMany({
        where: { id: { in: messages.map((message) => message.id) } },
        orderBy: { seq: 'asc' },
      })
    })
  }

  async linkMessageToTicket(messageId: string, ticketId: string): Promise<Message> {
    return prisma.message.update({
      where: { id: messageId },
      data: { ticketRefId: ticketId },
    })
  }

  async setMessageAuditEventRef(messageId: string, auditEventRef: string): Promise<Message> {
    return prisma.message.update({
      where: { id: messageId },
      data: { auditEventRef },
    })
  }

  async findRetentionPolicy(id: string): Promise<RetentionPolicy | null> {
    return prisma.retentionPolicy.findUnique({ where: { id } })
  }

  async retentionSweep(
    now: Date,
    limit?: number,
  ): Promise<{
    sweptCount: number
    deletedCount: number
    conversationIds: string[]
  }> {
    return prisma.$transaction(async (tx) => {
      const conversations = await tx.conversation.findMany({
        where: {
          legalHold: false,
          retainUntil: { lte: now },
          messages: {
            some: {
              contentDeletedAt: null,
              contentRef: { not: null },
            },
          },
        },
        orderBy: { retainUntil: 'asc' },
        take: clampLimit(limit),
        select: { id: true },
      })

      if (conversations.length === 0) {
        return { sweptCount: 0, deletedCount: 0, conversationIds: [] }
      }

      const conversationIds = conversations.map((conversation) => conversation.id)
      const result = await tx.message.updateMany({
        where: {
          conversationId: { in: conversationIds },
          contentDeletedAt: null,
          contentRef: { not: null },
        },
        data: { contentRef: null, contentDeletedAt: now },
      })

      await tx.conversationPrivacyKey.deleteMany({
        where: { conversationId: { in: conversationIds } },
      })

      return {
        sweptCount: conversations.length,
        deletedCount: result.count,
        conversationIds,
      }
    })
  }
}

export { decodeContent, encodeContent, hashContent }
