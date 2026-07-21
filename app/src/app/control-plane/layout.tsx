import { getAuthContext } from '@/auth/context'
import { buildControlPlaneNav } from '@/lib/control-plane-nav'
import { ControlPlaneShell } from './control-plane-shell'

export default async function ControlPlaneLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContext()
  const navItems = buildControlPlaneNav({
    tenantRole: ctx?.activeTenantRole ?? null,
    platformRoles: ctx?.platformRoles ?? [],
  })

  return <ControlPlaneShell navItems={navItems}>{children}</ControlPlaneShell>
}
