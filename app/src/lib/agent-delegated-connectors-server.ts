import type { ConnectorGrant } from '@prisma/client'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import type { AgentDelegatedConnectorRow } from '@/lib/agent-delegated-connectors'

export async function loadAgentDelegatedConnectors(
  agentId: string,
  userId: string,
  tenantId: string | null,
): Promise<AgentDelegatedConnectorRow[]> {
  // Szándékosan NINCS revoke az olvasási útvonalon: az agent detail / chat panel
  // SSR-t ne blokkolja Secret Manager + audit írás. A stale grant-ek takarítása
  // a connectors panel listázásakor fut (`listConnectorsPanelContext` /
  // `listMyConnectorGrants`). Az inaktív grant-eket alább amúgy is kiszűrjük.
  const [links, grants] = await Promise.all([
    repositories.toolBroker.findConnectorsForAgent(agentId),
    services.connectorGrants.listForUser(userId, tenantId),
  ])

  const activeGrantsByConnectorId = new Map<string, Pick<ConnectorGrant, 'accountLabel' | 'status'>>()
  for (const grant of grants) {
    if (grant.status !== 'active') continue
    if (grant.connector.lifecycleState !== 'active') continue
    activeGrantsByConnectorId.set(grant.connectorId, {
      accountLabel: grant.accountLabel,
      status: grant.status,
    })
  }

  return links
    .filter(
      (row) =>
        row.connector.authMode === 'user_delegated' && row.connector.lifecycleState === 'active',
    )
    .map((row) => ({
      connector: {
        id: row.connector.id,
        name: row.connector.name,
        type: row.connector.type,
        authMode: row.connector.authMode,
        lifecycleState: row.connector.lifecycleState,
        config: row.connector.config,
      },
      accessMode: row.accessMode,
      grant: activeGrantsByConnectorId.get(row.connector.id) ?? null,
    }))
    .sort((a, b) => a.connector.name.localeCompare(b.connector.name, 'hu'))
}
