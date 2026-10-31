import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import type { CustomerPromiseInsert, CustomerPromiseListInput, CustomerPromiseStore } from '@/domain/customer-promise/customer-promise-service'

export class PostgresCustomerPromiseRepository implements CustomerPromiseStore {
  async insertUnderLimit(input: CustomerPromiseInsert) {
    return prisma.$transaction(async (tx) => {
      // Per-agent row lock serializes count+insert, including concurrent owners.
      // Overdue rows do not count: nothing auto-closes them, and they must not block new promises.
      const agents = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM agents WHERE id = ${input.agentId}::uuid AND tenant_id = ${input.tenantId}::uuid FOR UPDATE`
      if (!agents.length) throw new Error('customer_promise_agent_not_found')
      const count = await tx.customerPromise.count({ where: { tenantId: input.tenantId, agentId: input.agentId, status: { in: ['open', 'claimed'] }, dueAt: { gte: new Date() } } })
      if (count >= 50) return null
      return tx.customerPromise.create({ data: input })
    })
  }

  findById(tenantId: string, id: string) {
    return prisma.customerPromise.findFirst({ where: { tenantId, id } })
  }

  async list(input: CustomerPromiseListInput, now: Date) {
    const where: Prisma.CustomerPromiseWhereInput = { tenantId: input.tenantId, ownerUserId: input.ownerUserId, agentId: input.agentId, status: input.status === 'active' ? { in: ['open', 'claimed'] } : input.status }
    if (input.due === 'overdue') { where.AND = [{ status: { in: ['open', 'claimed'] } }]; where.dueAt = { lt: now } }
    if (input.due === 'upcoming') where.dueAt = { gte: now }
    const take = input.limit ?? 50
    const skip = input.offset ?? 0
    const orderBy = [{ dueAt: 'asc' as const }, { id: 'asc' as const }]
    // Overdue-only / upcoming-only keep chronological order.
    if (input.due === 'overdue' || input.due === 'upcoming') {
      return prisma.customerPromise.findMany({ where, orderBy, take, skip })
    }
    // Default active (and history) lists: upcoming before overdue so an overdue backlog
    // cannot push live commitments off the MCP/briefing take:50 window after #672 harden.
    const upcomingWhere: Prisma.CustomerPromiseWhereInput = { ...where, dueAt: { gte: now } }
    const overdueWhere: Prisma.CustomerPromiseWhereInput = { ...where, dueAt: { lt: now } }
    const upcomingCount = await prisma.customerPromise.count({ where: upcomingWhere })
    if (skip < upcomingCount) {
      const upcoming = await prisma.customerPromise.findMany({ where: upcomingWhere, orderBy, take, skip })
      if (upcoming.length === take) return upcoming
      const overdue = await prisma.customerPromise.findMany({ where: overdueWhere, orderBy, take: take - upcoming.length, skip: 0 })
      return [...upcoming, ...overdue]
    }
    return prisma.customerPromise.findMany({ where: overdueWhere, orderBy, take, skip: skip - upcomingCount })
  }

  countUrgentForUser(tenantId: string, userId: string, until: Date) {
    return prisma.customerPromise.count({ where: { tenantId, ownerUserId: userId, status: { in: ['open', 'claimed'] }, dueAt: { lte: until } } })
  }

  async resolve(input: Parameters<CustomerPromiseStore['resolve']>[0]) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.customerPromise.updateMany({ where: { id: input.id, tenantId: input.tenantId, status: { in: ['open', 'claimed'] } }, data: { status: input.status, resolvedNote: input.note, resolvedAt: input.now } })
      return updated.count ? tx.customerPromise.findFirst({ where: { id: input.id, tenantId: input.tenantId } }) : null
    })
  }
}
