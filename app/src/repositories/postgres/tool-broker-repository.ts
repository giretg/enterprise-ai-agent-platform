import type {
  Connector,
  ConnectorAccessMode,
  ConnectorType,
  Prisma,
  ToolCall,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ToolBrokerRepository } from '../interfaces'
import { pinnedRuntimeConfig } from '@/domain/connector-self-update/pinned-runtime-config'

type ConnectorWithActiveSpec = Connector & {
  activeSpecVersion: { capabilitySet: Prisma.JsonValue } | null
}

function toRuntimeConnector(row: ConnectorWithActiveSpec): Connector | null {
  const config = pinnedRuntimeConfig(
    row.connectorMode,
    row.config,
    row.activeSpecVersion?.capabilitySet ?? null,
  )
  if (!config) return null
  const connector = Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'activeSpecVersion'),
  ) as Connector
  return { ...connector, config }
}

function connectorAccessModes(required: ConnectorAccessMode): ConnectorAccessMode[] {
  return required === 'read' ? ['read', 'write'] : ['write']
}

function connectorTenantScope(tenantId?: string | null) {
  return tenantId === undefined
    ? {}
    : tenantId
      ? { OR: [{ tenantId }, { tenantId: null }] }
      : { tenantId: null }
}

export class PostgresToolBrokerRepository implements ToolBrokerRepository {
  private async findRuntimeConnectorForAgent(input: {
    agentId: string
    type: ConnectorType
    accessMode: ConnectorAccessMode
    tenantId?: string | null
    connectorId?: string
  }): Promise<{ connector: Connector; agentSecretAlias: string | null } | null> {
    const connectorScope =
      input.type === 'web_search' && input.tenantId
        ? { type: input.type, tenantId: input.tenantId, ...(input.connectorId ? { id: input.connectorId } : {}) }
        : { type: input.type, ...(input.connectorId ? { id: input.connectorId } : {}), ...connectorTenantScope(input.tenantId) }
    const row = await prisma.agentConnector.findFirst({
      where: {
        agentId: input.agentId,
        ...(input.connectorId ? { connectorId: input.connectorId } : {}),
        accessMode: { in: connectorAccessModes(input.accessMode) },
        connector: connectorScope,
      },
      include: { connector: { include: { activeSpecVersion: { select: { capabilitySet: true } } } } },
      orderBy: { connector: { createdAt: 'asc' } },
    })
    if (!row) return null
    const connector = toRuntimeConnector(row.connector)
    return connector ? { connector, agentSecretAlias: row.secretAlias ?? null } : null
  }

  async findCapability(agentId: string, toolName: string): Promise<{ allowed: boolean } | null> {
    return prisma.capability.findUnique({
      where: { agentId_toolName: { agentId, toolName } },
      select: { allowed: true },
    })
  }

  async findConnectorForAgent(
    agentId: string,
    type: ConnectorType,
    accessMode: ConnectorAccessMode,
    tenantId?: string | null,
  ): Promise<{ connector: Connector; agentSecretAlias: string | null } | null> {
    return this.findRuntimeConnectorForAgent({ agentId, type, accessMode, tenantId })
  }

  async findConnectorForAgentById(
    agentId: string,
    connectorId: string,
    type: ConnectorType,
    accessMode: ConnectorAccessMode,
    tenantId?: string | null,
  ): Promise<{ connector: Connector; agentSecretAlias: string | null } | null> {
    return this.findRuntimeConnectorForAgent({ agentId, connectorId, type, accessMode, tenantId })
  }

  async findCapabilitiesForAgent(
    agentId: string,
  ): Promise<{ toolName: string; allowed: boolean }[]> {
    return prisma.capability.findMany({
      where: { agentId },
      select: { toolName: true, allowed: true },
      orderBy: { toolName: 'asc' },
    })
  }

  async findConnectorsForAgent(
    agentId: string,
  ): Promise<{ connector: Connector; accessMode: ConnectorAccessMode; agentSecretAlias: string | null }[]> {
    const rows = await prisma.agentConnector.findMany({
      where: { agentId },
      include: { connector: { include: { activeSpecVersion: { select: { capabilitySet: true } } } } },
      orderBy: { connector: { name: 'asc' } },
    })
    return rows.flatMap((r) => {
      const connector = toRuntimeConnector(r.connector)
      return connector
        ? [{ connector, accessMode: r.accessMode, agentSecretAlias: r.secretAlias ?? null }]
        : []
    })
  }

  async findDocumentsForConnector(
    connectorId: string,
  ): Promise<{ id: string; filename: string; extractedText: string | null }[]> {
    return prisma.document.findMany({
      where: { connectorId, status: 'processed' },
      select: { id: true, filename: true, extractedText: true },
      orderBy: { createdAt: 'desc' },
    })
  }

  async createToolCall(data: Omit<ToolCall, 'id' | 'createdAt'>): Promise<ToolCall> {
    return prisma.toolCall.create({ data: data as Prisma.ToolCallUncheckedCreateInput })
  }

  async getToolSummary(since?: Date): Promise<{ calls: number; denied: number; errors: number }> {
    const rows = await prisma.toolCall.findMany({
      where: since ? { createdAt: { gte: since } } : undefined,
      select: { status: true },
    })

    return rows.reduce(
      (acc, row) => ({
        calls: acc.calls + 1,
        denied: acc.denied + (row.status === 'denied' ? 1 : 0),
        errors: acc.errors + (row.status === 'error' ? 1 : 0),
      }),
      { calls: 0, denied: 0, errors: 0 },
    )
  }

  async getToolCallCountsByTicket(since?: Date): Promise<Record<string, number>> {
    const grouped = await prisma.toolCall.groupBy({
      by: ['ticketId'],
      where: {
        ticketId: { not: null },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      _count: { _all: true },
    })

    const counts: Record<string, number> = {}
    for (const row of grouped) {
      if (row.ticketId) counts[row.ticketId] = row._count._all
    }
    return counts
  }

  async countToolCallsForTicket(ticketId: string, toolName: string): Promise<number> {
    return prisma.toolCall.count({
      where: { ticketId, toolName, status: 'ok' },
    })
  }

  async countToolCallsForConversation(conversationId: string, toolName: string): Promise<number> {
    return prisma.toolCall.count({
      where: { conversationId, toolName, status: 'ok' },
    })
  }

  async countToolCallsForAgentSince(agentId: string, toolName: string, since: Date): Promise<number> {
    return prisma.toolCall.count({
      where: { agentId, toolName, status: 'ok', createdAt: { gte: since } },
    })
  }

  async listToolCallsByName(
    toolName: string,
    filter?: { agentId?: string; since?: Date },
    limit = 100,
  ): Promise<ToolCall[]> {
    return prisma.toolCall.findMany({
      where: {
        toolName,
        ...(filter?.agentId ? { agentId: filter.agentId } : {}),
        ...(filter?.since ? { createdAt: { gte: filter.since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
  }

  async listToolCallsForConversation(conversationId: string, limit = 200): Promise<ToolCall[]> {
    return prisma.toolCall.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: limit,
    })
  }
}
