import type { ResourceGrant } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ResourceGrantRepository } from '../interfaces'

const VIEW_OR_OPERATE = ['view', 'operate'] as const

export class PostgresResourceGrantRepository implements ResourceGrantRepository {
  async findAgentGrant(input: {
    tenantId: string
    userId: string
    agentId: string
  }): Promise<ResourceGrant | null> {
    return prisma.resourceGrant.findFirst({
      where: {
        tenantId: input.tenantId,
        userId: input.userId,
        resourceType: 'agent',
        resourceId: input.agentId,
        accessLevel: { in: [...VIEW_OR_OPERATE] },
      },
    })
  }

  async listAgentGrantsForUser(input: {
    tenantId: string
    userId: string
  }): Promise<ResourceGrant[]> {
    return prisma.resourceGrant.findMany({
      where: {
        tenantId: input.tenantId,
        userId: input.userId,
        resourceType: 'agent',
        accessLevel: { in: [...VIEW_OR_OPERATE] },
      },
    })
  }

  async listAgentIdsGrantedToUser(input: {
    tenantId: string
    userId: string
  }): Promise<string[]> {
    const rows = await this.listAgentGrantsForUser(input)
    return [...new Set(rows.map((row) => row.resourceId))]
  }
}
