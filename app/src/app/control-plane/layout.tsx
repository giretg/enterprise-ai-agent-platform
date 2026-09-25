import { headers } from 'next/headers'
import { getTranslations } from 'next-intl/server'
import { getAuthContext } from '@/auth/context'
import { isControlPlaneEmbedRequest } from '@/lib/control-plane-embed'
import { buildControlPlaneNav } from '@/lib/control-plane-nav'
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
  const navVisibility = await loadTenantNavVisibility(ctx?.activeTenantId ?? null)
  const tNav = await getTranslations('ControlPlane.nav')
  const navItems = localizeControlPlaneNav(
    buildControlPlaneNav({
      tenantRole: ctx?.activeTenantRole ?? null,
      platformRoles: ctx?.platformRoles ?? [],
      navVisibility,
    }),
    asTranslate(tNav),
  )

  return (
    <ControlPlaneRoot embedFromServer={false} navItems={navItems}>
      {children}
    </ControlPlaneRoot>
  )
}
