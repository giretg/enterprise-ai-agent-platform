import { getAuthContext } from '@/auth/context'
import { buildControlPlaneNav } from '@/lib/control-plane-nav'
import { loadTenantNavVisibility } from '@/lib/nav-visibility-server'
import { ControlPlaneShell } from './control-plane-shell'

export default async function ControlPlaneLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContext()
  // Szerepkörönkénti menü-kurálás (Menü-hozzáférés). A policy csak SZŰKÍT: a
  // jogosultsági kaput továbbra is az oldalak `requireTenantRole` guardjai adják.
  const navVisibility = await loadTenantNavVisibility(ctx?.activeTenantId ?? null)
  const navItems = buildControlPlaneNav({
    tenantRole: ctx?.activeTenantRole ?? null,
    platformRoles: ctx?.platformRoles ?? [],
    navVisibility,
  })

  return <ControlPlaneShell navItems={navItems}>{children}</ControlPlaneShell>
}
