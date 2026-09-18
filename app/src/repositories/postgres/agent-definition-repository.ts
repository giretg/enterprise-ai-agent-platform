import type { AgentDefinitionVersion, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AgentDefinitionRepository } from '../interfaces'

export class PostgresAgentDefinitionRepository implements AgentDefinitionRepository {
  async create(data: {
    agentId: string
    version: number
    snapshot: Prisma.InputJsonValue
    contentHash: string
    publishedById: string
  }): Promise<AgentDefinitionVersion> {
    return prisma.agentDefinitionVersion.create({ data })
  }

  async findById(id: string): Promise<AgentDefinitionVersion | null> {
    return prisma.agentDefinitionVersion.findUnique({ where: { id } })
  }

  async findByAgentAndVersion(
    agentId: string,
    version: number,
  ): Promise<AgentDefinitionVersion | null> {
    return prisma.agentDefinitionVersion.findUnique({
      where: { agentId_version: { agentId, version } },
    })
  }

  async findMaxVersion(agentId: string): Promise<number> {
    const row = await prisma.agentDefinitionVersion.aggregate({
      where: { agentId },
      _max: { version: true },
    })
    return row._max.version ?? 0
  }
}
