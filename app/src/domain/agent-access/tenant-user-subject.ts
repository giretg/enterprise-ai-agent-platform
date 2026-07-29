/**
 * A bejelentkezett felhasználó mint az agent-hozzáférési gráf ALANYA (#142).
 *
 * Egy helyen dönti el, hogy a kérésnek van-e egyáltalán gráf-alanya: tenant-kontextus
 * nélkül (tisztán platform-szintű superadmin) NINCS user→agent gráf-él, mert a
 * tenant-határ abszolút. Ilyenkor `null`-t adunk, és a hívó fail-closed módon üres
 * listát / „nem található" választ ad — nem a teljes agent-listát.
 */
import { meetsMinRole } from '@/lib/iam-policy'
import type { UserRole } from '@prisma/client'
import type { AgentAccessSubject } from '@/lib/agent-access-graph'

export type TenantUserLike = {
  user: { id: string }
  activeTenantId: string | null
  activeTenantRole: UserRole
}

export function tenantUserSubject(user: TenantUserLike): AgentAccessSubject | null {
  if (!user.activeTenantId) return null
  return { kind: 'user', userId: user.user.id, tenantId: user.activeTenantId }
}

/**
 * A `hiddenFromOperators` katalógus-szabályhoz: a tenant admin management-nézetben
 * a rejtett agenteket is látja. A gráf-grant EZT NEM írja felül — a rejtés
 * listázási/alkalmassági szabály, nem hozzáférési él.
 */
export function isTenantAdmin(user: TenantUserLike): boolean {
  return meetsMinRole(user.activeTenantRole, 'admin')
}
