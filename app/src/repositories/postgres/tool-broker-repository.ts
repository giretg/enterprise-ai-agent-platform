import type {
  Connector,
  ConnectorAccessMode,
  ConnectorType,
  Prisma,
  ToolCall,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AgentConnectorBinding, ToolBrokerRepository } from '../interfaces'
import { RUN_ANALYST_SYSTEM_ROLE } from '@/lib/platform-agent-registry'

function pinnedRuntimeConfig(
  connectorMode: 'fixed' | 'self_updating',
  fixedConfig: unknown,
  _activeCapabilitySet: unknown,
): Prisma.JsonValue | null {
  if (connectorMode === 'self_updating') return null
  return fixedConfig as Prisma.JsonValue
}

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

function syntheticReadBinding(connector: Connector): AgentConnectorBinding {
  return {
    connector,
    accessMode: 'read',
    agentSecretAlias: null,
    writeApproval: 'per_call',
    preapprovedTrustMode: null,
    preapprovedExpiresAt: null,
    preapprovedWriteLimit: null,
    dangerPreapproved: false,
  }
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
    if (row) {
      const connector = toRuntimeConnector(row.connector)
      if (connector) return { connector, agentSecretAlias: row.secretAlias ?? null }
    }
    if (input.type === 'http_api' && input.accessMode === 'read') {
      const tenantId = await this.runAnalystTenantId(input.agentId)
      if (tenantId !== false) {
        const connectors = await this.findActiveTenantConnectors({
          tenantId: input.tenantId ?? tenantId,
          type: 'http_api',
          ...(input.connectorId ? { connectorId: input.connectorId } : {}),
        })
        const connector = connectors[0]
        if (connector) return { connector, agentSecretAlias: null }
      }
    }
    return null
  }

  /**
   * `false` = nem Futás-elemző. Egyébként a tenantId (lehet null platform-agentnél).
   */
  private async runAnalystTenantId(agentId: string): Promise<string | null | false> {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { systemRole: true, tenantId: true },
    })
    if (agent?.systemRole !== RUN_ANALYST_SYSTEM_ROLE) return false
    return agent.tenantId
  }

  private async findActiveTenantConnectors(params: {
    tenantId: string | null
    type: ConnectorType
    connectorId?: string
  }): Promise<Connector[]> {
    const rows = await prisma.connector.findMany({
      where: {
        type: params.type,
        lifecycleState: 'active',
        ...connectorTenantScope(params.tenantId),
        ...(params.connectorId ? { id: params.connectorId } : {}),
      },
      include: { activeSpecVersion: { select: { capabilitySet: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return rows.flatMap((row) => {
      const connector = toRuntimeConnector(row)
      return connector ? [connector] : []
    })
  }

  async findCapability(agentId: string, toolName: string): Promise<{ allowed: boolean } | null> {
    return prisma.capability.findUnique({
      where: { agentId_toolName: { agentId, toolName } },
      select: { allowed: true },
    })
  }

  async findCapabilitiesForAgents(
    agentIds: string[],
    toolNames?: string[],
  ): Promise<{ agentId: string; toolName: string; allowed: boolean }[]> {
    if (agentIds.length === 0) return []
    const uniqueIds = [...new Set(agentIds)]
    return prisma.capability.findMany({
      where: {
        agentId: { in: uniqueIds },
        ...(toolNames && toolNames.length > 0 ? { toolName: { in: [...new Set(toolNames)] } } : {}),
      },
      select: { agentId: true, toolName: true, allowed: true },
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

  async findConnectorsForAgent(agentId: string) {
    const rows = await prisma.agentConnector.findMany({
      where: { agentId },
      include: { connector: { include: { activeSpecVersion: { select: { capabilitySet: true } } } } },
      orderBy: { connector: { name: 'asc' } },
    })
    const bindings = rows.flatMap((r) => {
      const connector = toRuntimeConnector(r.connector)
      return connector
        ? [
            {
              connector,
              accessMode: r.accessMode,
              agentSecretAlias: r.secretAlias ?? null,
              writeApproval: r.writeApproval,
              preapprovedTrustMode: r.preapprovedTrustMode,
              preapprovedExpiresAt: r.preapprovedExpiresAt,
              preapprovedWriteLimit: r.preapprovedWriteLimit,
              dangerPreapproved: r.dangerPreapproved,
            },
          ]
        : []
    })
    const tenantId = await this.runAnalystTenantId(agentId)
    if (tenantId === false) return bindings
    const tenantHttp = await this.findActiveTenantConnectors({
      tenantId,
      type: 'http_api',
    })
    const withoutHttp = bindings.filter((binding) => binding.connector.type !== 'http_api')
    return [...withoutHttp, ...tenantHttp.map(syntheticReadBinding)]
  }

  async findDocumentsForConnector(
    connectorId: string,
  ): Promise<{ id: string; filename: string; extractedText: string | null }[]> {
    // Legacy stem-scoring fallback — hard cap, hogy egy nagy KB ne húzza be
    // a teljes extractedText korpuszt minden kb_search hívásra.
    return prisma.document.findMany({
      where: { connectorId, status: 'processed' },
      select: { id: true, filename: true, extractedText: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
  }

  async findDocumentsForConnectors(
    connectorIds: string[],
    opts?: { excludeIds?: string[]; take?: number },
  ): Promise<{ id: string; filename: string; extractedText: string | null }[]> {
    if (connectorIds.length === 0) return []
    const excludeIds = opts?.excludeIds?.filter(Boolean) ?? []
    return prisma.document.findMany({
      where: {
        connectorId: { in: connectorIds },
        status: 'processed',
        ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
      },
      select: { id: true, filename: true, extractedText: true },
      orderBy: { createdAt: 'desc' },
      take: opts?.take ?? 200,
    })
  }

  async createToolCall(
    data: Omit<ToolCall, 'id' | 'createdAt' | 'agentTurnId'> & { agentTurnId?: string | null },
  ): Promise<ToolCall> {
    return prisma.toolCall.create({
      data: { ...data, agentTurnId: data.agentTurnId ?? null } as Prisma.ToolCallUncheckedCreateInput,
    })
  }

  async getToolSummary(since?: Date): Promise<{ calls: number; denied: number; errors: number }> {
    const grouped = await prisma.toolCall.groupBy({
      by: ['status'],
      where: since ? { createdAt: { gte: since } } : undefined,
      _count: { _all: true },
    })

    return grouped.reduce(
      (acc, row) => ({
        calls: acc.calls + row._count._all,
        denied: acc.denied + (row.status === 'denied' ? row._count._all : 0),
        errors: acc.errors + (row.status === 'error' ? row._count._all : 0),
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

  async getToolUsageForScope(input: {
    ticketId?: string
    conversationId?: string
    toolName: string
  }): Promise<{ calls: number; execMs: number }> {
    const rows = await prisma.toolCall.findMany({
      where: {
        toolName: input.toolName,
        status: { in: ['ok', 'error'] },
        ...(input.ticketId ? { ticketId: input.ticketId } : { conversationId: input.conversationId }),
      },
      select: { resultMeta: true, latencyMs: true },
    })
    return {
      calls: rows.length,
      execMs: rows.reduce((sum, row) => {
        const meta = row.resultMeta && typeof row.resultMeta === 'object' && !Array.isArray(row.resultMeta)
          ? row.resultMeta as Record<string, unknown>
          : {}
        return sum + (typeof meta.execMs === 'number' ? meta.execMs : row.latencyMs)
      }, 0),
    }
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

  async listToolCallsForTicket(ticketId: string, limit = 200): Promise<ToolCall[]> {
    return prisma.toolCall.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
      take: limit,
    })
  }
}
