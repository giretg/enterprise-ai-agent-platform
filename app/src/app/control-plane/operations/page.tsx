import { getTranslations } from 'next-intl/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { listPendingGatewayOperationsAction } from '@/app/actions/gateway-operation'
import { listHandoffInboxAction } from '@/app/actions/handoff'
import { asTranslate } from '@/i18n/translate'
import { operationErrorLabel } from './labels'
import { OperationsPanel } from './operations-panel'
import { HandoffsPanel } from './handoffs-panel'
import { OperationsHistoryPanel } from './operations-history-panel'

export default async function OperationsPage() {
  await requireTenantRole('viewer')
  const listed = await listPendingGatewayOperationsAction()
  const inbox = await listHandoffInboxAction()
  const operations = listed.success ? listed.data.operations : []
  const handoffs = inbox.success ? inbox.data.handoffs : []
  const operationsError = listed.success ? null : listed.error
  const inboxError = inbox.success ? null : inbox.error
  const showInboxError =
    inboxError && inboxError !== 'schema_mismatch' && inboxError !== 'handoffs_unavailable'
  const t = await getTranslations('ControlPlane.operations')
  const tFn = asTranslate(t)

  return (
    <div className="space-y-10">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">{t('body')}</p>
      </div>
      <section className="space-y-4">
        <div>
          <h2 className="font-display text-xl font-semibold">{t('approvalsTitle')}</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">{t('approvalsBody')}</p>
        </div>
        {operationsError ? (
          <p className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
            {operationErrorLabel(operationsError, tFn)}
          </p>
        ) : (
          <OperationsPanel operations={operations} />
        )}
      </section>
      {showInboxError ? (
        <p className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {operationErrorLabel(inboxError!, tFn)}
        </p>
      ) : (
        <HandoffsPanel handoffs={handoffs} />
      )}
      <OperationsHistoryPanel />
    </div>
  )
}
