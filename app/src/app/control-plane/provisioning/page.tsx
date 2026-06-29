import { Suspense } from 'react'
import { ProvisioningPanel } from './provisioning-panel'

export default function ProvisioningPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">Betöltés…</p>}>
      <ProvisioningPanel />
    </Suspense>
  )
}
