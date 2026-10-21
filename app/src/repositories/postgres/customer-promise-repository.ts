import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import type { CustomerPromiseInsert, CustomerPromiseListInput, CustomerPromiseStore } from '@/domain/customer-promise/customer-promise-service'

export class PostgresCustomerPromiseRepository implements CustomerPromiseStore {
  async insertUnderLimit(input: CustomerPromiseInsert) {
    return prisma.$transaction(async (tx) => {
      // Per-agent row lock serializes count+insert, including concurrent owners.
      const agents = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM agents WHERE id = ${input.agentId}::uuid AND tenant_id = ${input.tenantId}::uuid FOR UPDATE`
      if (!agents.length) throw new Error('customer_promise_agent_not_found')
      const count = await tx.customerPromise.count({ where: { tenantId: input.tenantId, agentId: input.agentId, status: { in: ['open', 'claimed'] } } })
      if (count >= 50) return null
      return tx.customerPromise.create({ data: input })
    })
  }

  findById(tenantId: string, id: string) {
    return prisma.customerPromise.findFirst({ where: { tenantId, id } })
  }

  list(input: CustomerPromiseListInput, now: Date) {
    const where: Prisma.CustomerPromiseWhereInput = { tenantId: input.tenantId, ownerUserId: input.ownerUserId, agentId: input.agentId, status: input.status === 'active' ? { in: ['open', 'claimed'] } : input.status }
    if (input.due === 'overdue') { where.AND = [{ status: 'open' }]; where.dueAt = { lt: now } }
    if (input.due === 'upcoming') where.dueAt = { gte: now }
    return prisma.customerPromise.findMany({ where, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: input.limit ?? 50, skip: input.offset ?? 0 })
  }

  countUrgentForUser(tenantId: string, userId: string, until: Date) {
    return prisma.customerPromise.count({ where: { tenantId, ownerUserId: userId, status: 'open', dueAt: { lte: until } } })
  }

  async resolve(input: Parameters<CustomerPromiseStore['resolve']>[0]) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.customerPromise.updateMany({ where: { id: input.id, tenantId: input.tenantId, status: { in: ['open', 'claimed'] } }, data: { status: input.status, resolvedNote: input.note, resolvedAt: input.now } })
      return updated.count ? tx.customerPromise.findFirst({ where: { id: input.id, tenantId: input.tenantId } }) : null
    })
  }
}
