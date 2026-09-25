import { Suspense } from 'react'
import { getTranslations } from 'next-intl/server'
import { getAuthContext } from '@/auth/context'
import { isSuperadmin } from '@/lib/tenant-policy'
import { ProvisioningPanel } from './provisioning-panel'

export default async function ProvisioningPage() {
  const ctx = await getAuthContext()
  const isSuper = Boolean(ctx && isSuperadmin(ctx.platformRoles))
  const isTenantAdmin = ctx?.kind === 'tenant' && ctx.activeTenantRole === 'admin'
  const t = await getTranslations('Common')
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">{t('loading')}</p>}>
      <ProvisioningPanel
        canManageCatalog={isSuper || isTenantAdmin}
        isSuperadmin={isSuper}
        activeTenantId={ctx?.kind === 'tenant' ? ctx.activeTenantId : null}
      />
    </Suspense>
  )
}
