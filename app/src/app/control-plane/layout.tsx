import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { buildControlPlaneNav } from '@/lib/control-plane-nav'
import { loadTenantNavVisibility } from '@/lib/nav-visibility-server'
import { ControlPlaneRoot } from './control-plane-shell'

export default async function ControlPlaneLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContext()
  const navVisibility = await loadTenantNavVisibility(ctx?.activeTenantId ?? null)
  const navItems = buildControlPlaneNav({
    tenantRole: ctx?.activeTenantRole ?? null,
    platformRoles: ctx?.platformRoles ?? [],
    navVisibility,
  })
  const canCreateAgent = hasMinimumRole(ctx?.activeTenantRole, 'admin')

  return (
    <ControlPlaneRoot embedFromServer={false} navItems={navItems} canCreateAgent={canCreateAgent}>
      {children}
    </ControlPlaneRoot>
  )
}
