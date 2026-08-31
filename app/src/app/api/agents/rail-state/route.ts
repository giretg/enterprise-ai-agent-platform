import { listAgents } from '@/app/actions/platform'
import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { composeAgentRailStates } from '@/lib/agent-rail-compose'
import type { AgentRailStateResponse } from '@/lib/agent-rail-types'
import { loadActiveRuns } from '@/lib/active-runs-load'
import { coalescePollRead } from '@/lib/poll-coalesce'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Tenant-szűrt agent-sáv állapot — ~5 mp-es poll cél. */
export async function GET() {
  const auth = await requireTenantApiUser('viewer')
  if (!auth.ok) return auth.response
  const { user } = auth

  // A sáv + a „Futások" panel + a több nyitott fül másodpercenként ugyanezt kéri:
  // egy rövid (POLL_COALESCE_TTL_MS) ablakon belül a DB-kört megosztjuk. Az auth
  // ettől függetlenül minden kérésnél lefut (fentebb).
  const agentsRes = await coalescePollRead(
    { tenantId: user.activeTenantId, userId: user.user.id, namespace: 'rail-agents' },
    () => listAgents(),
  )
  if (!agentsRes.success) {
    return Response.json({ error: agentsRes.error }, { status: 500 })
  }

  const runs =
    user.activeTenantRole && user.activeTenantRole !== 'viewer'
      ? await coalescePollRead(
          {
            tenantId: user.activeTenantId,
            userId: user.user.id,
            namespace: 'active-runs',
            variant: user.activeTenantRole,
          },
          () =>
            loadActiveRuns({
              tenantId: user.activeTenantId,
              userId: user.user.id,
              activeTenantRole: user.activeTenantRole,
            }),
        )
      : []

  const body: AgentRailStateResponse = {
    agents: composeAgentRailStates(agentsRes.data, runs),
    asOf: new Date().toISOString(),
  }
  return Response.json(body)
}
