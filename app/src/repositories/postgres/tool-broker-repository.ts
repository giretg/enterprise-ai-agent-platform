import type {
  Connector,
  ConnectorAccessMode,
  ConnectorType,
  Prisma,
  ToolCall,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ToolBrokerRepository } from '../interfaces'

function connectorAccessModes(required: ConnectorAccessMode): ConnectorAccessMode[] {
  return required === 'read' ? ['read', 'write'] : ['write']
}

export class PostgresToolBrokerRepository implements ToolBrokerRepository {
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
  ): Promise<{ connector: Connector; agentSecretAlias: string | null } | null> {
    const agentConnector = await prisma.agentConnector.findFirst({
      where: {
        agentId,
        accessMode: { in: connectorAccessModes(accessMode) },
        connector: { type },
      },
      include: { connector: true },
    })
    if (!agentConnector) return null
    return { connector: agentConnector.connector, agentSecretAlias: agentConnector.secretAlias ?? null }
  }

  async findConnectorForAgentById(
    agentId: string,
    connectorId: string,
    type: ConnectorType,
    accessMode: ConnectorAccessMode,
  ): Promise<{ connector: Connector; agentSecretAlias: string | null } | null> {
    const agentConnector = await prisma.agentConnector.findFirst({
      where: {
        agentId,
        connectorId,
        accessMode: { in: connectorAccessModes(accessMode) },
        connector: { type },
      },
      include: { connector: true },
    })
    if (!agentConnector) return null
    return { connector: agentConnector.connector, agentSecretAlias: agentConnector.secretAlias ?? null }
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
      include: { connector: true },
      orderBy: { connector: { name: 'asc' } },
    })
    return rows.map((r) => ({ connector: r.connector, accessMode: r.accessMode, agentSecretAlias: r.secretAlias ?? null }))
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
}
