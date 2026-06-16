import type { Prisma, Ticket, TicketTransition } from '@prisma/client'
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

  async create(
    data: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'lockToken' | 'lockedAt'> &
      Partial<Pick<Ticket, 'lockToken' | 'lockedAt'>>,
  ): Promise<Ticket> {
    return prisma.ticket.create({ data: data as Prisma.TicketUncheckedCreateInput })
  }

  async update(
    id: string,
    data: Partial<
      Pick<Ticket, 'state' | 'payload' | 'assigneeType' | 'assigneeId' | 'lockToken' | 'lockedAt'>
    >,
  ): Promise<Ticket> {
    return prisma.ticket.update({
      where: { id },
      data: data as Prisma.TicketUpdateInput,
    })
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
}
