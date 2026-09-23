import { requireTenantRole } from '@/auth/tenant-context'
import { listPendingGatewayOperationsAction } from '@/app/actions/gateway-operation'
import { operationErrorLabel } from './labels'
import { OperationsPanel } from './operations-panel'

export default async function OperationsPage() {
  await requireTenantRole('viewer')
  const listed = await listPendingGatewayOperationsAction()
  const operations = listed.success ? listed.data.operations : []
  const error = listed.success ? null : listed.error

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Jóváhagyások</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Jóváhagyásra váró műveletek</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Itt azok az írások várnak, amelyeket a munkatárs a te nevedben küldene el (például
          API-hívás vagy Google Drive-fájl). Jóváhagyás után a rendszer egyszer végrehajtja a
          kérést; elutasításnál nem történik írás.
        </p>
      </div>
      {error ? (
        <p className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {operationErrorLabel(error)}
        </p>
      ) : (
        <OperationsPanel operations={operations} />
      )}
    </div>
  )
}
