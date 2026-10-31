import type { Agent, Connector } from '@prisma/client'
import type { AgentRepository, ConnectorRepository } from '@/repositories/interfaces'
import { WEB_SEARCH_TOOL } from '@/domain/enterprise-tools/tool-definitions'
import { WEB_SEARCH_CONNECTOR_NAME } from '@/domain/web-search/web-search'

export function toolsNeedWebSearch(toolNames: string[]): boolean {
  return toolNames.includes(WEB_SEARCH_TOOL)
}

/**
 * #1020: a tenant céges webes keresője (egy connector / tenant, az admin hozza létre a Beállításokban).
 * Amíg nincs, a `web_search` jogú munkatárs nem kap kötést; a hívás „nincs beállítva” üzenetet ad.
 */
export async function ensureAgentWebSearch(
  agent: Pick<Agent, 'id' | 'tenantId'>,
  deps: {
    connectors: Pick<ConnectorRepository, 'findByTenantTypeAndName'>
    agents: Pick<AgentRepository, 'upsertConnectorBinding'>
  },
): Promise<Connector | null> {
  if (!agent.tenantId) return null
  const connector = await deps.connectors.findByTenantTypeAndName(agent.tenantId, 'web_search', WEB_SEARCH_CONNECTOR_NAME)
  if (!connector || connector.lifecycleState !== 'active') return null
  await deps.agents.upsertConnectorBinding({ agentId: agent.id, connectorId: connector.id, accessMode: 'read' })
  return connector
}
