import type { Agent, Connector } from '@prisma/client'
import type { AgentRepository, ConnectorRepository } from '@/repositories/interfaces'

export function knowledgeBaseConnectorName(agentId: string): string {
  return `kb:${agentId}`
}

export async function ensureAgentKnowledgeBase(
  agent: Pick<Agent, 'id' | 'name' | 'tenantId'>,
  deps: {
    connectors: Pick<ConnectorRepository, 'findByTenantTypeAndName' | 'create'>
    agents: Pick<AgentRepository, 'upsertConnectorBinding'>
  },
): Promise<Connector> {
  const name = knowledgeBaseConnectorName(agent.id)
  const existing = await deps.connectors.findByTenantTypeAndName(
    agent.tenantId,
    'knowledge_base',
    name,
  )
  const connector =
    existing ??
    (await deps.connectors.create({
      tenantId: agent.tenantId,
      type: 'knowledge_base',
      name,
      authMode: 'agent_owned',
      scope: 'single',
    }))
  await deps.agents.upsertConnectorBinding({
    agentId: agent.id,
    connectorId: connector.id,
    accessMode: 'write',
  })
  return connector
}

export function knowledgeCatalogConnectorName(): string {
  return 'kb:catalog'
}

export async function ensureCatalogKnowledgeBase(
  tenantId: string,
  deps: {
    connectors: Pick<ConnectorRepository, 'findByTenantTypeAndName' | 'create'>
  },
): Promise<Connector> {
  const name = knowledgeCatalogConnectorName()
  return (
    (await deps.connectors.findByTenantTypeAndName(tenantId, 'knowledge_base', name)) ??
    (await deps.connectors.create({
      tenantId,
      type: 'knowledge_base',
      name,
      authMode: 'agent_owned',
      scope: 'single',
    }))
  )
}

export function toolsNeedKnowledgeBase(toolNames: string[]): boolean {
  return toolNames.some(
    (name) =>
      name === 'kb_search' ||
      name === 'kb_list_index' ||
      name === 'kb_get_page' ||
      name === 'kb_ingest',
  )
}
