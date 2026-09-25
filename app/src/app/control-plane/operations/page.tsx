import { getTranslations } from 'next-intl/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { listPendingGatewayOperationsAction } from '@/app/actions/gateway-operation'
import { asTranslate } from '@/i18n/translate'
import { operationErrorLabel } from './labels'
import { OperationsPanel } from './operations-panel'

export default async function OperationsPage() {
  await requireTenantRole('viewer')
  const listed = await listPendingGatewayOperationsAction()
  const operations = listed.success ? listed.data.operations : []
  const error = listed.success ? null : listed.error
  const t = await getTranslations('ControlPlane.operations')

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">{t('body')}</p>
      </div>
      {error ? (
        <p className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {operationErrorLabel(error, asTranslate(t))}
        </p>
      ) : (
        <OperationsPanel operations={operations} />
      )}
    </div>
  )
}
