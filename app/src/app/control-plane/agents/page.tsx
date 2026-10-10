import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { listAgentsForCatalog } from '@/app/actions/platform'
import { hasMinimumRole } from '@/auth/types'
import { AgentCatalogCard } from '@/components/agents/agent-catalog-card'
import { Card } from '@/components/ui/shell'
import { requireControlPlaneTenantViewer } from '@/lib/default-agent-workspace'

export const dynamic = 'force-dynamic'

export default async function AgentsIndexPage() {
  const ctx = await requireControlPlaneTenantViewer()
  const agentsRes = await listAgentsForCatalog({ limit: 100 })
  const agents = agentsRes.success ? agentsRes.data : []
  const loadError = agentsRes.success ? null : agentsRes.error
  const canCreateAgent = hasMinimumRole(ctx.activeTenantRole, 'admin')
  const t = await getTranslations('ControlPlane.agents')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
          <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
          <p className="mt-1 max-w-2xl text-ink-soft">{t('body')}</p>
        </div>
        {canCreateAgent ? (
          <Link
            href="/control-plane/agents/new"
            className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white hover:bg-coral/90"
          >
            {t('new')}
          </Link>
        ) : null}
      </div>
      {loadError ? (
        <div className="rounded-2xl border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {t('loadError')}
          <span className="mt-1 block text-xs opacity-70">{loadError}</span>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {agents.map((agent) => (
            <AgentCatalogCard key={agent.id} agent={agent} />
          ))}
          {agents.length === 0 ? (
            <Card title={t('emptyTitle')}>
              <p className="text-sm text-ink-soft">
                {canCreateAgent ? t('emptyCanCreate') : t('emptyNoCreate')}
              </p>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  )
}
