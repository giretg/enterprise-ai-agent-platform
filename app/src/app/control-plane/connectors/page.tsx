import { Suspense } from 'react'
import { ConnectorsPanel } from './connectors-panel'

export default function ConnectorsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">Betöltés…</p>}>
      <ConnectorsPanel />
    </Suspense>
  )
}
