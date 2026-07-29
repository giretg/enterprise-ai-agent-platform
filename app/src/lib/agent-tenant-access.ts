import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'

/**
 * Agent tenant-határ az olyan control-plane műveletekhez, amelyek egy konkrét
 * agenthez kötött adatot olvasnak vagy írnak. A megosztott (platform-szintű)
 * agent elérhető, más tenant agentje viszont sosem oldható fel.
 *
 * Az opak hiba szándékos: az idegen agent létezése nem válhat felderítési
 * orákulummá. A hívónak továbbra is külön kell ellenőriznie az adott művelet
 * szerep- vagy permission-követelményét.
 */
export function assertAgentTenantReachable(
  agent: { tenantId: string | null },
  tenantId: string | null,
): void {
  if (!isAgentReachableFromTenant(agent.tenantId, tenantId)) {
    throw new Error('Agent not found')
  }
}
