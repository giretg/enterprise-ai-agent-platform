import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import type { ActiveRunsResponse } from '@/lib/active-runs'
import { loadActiveRuns } from '@/lib/active-runs-load'
import { coalescePollRead } from '@/lib/poll-coalesce'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const auth = await requireTenantApiUser('operator')
  if (!auth.ok) return auth.response
  const { user } = auth

  // Ugyanaz a cache-kulcs, mint a `rail-state` futáslistájáé (tenant + user +
  // szerep): a két végpont egy kliens-cikluson belül egy DB-kört oszt meg.
  const runs = await coalescePollRead(
    {
      tenantId: user.activeTenantId,
      userId: user.user.id,
      namespace: 'active-runs',
      variant: user.activeTenantRole ?? '',
    },
    () =>
      loadActiveRuns({
        tenantId: user.activeTenantId,
        userId: user.user.id,
        activeTenantRole: user.activeTenantRole,
      }),
  )

  const body: ActiveRunsResponse = { runs }
  return Response.json(body)
}
