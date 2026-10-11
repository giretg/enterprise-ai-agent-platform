import type { AgentDefinitionVersion, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AgentDefinitionRepository } from '../interfaces'

export class PostgresAgentDefinitionRepository implements AgentDefinitionRepository {
  async publish(input: {
    agentId: string
    snapshot: Prisma.InputJsonValue
    contentHash: string
    publishedById: string
  }) {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM agents WHERE id = ${input.agentId}::uuid FOR UPDATE`
      const agent = await tx.agent.findUnique({ where: { id: input.agentId } })
      if (!agent) throw new Error('Agent not found')
      if (agent.status === 'suspended' || agent.status === 'retired') {
        throw new Error(`Cannot publish agent in status ${agent.status}`)
      }
      const latest = await tx.agentDefinitionVersion.aggregate({
        where: { agentId: input.agentId },
        _max: { version: true },
      })
      const version = await tx.agentDefinitionVersion.create({
        data: { ...input, version: (latest._max.version ?? 0) + 1 },
      })
      const updated = await tx.agent.update({
        where: { id: input.agentId },
        data: { currentDefinitionVersionId: version.id },
      })
      return { agent: updated, version }
    })
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
}
