import { Suspense } from 'react'
import { LoadingState } from '@/components/ui/spinner'
import { ConnectorsPanel } from './connectors-panel'

export default function ConnectorsPage() {
  return (
    <Suspense fallback={<LoadingState className="min-h-[40vh]" />}>
      <ConnectorsPanel />
    </Suspense>
  )
}
