import { Suspense } from 'react'
import { getAuthContext } from '@/auth/context'
import { isSuperadmin } from '@/lib/tenant-policy'
import {
  listConnectorCatalog,
  listConnectorTemplatesAction,
  listProvisioningDrafts,
} from '@/app/actions/provisioning'
import { ProvisioningPanel } from './provisioning-panel'

export default async function ProvisioningPage() {
  const ctx = await getAuthContext()
  const isSuper = Boolean(ctx && isSuperadmin(ctx.platformRoles))
  const isTenantAdmin = ctx?.kind === 'tenant' && ctx.activeTenantRole === 'admin'
  const [catalog, drafts, templates] = await Promise.all([
    listConnectorCatalog(),
    listProvisioningDrafts(),
    listConnectorTemplatesAction(),
  ])
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">Betöltés…</p>}>
      <ProvisioningPanel
        canManageCatalog={isSuper || isTenantAdmin}
        isSuperadmin={isSuper}
        activeTenantId={ctx?.kind === 'tenant' ? ctx.activeTenantId : null}
        initialCatalog={catalog.success ? catalog.data : []}
        initialDrafts={drafts.success ? drafts.data : []}
        initialTemplates={templates.success ? templates.data.filter((row) => row.status === 'active') : []}
        initialError={
          !catalog.success
            ? catalog.error
            : !drafts.success
              ? drafts.error
              : !templates.success
                ? templates.error
                : null
        }
      />
    </Suspense>
  )
}
