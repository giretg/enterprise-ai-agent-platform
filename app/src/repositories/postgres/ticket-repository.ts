import { Prisma } from '@prisma/client'
import type { Ticket, TicketState, TicketTransition } from '@prisma/client'
import { notifyTicketReady } from '@/lib/dispatch-notify'
import { prisma } from '@/lib/db'
import { prismaPageArgs, toListPage } from '@/lib/list-pagination'
import { UNSTARTED_DELETABLE_STATES } from '@/lib/ticket-display'
import { resolveTicketSource } from '@/lib/ticket-source'
import type {
  AppendTicketCommentInput,
  CreateTicketAttachmentInput,
  ListPageResult,
  TicketCommentWithAttachments,
  TicketFilter,
  TicketRepository,
} from '../interfaces'

const MAX_COMMENT_APPEND_RETRIES = 3

function isUniqueCollision(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function buildTicketCommentCreateData(data: AppendTicketCommentInput, seq: number) {
  if ((data.attachments?.length ?? 0) > 8) throw new Error('Too many attachments')
  return {
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
  }
}

function ticketWhere(filter?: TicketFilter): Prisma.TicketWhereInput {
  const where: Prisma.TicketWhereInput = {}
  if (filter && 'tenantId' in filter) where.tenantId = filter.tenantId
  if (filter?.state) {
    where.state = Array.isArray(filter.state) ? { in: filter.state } : filter.state
  }
  if (filter?.type) where.type = filter.type
  if (filter?.agentId && !filter.involvedAgentId) where.agentId = filter.agentId
  if (filter?.processInstanceId) where.processInstanceId = filter.processInstanceId
  if (filter?.source) {
    where.source = Array.isArray(filter.source) ? { in: filter.source } : filter.source
  } else if (filter?.excludeTest) {
    where.source = { not: 'test' }
  }
  if (filter?.createdById) where.createdById = filter.createdById
  if (filter?.belongingToUserId) {
    where.OR = [
      { createdById: filter.belongingToUserId },
      { assigneeType: 'human', assigneeId: filter.belongingToUserId },
    ]
  }
  if (filter?.involvedAgentId) {
    const id = filter.involvedAgentId
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        OR: [
          { agentId: id },
          { assigneeType: 'agent', assigneeId: id },
          { payload: { path: ['createdByAgentId'], equals: id } },
          { payload: { path: ['requesterAgentId'], equals: id } },
        ],
      },
    ]
  }
  if (filter?.updatedAtGte || filter?.updatedAtLte) {
    where.updatedAt = {
      ...(filter.updatedAtGte ? { gte: filter.updatedAtGte } : {}),
      ...(filter.updatedAtLte ? { lte: filter.updatedAtLte } : {}),
    }
  }
  return where
}

export class PostgresTicketRepository implements TicketRepository {
  async findMany(filter?: TicketFilter): Promise<Ticket[]> {
    const page = await this.listPage(
      filter?.limit !== undefined || filter?.offset !== undefined || filter?.unbounded
        ? filter
        : { ...filter, unbounded: true },
    )
    return page.items
  }

  async listPage(filter?: TicketFilter): Promise<ListPageResult<Ticket>> {
    const { take, skip, pageLimit } = prismaPageArgs(filter)
    const offset = skip ?? 0
    const rows = await prisma.ticket.findMany({
      where: ticketWhere(filter),
      orderBy: { updatedAt: 'desc' },
      ...(take !== undefined ? { take, skip: offset } : {}),
    })
    return toListPage(rows, pageLimit, offset)
  }

  async count(filter?: TicketFilter): Promise<number> {
    return prisma.ticket.count({ where: ticketWhere(filter) })
  }

  async findById(id: string): Promise<Ticket | null> {
    return prisma.ticket.findUnique({ where: { id } })
  }

