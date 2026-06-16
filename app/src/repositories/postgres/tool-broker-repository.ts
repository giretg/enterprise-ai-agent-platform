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
  ): Promise<Connector | null> {
    const agentConnector = await prisma.agentConnector.findFirst({
      where: {
        agentId,
        accessMode: { in: connectorAccessModes(accessMode) },
        connector: { type },
      },
      include: { connector: true },
    })

    return agentConnector?.connector ?? null
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
  ): Promise<{ connector: Connector; accessMode: ConnectorAccessMode }[]> {
    const rows = await prisma.agentConnector.findMany({
      where: { agentId },
      include: { connector: true },
      orderBy: { connector: { name: 'asc' } },
    })
    return rows.map((r) => ({ connector: r.connector, accessMode: r.accessMode }))
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
}
