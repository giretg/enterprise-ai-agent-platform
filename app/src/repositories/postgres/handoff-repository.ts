import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { HandoffRecord, HandoffStore } from '@/domain/handoff/handoff-service'
import type { HandoffStatus } from '@prisma/client'

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function mapRow(row: {
  id: string
  tenantId: string
  fromAgentId: string
  fromDefinitionId: string
  toAgentId: string | null
  toUserId: string | null
  projectKey: string
  title: string
  summary: string
  links: string | null
  status: HandoffStatus
  memoryId: string | null
  createdById: string
  decidedById: string | null
  decidedAt: Date | null
  createdAt: Date
}): HandoffRecord {
  return row
}

export class PostgresHandoffRepository implements HandoffStore {
  async insert(input: {
    tenantId: string
    fromAgentId: string
    fromDefinitionId: string
    toAgentId: string | null
    toUserId: string | null
    projectKey: string
    title: string
    summary: string
    links: string | null
    createdById: string
    idempotencyKey?: string | null
  }): Promise<{ handoff: HandoffRecord; created: boolean }> {
    const idempotencyKey = input.idempotencyKey ?? null
    try {
      const row = await prisma.handoff.create({ data: { ...input, idempotencyKey } })
      return { handoff: mapRow(row), created: true }
    } catch (error) {
      // #940: a (tenant, from_agent, idempotency_key) unique-ütközés egy párhuzamos
      // vagy ismételt, azonos kulcsú hívást jelez — a meglévő átadást adjuk vissza,
      // így a hívó nem duplikálja a mellékhatásokat (memória-injektálás, audit).
      if (!idempotencyKey || !isUniqueViolation(error)) throw error
      const existing = await prisma.handoff.findFirst({
        where: { tenantId: input.tenantId, fromAgentId: input.fromAgentId, idempotencyKey },
      })
      if (!existing) throw error
      return { handoff: mapRow(existing), created: false }
    }
  }

  async findById(id: string): Promise<HandoffRecord | null> {
    const row = await prisma.handoff.findUnique({ where: { id } })
    return row ? mapRow(row) : null
  }

  async listOpenForAgent(tenantId: string, agentId: string, limit = 10): Promise<HandoffRecord[]> {
    const rows = await prisma.handoff.findMany({
      where: { tenantId, toAgentId: agentId, status: 'open' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return rows.map(mapRow)
  }

  async listOpenForUser(tenantId: string, userId: string): Promise<HandoffRecord[]> {
    const rows = await prisma.handoff.findMany({
      where: { tenantId, toUserId: userId, status: { in: ['open', 'accepted'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    return rows.map(mapRow)
  }

  async attachMemory(id: string, memoryId: string): Promise<void> {
    await prisma.handoff.update({ where: { id }, data: { memoryId } })
  }

  async decide(id: string, status: Extract<HandoffStatus, 'accepted' | 'done' | 'rejected'>, decidedById: string): Promise<HandoffRecord | null> {
    const [row] = await prisma.handoff.updateManyAndReturn({
      where: { id, status: { in: ['open', 'accepted'] } },
      data: { status, decidedById, decidedAt: new Date() },
    })
    return row ? mapRow(row) : null
  }
}
