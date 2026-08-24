import { listAgents } from '@/app/actions/platform'
import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { composeAgentRailStates } from '@/lib/agent-rail-compose'
import type { AgentRailStateResponse } from '@/lib/agent-rail-types'
import { loadActiveRuns } from '@/lib/active-runs-load'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Tenant-szűrt agent-sáv állapot — ~5 mp-es poll cél. */
export async function GET() {
  const auth = await requireTenantApiUser('viewer')
  if (!auth.ok) return auth.response
  const { user } = auth

  const agentsRes = await listAgents()
  if (!agentsRes.success) {
    return Response.json({ error: agentsRes.error }, { status: 500 })
  }

  const runs =
    user.activeTenantRole && user.activeTenantRole !== 'viewer'
      ? await loadActiveRuns({
          tenantId: user.activeTenantId,
          userId: user.user.id,
          activeTenantRole: user.activeTenantRole,
        })
      : []

  const body: AgentRailStateResponse = {
    agents: composeAgentRailStates(agentsRes.data, runs),
    asOf: new Date().toISOString(),
  }
  return Response.json(body)
}
