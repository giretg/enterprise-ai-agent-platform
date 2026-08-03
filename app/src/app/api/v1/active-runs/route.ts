import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import type { ActiveRunsResponse } from '@/lib/active-runs'
import { loadActiveRuns } from '@/lib/active-runs-load'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const auth = await requireTenantApiUser('operator')
  if (!auth.ok) return auth.response
  const { user } = auth

  const runs = await loadActiveRuns({
    tenantId: user.activeTenantId,
    userId: user.user.id,
    activeTenantRole: user.activeTenantRole,
  })

  const body: ActiveRunsResponse = { runs }
  return Response.json(body)
}
