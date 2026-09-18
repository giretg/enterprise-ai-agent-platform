/**
 * A prompt-roster szűrt kollégalistája (Access-Policy §agent-scope chokepoint-táblázat:
 * `formatOrgRoster`, agent→agent, `address`, szűrt lista).
 *
 * ÜZLETI JELENTÉS: a roster a modell CSELEKVÉSI listája. Ha olyan kollégát kínál, akit a
 * hívó agent nem szólíthat meg, a modell tiltott delegációval próbálkozik, és a
 * felhasználó egy értelmetlen „nem sikerült" választ kap. Ezért `address` (nem `view`)
 * alapján szűrünk.
 *
 * FAIL-CLOSED: ha a gráf-szolgáltatás nincs bekötve, ÜRES listát adunk (a modell nem
 * kínál kollégát), nem a teljes agent-listát. Egy elmaradt dependency-injection sosem
 * nyithatja meg a tenant-határt.
 */
import type { OrgRosterAgent } from '@/lib/agent-org-roster'
import type { AgentAccessService } from './agent-access-service'

export async function resolveAddressableColleagues(
  agentAccess: AgentAccessService | undefined,
  agent: { id: string; tenantId: string | null },
): Promise<OrgRosterAgent[]> {
  if (!agentAccess) return []
  // Platform-szintű (tenantId=null) agentnek nincs tenant-gráfja, tehát nincs kollégája.
  if (!agent.tenantId) return []

  const nodes = await agentAccess.listAccessibleAgents(
    { kind: 'agent', agentId: agent.id, tenantId: agent.tenantId },
    'address',
    { activeOnly: true },
  )

  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    role: node.role,
    status: node.status,
    personaNickname: node.personaNickname,
    personaTrait: node.personaTrait,
  }))
}
