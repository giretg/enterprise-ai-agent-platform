import type { Agent, Connector } from '@prisma/client'
import type { AgentRepository, ConnectorRepository } from '@/repositories/interfaces'
import type { KbLanguage } from './kb-language'

type KbConnectorDeps = {
  connectors: Pick<ConnectorRepository, 'findByTenantTypeAndName' | 'create'> & {
    /** #717: új connector tenant-nyelvi alapértelmezése (opcionális seam). */
    setKbLanguage?: (connectorId: string, kbLanguage: KbLanguage) => Promise<Connector>
  }
}

export type EnsureKbDefaults = {
  /** #717: új tudástár-connector ezt a nyelvet kapja (`hu` DB-default helyett). */
  defaultKbLanguage?: KbLanguage
}

export function knowledgeBaseConnectorName(agentId: string): string {
  return `kb:${agentId}`
}

export async function ensureAgentKnowledgeBase(
  agent: Pick<Agent, 'id' | 'name' | 'tenantId'>,
  deps: KbConnectorDeps & {
    agents: Pick<AgentRepository, 'upsertConnectorBinding'>
  },
  defaults?: EnsureKbDefaults,
): Promise<Connector> {
  const name = knowledgeBaseConnectorName(agent.id)
  const existing = await deps.connectors.findByTenantTypeAndName(
    agent.tenantId,
    'knowledge_base',
    name,
  )
  const connector =
    existing ?? (await createKbConnector(deps, agent.tenantId, name, 'single', defaults))
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
  deps: KbConnectorDeps,
  defaults?: EnsureKbDefaults,
): Promise<Connector> {
  const name = knowledgeCatalogConnectorName()
  return (
    (await deps.connectors.findByTenantTypeAndName(tenantId, 'knowledge_base', name)) ??
    (await createKbConnector(deps, tenantId, name, 'single', defaults))
  )
}

/**
 * #717: új KB-connector a tenant nyelvi alapértelmezésével jön létre
 * (a `kb_language` DB-default `hu` helyett). A létrehozás és a nyelvállítás
 * között nincs olvasható tartalom, ezért a két írás sorrendje biztonságos.
 */
async function createKbConnector(
  deps: KbConnectorDeps,
  tenantId: string,
  name: string,
  scope: Connector['scope'],
  defaults?: EnsureKbDefaults,
): Promise<Connector> {
  const created = await deps.connectors.create({
    tenantId,
    type: 'knowledge_base',
    name,
    authMode: 'agent_owned',
    scope,
  })
  const wanted = defaults?.defaultKbLanguage
  if (wanted && created.kbLanguage !== wanted && deps.connectors.setKbLanguage) {
    return deps.connectors.setKbLanguage(created.id, wanted)
  }
  return created
}

export function toolsNeedKnowledgeBase(toolNames: string[]): boolean {
  return toolNames.some(
    (name) =>
      name === 'kb_search' ||
      name === 'kb_list_index' ||
      name === 'kb_get_page' ||
      name === 'kb_get_document' ||
      name === 'kb_ingest',
  )
}
