import { headers } from 'next/headers'
import { getTranslations } from 'next-intl/server'
import { listHandoffInboxAction } from '@/app/actions/handoff'
import { listPendingGatewayOperationsAction } from '@/app/actions/gateway-operation'
import { getAuthContext } from '@/auth/context'
import { isControlPlaneEmbedRequest } from '@/lib/control-plane-embed'
import { buildControlPlaneNav } from '@/lib/control-plane-nav'
import { hasMinimumRole } from '@/lib/iam-policy'
import { asTranslate } from '@/i18n/translate'
import { localizeControlPlaneNav } from '@/lib/control-plane-nav-i18n'
import { loadTenantNavVisibility } from '@/lib/nav-visibility-server'
import { ControlPlaneRoot } from './control-plane-shell'

export default async function ControlPlaneLayout({ children }: { children: React.ReactNode }) {
  const embed = isControlPlaneEmbedRequest(await headers())
  if (embed) {
    return <ControlPlaneRoot embedFromServer>{children}</ControlPlaneRoot>
  }

  const ctx = await getAuthContext()
  const canSeeTasks = hasMinimumRole(ctx?.activeTenantRole ?? null, 'viewer')
  // ponytail: a badge a teljes inbox-listák hossza, minden control-plane oldalon.
  // Upgrade: count-only query, ha ez a layout-latencyben látszik.
  const [navVisibility, pendingRes, inboxRes] = await Promise.all([
    loadTenantNavVisibility(ctx?.activeTenantId ?? null),
    canSeeTasks ? listPendingGatewayOperationsAction() : Promise.resolve(null),
    canSeeTasks ? listHandoffInboxAction() : Promise.resolve(null),
  ])
  const pendingTasksCount =
    (pendingRes?.success ? pendingRes.data.operations.length : 0) +
    (inboxRes?.success ? inboxRes.data.handoffs.length : 0)
  const tNav = await getTranslations('ControlPlane.nav')
  const navItems = localizeControlPlaneNav(
    buildControlPlaneNav({
      tenantRole: ctx?.activeTenantRole ?? null,
      platformRoles: ctx?.platformRoles ?? [],
      navVisibility,
      pendingTasksCount,
    }),
    asTranslate(tNav),
  )

  return (
    <ControlPlaneRoot embedFromServer={false} navItems={navItems}>
      {children}
    </ControlPlaneRoot>
  )
}