  async findReadyForDispatch(now: Date, limit: number): Promise<Ticket[]> {
    // Prisma JSON-path filter NULL bug: `NOT { payload: { path: ['delegationReturned'], equals: true } }`
    // generál: `payload #>> '{delegationReturned}' = 'true'` → NULL ha a mező hiányzik → `NOT NULL` = NULL (falsy)
    // → kizárja azokat a ticketeket, ahol a mező nem létezik.
    // Fix: raw SQL csak az ID-szűréshez (helyes @> containment); majd findMany a típusos objektumokhoz.
    // `scheduleSeries`: a rendszeres sablon nem dispatchelődik, még ha az executeAfter
    // már elmúlt is — a worker új példányt materializál helyette.
    const ids = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM tickets
      WHERE state = 'ready'
        AND source != 'test'
        AND lock_token IS NULL
        AND (execute_after IS NULL OR execute_after <= ${now})
        AND agent_id IS NOT NULL
        AND NOT (payload @> '{"delegationReturned": true}')
        AND NOT (payload @> '{"scheduleSeries": true}')
      ORDER BY updated_at ASC
      LIMIT ${limit}
    `
    if (ids.length === 0) return []
    return prisma.ticket.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      orderBy: { updatedAt: 'asc' },
    })
  }

  /**
   * Megválaszolt, de a beszélgetésben MÉG NEM megjelenített delegációk. Ezekre
   * azért van szükség, mert a delegált válasz ma egy `done` ticketben landol, és
   * ha a hívó fordulója közben lejárt (deadline) vagy a diszpécser futtatta le,
   * a felhasználó soha nem látja meg — a kérdésére csend a válasz.
   *
   * A `@>` containment szándékos: a Prisma JSON-path szűrője hiányzó mezőnél
   * NULL-t ad, és a tagadása kizárná a még nem jelölt sorokat is (l. a
   * `findReadyForDispatch` fölötti megjegyzést).
   */
  async listReturnedDelegationsForConversation(conversationId: string): Promise<Ticket[]> {
    const ids = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM tickets
      WHERE payload @> '{"delegation": true, "delegationReturned": true}'
        AND payload ->> 'conversationId' = ${conversationId}
        AND NOT (payload @> '{"delegationSurfaced": true}')
      ORDER BY updated_at ASC
      LIMIT 20
    `
    if (ids.length === 0) return []
    return prisma.ticket.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      orderBy: { updatedAt: 'asc' },
    })
  }

  /** Idempotens jelölés: a delegált válasz megjelent a felhasználó előtt. */
  async markDelegationSurfaced(ticketId: string): Promise<void> {
    await prisma.$executeRaw`
      UPDATE tickets
      SET payload = payload || '{"delegationSurfaced": true}'::jsonb
      WHERE id = ${ticketId}::uuid
        AND jsonb_typeof(payload) = 'object'
    `
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
    data: Parameters<TicketRepository['create']>[0],
    options?: { attachments?: CreateTicketAttachmentInput[] },
  ): Promise<Ticket> {
    const { initialComment, ...ticketData } = data
    const attachments = options?.attachments ?? []
    if (attachments.length > 8) throw new Error('Too many ticket attachments')

    const ticket = await prisma.$transaction(async (tx) => {
      const created = await tx.ticket.create({
        data: {
          ...ticketData,
          source: resolveTicketSource(ticketData.source),
          attachments: attachments.length
            ? {
                create: attachments.map((attachment, index) => ({
                  documentId: attachment.documentId,
                  seq: index + 1,
                  filename: attachment.filename,
                  mimeType: attachment.mimeType ?? null,
                  byteSize: attachment.byteSize ?? null,
                })),
              }
            : undefined,
        } as Prisma.TicketUncheckedCreateInput,
      })

      if (initialComment) {
        await tx.ticketComment.create({
          data: buildTicketCommentCreateData({ ticketId: created.id, ...initialComment }, 1),
        })
      }

      return created
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
        | 'title'
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
        | 'executeAfter'
        | 'projectKey'
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

  /**
   * Compare-and-set a Playbook state machine-hez. A `where state = currentState` feltétel
   * egyetlen adatbázis-műveletben zárja le azt az ablakot, amikor két jóváhagyó ugyanazt a
   * még nyitott ticketet próbálja eldönteni.
   */
  async updateIfCurrentState(
    id: string,
    currentState: TicketState,
    data: Parameters<TicketRepository['update']>[1],
  ): Promise<Ticket | null> {
    const ticket = await prisma.$transaction(async (tx) => {
      const result = await tx.ticket.updateMany({
        where: { id, state: currentState },
        data: data as Prisma.TicketUpdateManyMutationInput,
      })
      if (result.count !== 1) return null
      return tx.ticket.findUnique({ where: { id } })
    })
    if (ticket && data.state === 'ready') await notifyTicketReady(ticket.id)
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
            data: buildTicketCommentCreateData(data, seq),
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

  async deleteTicket(id: string, options?: { force?: boolean }): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.findUnique({ where: { id } })
      if (!ticket) throw new Error('Ticket not found')
      if (!options?.force) {
        if (
          !UNSTARTED_DELETABLE_STATES.includes(
            ticket.state as (typeof UNSTARTED_DELETABLE_STATES)[number],
          )
        ) {
          throw new Error('A feladat feldolgozása már elkezdődött — törlés nem lehetséges')
        }
        if (ticket.lockToken) {
          throw new Error('A feladat éppen feldolgozás alatt van')
        }
      }

      await tx.message.updateMany({ where: { ticketRefId: id }, data: { ticketRefId: null } })
      await tx.scheduledTask.updateMany({
        where: { materializedTicketId: id },
        data: { materializedTicketId: null, materializedAt: null },
      })
      await tx.memoryCandidate.updateMany({ where: { ticketId: id }, data: { ticketId: null } })
      await tx.sandboxAppVersion.updateMany({ where: { sourceTicketId: id }, data: { sourceTicketId: null } })
      // Költség-elszámolás / tool-nyom: a sorok megmaradnak, csak a ticket FK oldódik.
      await tx.modelCall.updateMany({ where: { ticketId: id }, data: { ticketId: null } })
      await tx.toolCall.updateMany({ where: { ticketId: id }, data: { ticketId: null } })

      await tx.ticket.delete({ where: { id } })
    })
  }
}
