import type { Prisma, Ticket, TicketTransition } from '@prisma/client'
import { notifyTicketReady } from '@/lib/dispatch-notify'
import { prisma } from '@/lib/db'
import type { TicketFilter, TicketRepository } from '../interfaces'

export class PostgresTicketRepository implements TicketRepository {
  async findMany(filter?: TicketFilter): Promise<Ticket[]> {
    const where: Prisma.TicketWhereInput = {}
    if (filter?.state) {
      where.state = Array.isArray(filter.state) ? { in: filter.state } : filter.state
    }
    if (filter?.type) where.type = filter.type
    if (filter?.agentId) where.agentId = filter.agentId

    return prisma.ticket.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    })
  }

  async findById(id: string): Promise<Ticket | null> {
    return prisma.ticket.findUnique({ where: { id } })
  }

  async findReadyForDispatch(now: Date, limit: number): Promise<Ticket[]> {
    return prisma.ticket.findMany({
      where: {
        state: 'ready',
        lockToken: null,
        OR: [{ executeAfter: null }, { executeAfter: { lte: now } }],
        agentId: { not: null },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    })
  }

  async findStaleInProgressDispatches(cutoff: Date, limit: number): Promise<Ticket[]> {
    return prisma.ticket.findMany({
      where: {
        state: 'in_progress',
        lockToken: { not: null },
        lockedAt: { lte: cutoff },
      },
      orderBy: { lockedAt: 'asc' },
      take: limit,
    })
  }

  async create(
    data: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'lockToken' | 'lockedAt'> &
      Partial<Pick<Ticket, 'lockToken' | 'lockedAt'>>,
  ): Promise<Ticket> {
    const ticket = await prisma.ticket.create({ data: data as Prisma.TicketUncheckedCreateInput })
    if (ticket.state === 'ready') await notifyTicketReady(ticket.id)
    return ticket
  }

  async update(
    id: string,
    data: Partial<
      Pick<Ticket, 'state' | 'payload' | 'assigneeType' | 'assigneeId' | 'lockToken' | 'lockedAt'>
    >,
  ): Promise<Ticket> {
    const ticket = await prisma.ticket.update({
      where: { id },
      data: data as Prisma.TicketUpdateInput,
    })
    if (data.state === 'ready') await notifyTicketReady(ticket.id)
    return ticket
  }

  async acquireDispatchLock(id: string, lockToken: string, now: Date): Promise<Ticket | null> {
    const result = await prisma.ticket.updateMany({
      where: { id, state: 'ready', lockToken: null },
      data: { lockToken, lockedAt: now },
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

  async getTransitionStats(since?: Date) {
    const rows = await prisma.ticketTransition.findMany({
      where: since ? { ts: { gte: since } } : undefined,
      select: { toState: true, actorType: true },
    })

    const stats = {
      total: rows.length,
      byActor: { human: 0, agent: 0, system: 0 },
      toApproved: 0,
      toRejected: 0,
      toDone: 0,
    }
    for (const row of rows) {
      stats.byActor[row.actorType] += 1
      if (row.toState === 'approved') stats.toApproved += 1
      else if (row.toState === 'rejected') stats.toRejected += 1
      else if (row.toState === 'done') stats.toDone += 1
    }
    return stats
  }
}
