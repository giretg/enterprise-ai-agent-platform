import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { listHandoffInboxAction } from '@/app/actions/handoff'
import { listPendingGatewayOperationsAction } from '@/app/actions/gateway-operation'
import { listAgentsForCatalog } from '@/app/actions/platform'
import { hasMinimumRole } from '@/auth/types'
import { AgentCatalogCard } from '@/components/agents/agent-catalog-card'
import { Card } from '@/components/ui/shell'
import { asTranslate } from '@/i18n/translate'
import { requireControlPlaneTenantViewer } from '@/lib/default-agent-workspace'
import { operationErrorLabel } from '../operations/labels'
import { HandoffsPanel } from '../operations/handoffs-panel'
import { OperationsPanel } from '../operations/operations-panel'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const ctx = await requireControlPlaneTenantViewer()
  const canCreateAgent = hasMinimumRole(ctx.activeTenantRole, 'admin')
  const [agentsRes, listed, inbox] = await Promise.all([
    listAgentsForCatalog({ limit: 100 }),
    listPendingGatewayOperationsAction(),
    listHandoffInboxAction(),
  ])
  const agents = agentsRes.success ? agentsRes.data : []
  const operations = listed.success ? listed.data.operations : []
  const handoffs = inbox.success ? inbox.data.handoffs : []
  const t = await getTranslations('ControlPlane.dashboard')
  const tAgents = await getTranslations('ControlPlane.agents')
  const tOps = asTranslate(await getTranslations('ControlPlane.operations'))
  const tasksEmpty =
    listed.success && inbox.success && operations.length === 0 && handoffs.length === 0

  return (
    <div className="space-y-10">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
      </div>

      <section className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-xl font-semibold">{t('tasksTitle')}</h2>
          <Link href="/control-plane/operations" className="text-sm text-coral-deep hover:underline">
            {t('tasksAll')}
          </Link>
        </div>
        {listed.success ? null : (
          <p className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
            {operationErrorLabel(listed.error, tOps)}
          </p>
        )}
        {inbox.success ? null : (
          <p className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
            {operationErrorLabel(inbox.error, tOps)}
          </p>
        )}
        {tasksEmpty ? <p className="text-sm text-ink-soft">{t('tasksEmpty')}</p> : null}
        {listed.success && operations.length > 0 ? (
          <div className="space-y-3">
            <h3 className="font-display text-lg font-semibold">{tOps('approvalsTitle')}</h3>
            <OperationsPanel operations={operations} />
          </div>
        ) : null}
        {inbox.success && handoffs.length > 0 ? <HandoffsPanel handoffs={handoffs} /> : null}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-xl font-semibold">{t('agentsTitle')}</h2>
          <div className="flex flex-wrap items-center gap-4">
            {canCreateAgent ? (
              <Link
                href="/control-plane/agents/new"
                className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white hover:bg-coral/90"
              >
                {tAgents('new')}
              </Link>
            ) : null}
            <Link href="/control-plane/agents" className="text-sm text-coral-deep hover:underline">
              {t('agentsAll')}
            </Link>
          </div>
        </div>
        {agentsRes.success ? (
          <div className="grid gap-4 md:grid-cols-2">
            {agents.map((agent) => (
              <AgentCatalogCard key={agent.id} agent={agent} />
            ))}
            {agents.length === 0 ? (
              <Card title={tAgents('emptyTitle')}>
                <p className="text-sm text-ink-soft">
                  {canCreateAgent ? tAgents('emptyCanCreate') : tAgents('emptyNoCreate')}
                </p>
              </Card>
            ) : null}
          </div>
        ) : (
          <div className="rounded-2xl border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
            {tAgents('loadError')}
          </div>
        )}
      </section>
    </div>
  )
}
