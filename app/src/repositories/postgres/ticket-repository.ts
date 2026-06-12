import type { Prisma, Ticket } from '@prisma/client'
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

  async create(data: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt'>): Promise<Ticket> {
    return prisma.ticket.create({ data: data as Prisma.TicketUncheckedCreateInput })
  }

  async update(
    id: string,
    data: Partial<Pick<Ticket, 'state' | 'payload' | 'assigneeType' | 'assigneeId'>>,
  ): Promise<Ticket> {
    return prisma.ticket.update({
      where: { id },
      data: data as Prisma.TicketUpdateInput,
    })
  }
}
