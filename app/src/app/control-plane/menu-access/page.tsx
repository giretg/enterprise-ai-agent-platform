import { getTranslations } from 'next-intl/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { getNavVisibility } from '@/app/actions/menu-access'
import { MenuAccessPanel } from '@/components/iam/menu-access-panel'

/**
 * Menü-hozzáférés — szerepkörönként állítható fejléc-menü (tenant admin jog).
 *
 * A guard szándékosan ugyanaz, mint a többi admin oldalon: a menü-kurálás maga is
 * admin művelet, és a menüpont elrejtése SEM helyettesíti — az oldal a közvetlen
 * URL-en is csak adminnak nyílik.
 */
export default async function MenuAccessPage() {
  await requireTenantRole('admin')
  const res = await getNavVisibility()

  const t = await getTranslations('ControlPlane.menuAccess')
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-ink-soft">{t('body')}</p>
      </div>

      {res.success ? (
        <MenuAccessPanel initialPolicy={res.data.policy} />
      ) : (
        <p className="text-sm text-ink-faint">{res.error}</p>
      )}
    </div>
  )
}
