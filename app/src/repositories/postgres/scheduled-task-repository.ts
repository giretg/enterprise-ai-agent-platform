import type {
  Prisma,
  ScheduledTask,
  ScheduledTaskKind,
  ScheduledTaskRecurrence,
  ScheduledTaskStatus,
  Ticket,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import { DISPATCH_NOTIFY_CHANNEL } from '@/lib/dispatch-notify'
import { resolveTicketSource } from '@/lib/ticket-source'
import type { ScheduledTaskRepository } from '../interfaces'

export class PostgresScheduledTaskRepository implements ScheduledTaskRepository {
  async findMany(filter?: {
    tenantId?: string | null
    agentId?: string
    limit?: number
  }): Promise<ScheduledTask[]> {
    const where: Prisma.ScheduledTaskWhereInput = {}
    if (filter && 'tenantId' in filter) where.tenantId = filter.tenantId
    if (filter?.agentId) where.agentId = filter.agentId

    return prisma.scheduledTask.findMany({
      where,
      orderBy: { nextRunAt: 'desc' },
      take: filter?.limit ?? 100,
    })
  }

  async findDue(now: Date, limit: number): Promise<ScheduledTask[]> {
    return prisma.scheduledTask.findMany({
      where: {
        status: 'active',
        nextRunAt: { lte: now },
      },
      orderBy: { nextRunAt: 'asc' },
      take: limit,
    })
  }

  async create(data: {
    tenantId: string | null
    kind?: ScheduledTaskKind
    title: string
    agentId: string
    createdById: string
    payload: Prisma.InputJsonValue
    runAsUserId?: string | null
    runAsAuthorizedAt?: Date | null
    runAsAuthorizedById?: string | null
    nextRunAt: Date
    recurrence?: ScheduledTaskRecurrence
    maxRuns?: number | null
    materializedTicketId?: string | null
  }): Promise<ScheduledTask> {
    return prisma.scheduledTask.create({
      data: {
        tenantId: data.tenantId,
        kind: data.kind ?? 'agent_task',
        title: data.title,
        agentId: data.agentId,
        createdById: data.createdById,
        payload: data.payload,
        runAsUserId: data.runAsUserId ?? null,
        runAsAuthorizedAt: data.runAsAuthorizedAt ?? null,
        runAsAuthorizedById: data.runAsAuthorizedById ?? null,
        nextRunAt: data.nextRunAt,
        recurrence: data.recurrence ?? 'none',
        maxRuns: data.maxRuns ?? null,
        materializedTicketId: data.materializedTicketId ?? null,
      },
    })
  }

  async claimDue(id: string, now: Date): Promise<ScheduledTask | null> {
    const updated = await prisma.scheduledTask.updateMany({
      where: {
        id,
        status: 'active',
        nextRunAt: { lte: now },
      },
      data: { status: 'materializing' },
    })
    if (updated.count !== 1) return null
    return this.findById(id)
  }

  async materializeTicket(
    id: string,
    ticket: Pick<
      Ticket,
      | 'tenantId'
      | 'type'
      | 'title'
      | 'state'
      | 'assigneeType'
      | 'assigneeId'
      | 'agentId'
      | 'sourceDocumentId'
      | 'conversationId'
      | 'executeAfter'
      | 'dueBy'
      | 'createdById'
      | 'source'
    > & { payload: Prisma.InputJsonValue },
    data: {
      status: ScheduledTaskStatus
      runCount: number
      lastRunAt: Date
      materializedAt: Date
      nextRunAt: Date
      payload?: Prisma.InputJsonValue
    },
  ): Promise<{ scheduledTask: ScheduledTask; ticket: Ticket } | null> {
    return prisma.$transaction(async (tx) => {
      // Sorzárat veszünk és újraellenőrizzük a claimet. Ha közben egy másik
      // worker visszavette a taskot, ticket sem jöhet létre.
      const locked = await tx.scheduledTask.updateMany({
        where: { id, status: 'materializing' },
        data: { status: 'materializing' },
      })
      if (locked.count !== 1) return null

      const materializedTicket = await tx.ticket.create({
        data: {
          ...ticket,
          source: resolveTicketSource(ticket.source),
        } as Prisma.TicketUncheckedCreateInput,
      })
      const scheduledTask = await tx.scheduledTask.update({
        where: { id },
        data: {
          status: data.status,
          materializedTicketId: materializedTicket.id,
          materializedAt: data.materializedAt,
          lastRunAt: data.lastRunAt,
          nextRunAt: data.nextRunAt,
          runCount: data.runCount,
          ...(data.payload !== undefined ? { payload: data.payload } : {}),
        },
      })

      // A PostgreSQL NOTIFY csak commit után kerül kézbesítésre, így a dispatcher
      // sosem láthat olyan ready ticketet, amelyhez nincs tartós task-állapot.
      await tx.$executeRaw`SELECT pg_notify(${DISPATCH_NOTIFY_CHANNEL}, ${materializedTicket.id})`
      return { scheduledTask, ticket: materializedTicket }
    })
  }

  async advanceExistingTicket(
    id: string,
    data: {
      status: ScheduledTaskStatus
      runCount: number
      lastRunAt: Date
      materializedAt: Date
      nextRunAt: Date
    },
  ): Promise<ScheduledTask | null> {
    const existing = await this.findById(id)
    if (!existing?.materializedTicketId) return null
    const ticketId = existing.materializedTicketId
    return prisma.$transaction(async (tx) => {
      const locked = await tx.scheduledTask.updateMany({
        where: { id, status: 'materializing' },
        data: {
          status: data.status,
          materializedAt: data.materializedAt,
          lastRunAt: data.lastRunAt,
          nextRunAt: data.nextRunAt,
          runCount: data.runCount,
        },
      })
      if (locked.count !== 1) return null
      await tx.$executeRaw`SELECT pg_notify(${DISPATCH_NOTIFY_CHANNEL}, ${ticketId})`
      return tx.scheduledTask.findUnique({ where: { id } })
    })
  }

  async linkBoardTicket(id: string, ticketId: string): Promise<ScheduledTask | null> {
    const updated = await prisma.scheduledTask.updateMany({
      where: { id, status: 'active', materializedTicketId: null },
      data: { materializedTicketId: ticketId },
    })
    if (updated.count !== 1) return null
    return this.findById(id)
  }

  async revoke(id: string): Promise<ScheduledTask | null> {
    const updated = await prisma.scheduledTask.updateMany({
      where: { id, status: { in: ['active', 'materializing', 'materialized'] } },
      data: { status: 'revoked' },
    })
    if (updated.count !== 1) return null
    return this.findById(id)
  }

  async findById(id: string): Promise<ScheduledTask | null> {
    return prisma.scheduledTask.findUnique({ where: { id } })
  }

  async findStaleMaterializing(cutoff: Date, limit: number): Promise<ScheduledTask[]> {
    return prisma.scheduledTask.findMany({
      where: {
        status: 'materializing',
        updatedAt: { lte: cutoff },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    })
  }

  async reclaimMaterializing(id: string): Promise<ScheduledTask | null> {
    const updated = await prisma.scheduledTask.updateMany({
      where: { id, status: 'materializing' },
      data: { status: 'active' },
    })
    if (updated.count !== 1) return null
    return this.findById(id)
  }
}
