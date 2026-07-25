import { Prisma } from '@prisma/client'
import type { Ticket, TicketTransition } from '@prisma/client'
import { notifyTicketReady } from '@/lib/dispatch-notify'
import { prisma } from '@/lib/db'
import { resolveTicketSource } from '@/lib/ticket-source'
import type {
  AppendTicketCommentInput,
  TicketCommentWithAttachments,
  TicketFilter,
  TicketRepository,
} from '../interfaces'

const MAX_COMMENT_APPEND_RETRIES = 3

function isUniqueCollision(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export class PostgresTicketRepository implements TicketRepository {
  async findMany(filter?: TicketFilter): Promise<Ticket[]> {
    const where: Prisma.TicketWhereInput = {}
    if (filter && 'tenantId' in filter) where.tenantId = filter.tenantId
    if (filter?.state) {
      where.state = Array.isArray(filter.state) ? { in: filter.state } : filter.state
    }
    if (filter?.type) where.type = filter.type
    if (filter?.agentId) where.agentId = filter.agentId
    if (filter?.processInstanceId) where.processInstanceId = filter.processInstanceId
    if (filter?.source) {
      where.source = Array.isArray(filter.source) ? { in: filter.source } : filter.source
    } else if (filter?.excludeTest) {
      where.source = { not: 'test' }
    }

    return prisma.ticket.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    })
  }

  async findById(id: string): Promise<Ticket | null> {
    return prisma.ticket.findUnique({ where: { id } })
  }

  async findReadyForDispatch(now: Date, limit: number): Promise<Ticket[]> {
    // Prisma JSON-path filter NULL bug: `NOT { payload: { path: ['delegationReturned'], equals: true } }`
    // generál: `payload #>> '{delegationReturned}' = 'true'` → NULL ha a mező hiányzik → `NOT NULL` = NULL (falsy)
    // → kizárja azokat a ticketeket, ahol a mező nem létezik.
    // Fix: raw SQL csak az ID-szűréshez (helyes @> containment); majd findMany a típusos objektumokhoz.
    const ids = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM tickets
      WHERE state = 'ready'
        AND source != 'test'
        AND lock_token IS NULL
        AND (execute_after IS NULL OR execute_after <= ${now})
        AND agent_id IS NOT NULL
        AND NOT (payload @> '{"delegationReturned": true}')
      ORDER BY updated_at ASC
      LIMIT ${limit}
    `
    if (ids.length === 0) return []
    return prisma.ticket.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      orderBy: { updatedAt: 'asc' },
    })
  }

  async findStaleInProgressDispatches(cutoff: Date, limit: number): Promise<Ticket[]> {
    return prisma.ticket.findMany({
      where: {
        state: 'in_progress',
        source: { not: 'test' },
        lockToken: { not: null },
        lockedAt: { lte: cutoff },
      },
      orderBy: { lockedAt: 'asc' },
      take: limit,
    })
  }

  async create(
    data: Omit<
      Ticket,
      | 'id'
      | 'createdAt'
      | 'updatedAt'
      | 'tenantId'
      | 'lockToken'
      | 'lockedAt'
      | 'playbookRef'
      | 'conversationId'
      | 'source'
      | 'processInstanceId'
      | 'playbookVersionId'
      | 'playbookStepId'
      | 'requiredGateId'
      | 'cancelRequested'
      | 'cancelRequestedById'
      | 'cancelRequestedAt'
    > &
      Partial<
        Pick<
          Ticket,
          | 'tenantId'
          | 'lockToken'
          | 'lockedAt'
          | 'playbookRef'
          | 'conversationId'
          | 'source'
          | 'processInstanceId'
          | 'playbookVersionId'
          | 'playbookStepId'
          | 'requiredGateId'
          | 'cancelRequested'
          | 'cancelRequestedById'
          | 'cancelRequestedAt'
        >
      >,
  ): Promise<Ticket> {
    const ticket = await prisma.ticket.create({
      data: {
        ...data,
        source: resolveTicketSource(data.source),
      } as Prisma.TicketUncheckedCreateInput,
    })
    if (ticket.state === 'ready') await notifyTicketReady(ticket.id)
    return ticket
  }

  async update(
    id: string,
    data: Partial<
      Pick<
        Ticket,
        | 'state'
        | 'payload'
        | 'assigneeType'
        | 'assigneeId'
        | 'agentId'
        | 'lockToken'
        | 'lockedAt'
        | 'playbookRef'
        | 'conversationId'
        | 'processInstanceId'
        | 'playbookVersionId'
        | 'playbookStepId'
        | 'requiredGateId'
        | 'cancelRequested'
        | 'cancelRequestedById'
        | 'cancelRequestedAt'
      >
    >,
  ): Promise<Ticket> {
    const ticket = await prisma.ticket.update({
      where: { id },
      data: data as Prisma.TicketUpdateInput,
    })
    if (data.state === 'ready') await notifyTicketReady(ticket.id)
    return ticket
  }

  async requestCancel(id: string, byUserId: string, now: Date = new Date()): Promise<Ticket | null> {
    const result = await prisma.ticket.updateMany({
      where: { id, state: 'in_progress' },
      data: {
        cancelRequested: true,
        cancelRequestedById: byUserId,
        cancelRequestedAt: now,
      },
    })
    if (result.count !== 1) return null
    return this.findById(id)
  }

  async isCancelRequested(id: string): Promise<boolean> {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      select: { cancelRequested: true, state: true },
    })
    return Boolean(ticket?.cancelRequested && ticket.state === 'in_progress')
  }

  async acquireDispatchLock(id: string, lockToken: string, now: Date): Promise<Ticket | null> {
    const result = await prisma.ticket.updateMany({
      where: { id, state: 'ready', lockToken: null },
      data: {
        lockToken,
        lockedAt: now,
        cancelRequested: false,
        cancelRequestedById: null,
        cancelRequestedAt: null,
      },
    })
    if (result.count !== 1) return null
    return this.findById(id)
  }

  async releaseDispatchLock(id: string, lockToken: string): Promise<void> {
    await prisma.ticket.updateMany({
      where: { id, lockToken },
      data: { lockToken: null, lockedAt: null },
    })
  }

  async completeDispatchLock(id: string, lockToken: string): Promise<Ticket | null> {
    const result = await prisma.ticket.updateMany({
      where: { id, lockToken },
      data: { lockToken: null, lockedAt: null },
    })
    if (result.count !== 1) return null
    return this.findById(id)
  }

  async recordTransition(
    data: Omit<TicketTransition, 'id' | 'ts'>,
  ): Promise<TicketTransition> {
    return prisma.ticketTransition.create({ data })
  }

  async findTransitions(ticketId: string): Promise<TicketTransition[]> {
    return prisma.ticketTransition.findMany({
      where: { ticketId },
      orderBy: { ts: 'asc' },
    })
  }

  async appendComment(data: AppendTicketCommentInput): Promise<TicketCommentWithAttachments> {
    if ((data.attachments?.length ?? 0) > 8) throw new Error('Too many attachments')

    for (let attempt = 0; attempt < MAX_COMMENT_APPEND_RETRIES; attempt += 1) {
      try {
        return await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${data.ticketId}))`

          const last = await tx.ticketComment.findFirst({
            where: { ticketId: data.ticketId },
            orderBy: { seq: 'desc' },
            select: { seq: true },
          })
          const seq = (last?.seq ?? 0) + 1

          const comment = await tx.ticketComment.create({
            data: {
              ticketId: data.ticketId,
              seq,
              kind: data.kind,
              authorType: data.authorType,
              authorUserId: data.authorUserId ?? null,
              authorAgentId: data.authorAgentId ?? null,
              authorDisplayName: data.authorDisplayName ?? null,
              agentVersion: data.agentVersion ?? null,
              body: data.body,
              structured: data.structured ?? undefined,
              parentId: data.parentId ?? null,
              transitionId: data.transitionId ?? null,
              attachments: data.attachments?.length
                ? {
                    create: data.attachments.map((attachment, index) => ({
                      documentId: attachment.documentId,
                      seq: index + 1,
                      kind: attachment.kind,
                      filename: attachment.filename,
                      mimeType: attachment.mimeType ?? null,
                      byteSize: attachment.byteSize ?? null,
                    })),
                  }
                : undefined,
            },
            include: { attachments: { include: { document: true }, orderBy: { seq: 'asc' } } },
          })

          return comment
        })
      } catch (error) {
        if (isUniqueCollision(error) && attempt < MAX_COMMENT_APPEND_RETRIES - 1) continue
        throw error
      }
    }

    throw new Error('Failed to append ticket comment')
  }

  async listComments(ticketId: string): Promise<TicketCommentWithAttachments[]> {
    return prisma.ticketComment.findMany({
      where: { ticketId },
      orderBy: { seq: 'asc' },
      include: { attachments: { include: { document: true }, orderBy: { seq: 'asc' } } },
    })
  }

  async getTransitionStats(since?: Date) {
    const where = since ? { ts: { gte: since } } : undefined
    const [total, byActor, byState] = await Promise.all([
      prisma.ticketTransition.count({ where }),
      prisma.ticketTransition.groupBy({
        by: ['actorType'],
        where,
        _count: { _all: true },
      }),
      prisma.ticketTransition.groupBy({
        by: ['toState'],
        where,
        _count: { _all: true },
      }),
    ])

    const actorCounts = Object.fromEntries(
      byActor.map((row) => [row.actorType, row._count._all]),
    ) as Record<string, number>
    const stateCounts = Object.fromEntries(
      byState.map((row) => [row.toState, row._count._all]),
    ) as Record<string, number>

    return {
      total,
      byActor: {
        human: actorCounts.human ?? 0,
        agent: actorCounts.agent ?? 0,
        system: actorCounts.system ?? 0,
      },
      toApproved: stateCounts.approved ?? 0,
      toRejected: stateCounts.rejected ?? 0,
      toDone: stateCounts.done ?? 0,
    }
  }
}
