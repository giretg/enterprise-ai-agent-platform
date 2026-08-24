import { headers } from 'next/headers'
import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { isControlPlaneEmbedRequest } from '@/lib/control-plane-embed'
import { buildControlPlaneNav } from '@/lib/control-plane-nav'
import { loadTenantNavVisibility } from '@/lib/nav-visibility-server'
import { ControlPlaneRoot } from './control-plane-shell'

export default async function ControlPlaneLayout({ children }: { children: React.ReactNode }) {
  const embed = isControlPlaneEmbedRequest(await headers())
  if (embed) {
    return <ControlPlaneRoot embedFromServer>{children}</ControlPlaneRoot>
  }

  const ctx = await getAuthContext()
  // Szerepkörönkénti menü-kurálás (Menü-hozzáférés). A policy csak SZŰKÍT: a
  // jogosultsági kaput továbbra is az oldalak `requireTenantRole` guardjai adják.
  const navVisibility = await loadTenantNavVisibility(ctx?.activeTenantId ?? null)
  const navItems = buildControlPlaneNav({
    tenantRole: ctx?.activeTenantRole ?? null,
    platformRoles: ctx?.platformRoles ?? [],
    navVisibility,
  })
  const canCreateAgent = hasMinimumRole(ctx?.activeTenantRole, 'admin')
  const canCreateTicket = hasMinimumRole(ctx?.activeTenantRole, 'operator')

  return (
    <ControlPlaneRoot
      embedFromServer={false}
      navItems={navItems}
      canCreateAgent={canCreateAgent}
      canCreateTicket={canCreateTicket}
    >
      {children}
    </ControlPlaneRoot>
  )
}
