import type { Agent, ConnectorAccessMode, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { assertTransition, isPhysicallyDeletable } from '@/lib/agent-lifecycle'
import { prismaPageArgs, toListPage } from '@/lib/list-pagination'
import type {
  AgentConnectorBinding,
  AgentListFilter,
  AgentRepository,
  ListPageResult,
} from '../interfaces'

function agentVisibilityWhere(id: string, tenantId?: string): Prisma.AgentWhereInput {
  return tenantId === undefined ? { id } : { id, tenantId }
}

function agentListWhere(filter?: AgentListFilter): Prisma.AgentWhereInput | undefined {
  const where: Prisma.AgentWhereInput = {}
  if (filter?.tenantId !== undefined) where.tenantId = filter.tenantId
  if (filter?.status) where.status = filter.status
  if (filter?.ids !== undefined) where.id = { in: filter.ids }
  return Object.keys(where).length > 0 ? where : undefined
}

export class PostgresAgentRepository implements AgentRepository {
  async findMany(filter?: AgentListFilter): Promise<Agent[]> {
    const page = await this.listPage(
      filter?.limit !== undefined || filter?.offset !== undefined || filter?.unbounded
        ? filter
        : { ...filter, unbounded: true },
    )
    return page.items
  }

  async listPage(filter?: AgentListFilter): Promise<ListPageResult<Agent>> {
    const { take, skip, pageLimit } = prismaPageArgs(filter)
    const offset = skip ?? 0
    const rows = await prisma.agent.findMany({
      where: agentListWhere(filter),
      orderBy: { createdAt: 'desc' },
      ...(take !== undefined ? { take, skip: offset } : {}),
    })
    return toListPage(rows, pageLimit, offset)
  }

  async count(filter?: { tenantId?: string; status?: Agent['status'] }): Promise<number> {
    const where: Prisma.AgentWhereInput = {}
    if (filter?.tenantId !== undefined) where.tenantId = filter.tenantId
    if (filter?.status) where.status = filter.status
    return prisma.agent.count({
      where: Object.keys(where).length > 0 ? where : undefined,
    })
  }

  async findById(id: string, tenantId?: string): Promise<Agent | null> {
    return prisma.agent.findFirst({ where: agentVisibilityWhere(id, tenantId) })
  }

  async create(input: {
    name: string
    roleInstruction: string
    tenantId: string
    status?: Agent['status']
  }): Promise<Agent> {
    return prisma.agent.create({
      data: {
        name: input.name,
        roleInstruction: input.roleInstruction,
        tenantId: input.tenantId,
        status: input.status ?? 'draft',
      },
    })
  }

  async updateInstruction(input: { agentId: string; roleInstruction: string }): Promise<Agent> {
    return prisma.agent.update({
      where: { id: input.agentId },
      data: { roleInstruction: input.roleInstruction },
    })
  }

  async updateProfile(input: {
    agentId: string
    name?: string
    description?: string | null
  }): Promise<Agent> {
    return prisma.agent.update({
      where: { id: input.agentId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    })
  }

  async updateAvatar(input: { agentId: string; avatarUrl: string }): Promise<Agent> {
    return prisma.agent.update({
      where: { id: input.agentId },
      data: { avatarUrl: input.avatarUrl },
    })
  }

  async setCurrentDefinitionVersionId(agentId: string, versionId: string): Promise<Agent> {
    return prisma.agent.update({
      where: { id: agentId },
      data: { currentDefinitionVersionId: versionId },
    })
  }

  async activate(agentId: string): Promise<Agent> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('Agent not found')
    if (!agent.currentDefinitionVersionId) {
      throw new Error('Előbb tedd közzé a definíciót, aztán aktiválhatod.')
    }
    assertTransition(agent.status, 'active')
    return prisma.agent.update({
      where: { id: agentId },
      data: { status: 'active', retiredAt: null },
    })
  }

  async suspend(agentId: string, _reason?: string): Promise<Agent> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('Agent not found')
    assertTransition(agent.status, 'suspended')
    return prisma.agent.update({
      where: { id: agentId },
      data: { status: 'suspended' },
    })
  }

  async resume(agentId: string): Promise<Agent> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('Agent not found')
    assertTransition(agent.status, 'active')
    return prisma.agent.update({
      where: { id: agentId },
      data: { status: 'active' },
    })
  }

  async retire(agentId: string): Promise<Agent> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('Agent not found')
    assertTransition(agent.status, 'retired')
    return prisma.agent.update({
      where: { id: agentId },
      data: { status: 'retired', retiredAt: new Date() },
    })
  }

  async delete(agentId: string, opts?: { force?: boolean }): Promise<void> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('Agent not found')
    if (!opts?.force && !isPhysicallyDeletable(agent.status)) {
      throw new Error('Csak vázlat törölhető.')
    }
    await prisma.agent.delete({ where: { id: agentId } })
  }

  async findCapabilitiesForAgent(agentId: string): Promise<{ toolName: string; allowed: boolean }[]> {
    return prisma.capability.findMany({
      where: { agentId },
      select: { toolName: true, allowed: true },
      orderBy: { toolName: 'asc' },
    })
  }

  async findConnectorsForAgent(agentId: string): Promise<AgentConnectorBinding[]> {
    const rows = await prisma.agentConnector.findMany({
      where: { agentId },
      include: {
        connector: {
          include: {
            activeSpecVersion: { select: { capabilitySet: true } },
          },
        },
      },
      orderBy: { connectorId: 'asc' },
    })
    return rows.map((row) => ({ connector: row.connector, accessMode: row.accessMode }))
  }

  async replaceCapabilities(agentId: string, toolNames: string[]): Promise<void> {
    await prisma.$transaction([
      prisma.capability.deleteMany({ where: { agentId } }),
      ...(toolNames.length > 0
        ? [
            prisma.capability.createMany({
              data: toolNames.map((toolName) => ({ agentId, toolName, allowed: true })),
            }),
          ]
        : []),
    ])
  }

  async upsertConnectorBinding(input: {
    agentId: string
    connectorId: string
    accessMode: ConnectorAccessMode
  }): Promise<void> {
    await prisma.agentConnector.upsert({
      where: {
        agentId_connectorId: { agentId: input.agentId, connectorId: input.connectorId },
      },
      create: {
        agentId: input.agentId,
        connectorId: input.connectorId,
        accessMode: input.accessMode,
      },
      update: { accessMode: input.accessMode },
    })
  }
}
