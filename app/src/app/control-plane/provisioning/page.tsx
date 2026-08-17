import { Suspense } from 'react'
import { getAuthContext } from '@/auth/context'
import { ProvisioningPanel } from './provisioning-panel'

export default async function ProvisioningPage() {
  const ctx = await getAuthContext()
  const canManageCatalog = Boolean(ctx?.platformRoles.includes('superadmin'))
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">Betöltés…</p>}>
      <ProvisioningPanel canManageCatalog={canManageCatalog} />
    </Suspense>
  )
}
