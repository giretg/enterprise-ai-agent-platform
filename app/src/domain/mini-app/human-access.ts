/**
 * Ember hozzáférése egy mini apphoz (#967 §5.3.1 „Ki látja", §6): az állandó
 * platform-link és a Control Plane minden megnyitáskor ezt kérdezi, ezért a
 * megosztás-visszavonás és az archiválás itt azonnal érvényes.
 *
 * - `manage`: a tulajdonos agentet működtetheti (admin/approver vagy operate jog) —
 *   megosztás, archiválás, visszaállítás.
 * - `view`: látja a tulajdonos agentet, egy aktív megosztott címzett agentet,
 *   vagy az app szervezeti (és ő a szervezet tagja).
 */
import { canOperateAgent, canReadPublishedAgent } from '@/domain/agent-definition'
import type { MiniAppRecord } from './types'

export type MiniAppHumanAccess = 'manage' | 'view' | null

export type MiniAppHumanAccessDeps = {
  findAgentGrant(input: { tenantId: string; userId: string; agentId: string }): Promise<{ accessLevel: string } | null>
  listActiveShareAgentIds(appId: string): Promise<string[]>
}

export async function miniAppHumanAccess(
  deps: MiniAppHumanAccessDeps,
  viewer: { tenantId: string; userId: string; role: string; assumed?: boolean },
  app: MiniAppRecord,
): Promise<MiniAppHumanAccess> {
  if (app.tenantId !== viewer.tenantId) return null
  const ownerGrant = await deps.findAgentGrant({ tenantId: viewer.tenantId, userId: viewer.userId, agentId: app.ownerAgentId })
  if (canOperateAgent({ role: viewer.role, grant: ownerGrant, assumed: viewer.assumed })) return 'manage'
  // Archivált appot csak a kezelő láthat (visszaállításhoz).
  if (app.status !== 'active') return null
  if (canReadPublishedAgent({ role: viewer.role, grant: ownerGrant })) return 'view'
  if (app.visibility === 'organization') return 'view'
  for (const agentId of await deps.listActiveShareAgentIds(app.id)) {
    const grant = await deps.findAgentGrant({ tenantId: viewer.tenantId, userId: viewer.userId, agentId })
    if (canReadPublishedAgent({ role: viewer.role, grant })) return 'view'
  }
  return null
}
