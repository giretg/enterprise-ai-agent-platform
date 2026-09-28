import { prisma } from '@/lib/db'
import type { HandoffRecord, HandoffStore } from '@/domain/handoff/handoff-service'
import type { HandoffStatus } from '@prisma/client'

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
  }): Promise<HandoffRecord> {
    const row = await prisma.handoff.create({ data: input })
    return mapRow(row)
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

  async decide(input: {
    id: string
    expectedStatus: Extract<HandoffStatus, 'open' | 'accepted'>
    status: Extract<HandoffStatus, 'accepted' | 'done' | 'rejected'>
    decidedById: string
  }): Promise<HandoffRecord | null> {
    if (input.expectedStatus === 'accepted' && input.status === 'accepted') return null
    const updated = await prisma.handoff.updateMany({
      where: { id: input.id, status: input.expectedStatus },
      data: { status: input.status, decidedById: input.decidedById, decidedAt: new Date() },
    })
    if (updated.count !== 1) return null
    return this.findById(input.id)
  }
}
