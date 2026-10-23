import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { listHandoffInboxAction } from '@/app/actions/handoff'
import { listPendingGatewayOperationsAction } from '@/app/actions/gateway-operation'
import { listAgentsForCatalog } from '@/app/actions/platform'
import { hasMinimumRole } from '@/auth/types'
import { AgentCatalogCard } from '@/components/agents/agent-catalog-card'
import { Card } from '@/components/ui/shell'
import { asTranslate } from '@/i18n/translate'
import { requireControlPlaneTenantViewer } from '@/lib/default-agent-workspace'
import {
  COMPANY_CONNECTOR_TYPES,
  lastMcpUseByUser,
  onboardingSteps,
  type OnboardingStepKey,
} from '@/lib/overview-onboarding'
import { repositories } from '@/repositories/postgres'
import { operationErrorLabel } from '../operations/labels'
import { HandoffsPanel } from '../operations/handoffs-panel'
import { OperationsPanel } from '../operations/operations-panel'

export const dynamic = 'force-dynamic'

const OVERVIEW_TASK_LIMIT = 2

const STEP_HREF: Record<OnboardingStepKey, string> = {
  connectors: '/control-plane/provisioning',
  agents: '/control-plane/agents/new',
  mcp: '/control-plane/get-started',
}

export default async function DashboardPage() {
  const ctx = await requireControlPlaneTenantViewer()
  const tenantId = ctx.activeTenantId
  const userId = ctx.user.id
  const isAdmin = hasMinimumRole(ctx.activeTenantRole, 'admin')
  const canCreateAgent = isAdmin
  const [agentsRes, listed, inbox, mcpUse, connectors, members] = await Promise.all([
    listAgentsForCatalog({ limit: 100 }),
    listPendingGatewayOperationsAction(),
    listHandoffInboxAction(),
    // Operátor csak a saját MCP-állapotát látja; a tenant-szintű kép admin-nézet.
    lastMcpUseByUser(tenantId, isAdmin ? undefined : userId),
    isAdmin
      ? repositories.connectors
          .listForTenant(tenantId)
          .then((rows) =>
            rows.filter((c) => c.lifecycleState === 'active' && COMPANY_CONNECTOR_TYPES.includes(c.type)),
          )
      : [],
    isAdmin
      ? repositories.tenantMemberships
          .findByTenantWithUsers(tenantId)
          .then((rows) => rows.filter((m) => m.status === 'active'))
      : [],
  ])
  const agents = agentsRes.success ? agentsRes.data : []
  const operations = listed.success ? listed.data.operations : []
  const handoffs = inbox.success ? inbox.data.handoffs : []
  const t = await getTranslations('ControlPlane.dashboard')
  const tAgents = await getTranslations('ControlPlane.agents')
  const tOps = asTranslate(await getTranslations('ControlPlane.operations'))
  const tOnb = await getTranslations('ControlPlane.dashboard.onboarding')
  const tRoles = await getTranslations('PlatformIam')
  const locale = await getLocale()
  const formatDate = (date: Date) => date.toLocaleDateString(locale, { dateStyle: 'medium' })
  const ownMcpUse = mcpUse.get(userId)
  const steps = onboardingSteps({
    isAdmin,
    companyConnectorCount: connectors.length,
    agentCount: agents.length,
    mcpUsed: Boolean(ownMcpUse),
  })
  const doneCount = steps.filter((step) => step.done).length
  const mcpUserCount = members.filter((m) => mcpUse.has(m.userId)).length
  const totalTasks = operations.length + handoffs.length
  const tasksEmpty = listed.success && inbox.success && totalTasks === 0
  const previewOperations = operations.slice(0, OVERVIEW_TASK_LIMIT)
  const previewHandoffs = handoffs.slice(0, OVERVIEW_TASK_LIMIT - previewOperations.length)

  return (
    <div className="space-y-10">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
      </div>

      {doneCount < steps.length ? (
        <section className="space-y-4" aria-labelledby="onboarding-title">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="onboarding-title" className="font-display text-xl font-semibold">
              {tOnb('title')}
            </h2>
            <p className="text-sm text-ink-soft">{tOnb('progress', { done: doneCount, total: steps.length })}</p>
          </div>
          <p className="text-sm text-ink-soft">{isAdmin ? tOnb('introAdmin') : tOnb('introMember')}</p>
          <ol className="space-y-3">
            {steps.map((step, index) => (
              <li
                key={step.key}
                className={`flex flex-wrap items-start gap-4 rounded-2xl border p-4 ${
                  step.done ? 'border-ink/10 bg-paper' : 'border-coral/35 bg-white'
                }`}
              >
                <span
                  aria-hidden
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                    step.done ? 'bg-emerald-600 text-white' : 'border border-coral text-coral'
                  }`}
                >
                  {step.done ? '✓' : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold">
                    {tOnb(`${step.key}.title`)}
                    <span className="sr-only"> — {step.done ? tOnb('doneLabel') : tOnb('todoLabel')}</span>
                  </h3>
                  <p className="mt-1 text-sm text-ink-soft">
                    {step.done ? tOnb(`${step.key}.done`) : tOnb(`${step.key}.todo`)}
                  </p>
                </div>
                {step.done ? null : (
                  <Link
                    href={STEP_HREF[step.key]}
                    className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white hover:bg-coral/90"
                  >
                    {tOnb(`${step.key}.action`)}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : !isAdmin && ownMcpUse ? (
        <p className="rounded-2xl border border-ink/10 bg-paper p-4 text-sm text-ink">
          <span aria-hidden className="mr-2 text-emerald-600">✓</span>
          {tOnb('mcpInUse', { date: formatDate(ownMcpUse) })}
        </p>
      ) : null}

      <section className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-xl font-semibold">{t('tasksTitle')}</h2>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            {tasksEmpty ? null : <span className="text-ink-soft">{t('tasksTotal', { count: totalTasks })}</span>}
            <Link href="/control-plane/operations" className="text-coral-deep hover:underline">
              {t('tasksAll')}
            </Link>
          </div>
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
        {listed.success && previewOperations.length > 0 ? (
          <OperationsPanel operations={previewOperations} />
        ) : null}
        {inbox.success && previewHandoffs.length > 0 ? (
          <HandoffsPanel handoffs={previewHandoffs} hideIntro />
        ) : null}
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
              <AgentCatalogCard key={agent.id} agent={agent} canResumeHire={canCreateAgent} />
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

      {isAdmin ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-xl font-semibold">{tOnb('connectorsTitle')}</h2>
            <Link
              href={STEP_HREF.connectors}
              className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white hover:bg-coral/90"
            >
              {tOnb('connectors.action')}
            </Link>
          </div>
          {connectors.length === 0 ? (
            <p className="text-sm text-ink-soft">{tOnb('connectorsEmpty')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {connectors.map((connector) => (
                <li key={connector.id} className="rounded-full border border-ink/10 bg-white px-3 py-1 text-sm">
                  {connector.name}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {isAdmin ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="font-display text-xl font-semibold">{tOnb('usersTitle')}</h2>
              <p className="mt-1 text-sm text-ink-soft">
                {tOnb('usersSummary', { used: mcpUserCount, total: members.length })}
              </p>
            </div>
            <Link href="/control-plane/iam" className="text-sm text-coral-deep hover:underline">
              {tOnb('usersAll')}
            </Link>
          </div>
          <ul className="divide-y divide-ink/10 rounded-2xl border border-ink/10 bg-white">
            {members.map((member) => {
              const usedAt = mcpUse.get(member.userId)
              return (
                <li key={member.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{member.userName || member.userEmail}</p>
                    <p className="text-xs text-ink-soft">
                      {member.userName ? `${member.userEmail} · ` : ''}
                      {tRoles(`roleLabel_${member.role}`)}
                    </p>
                  </div>
                  {usedAt ? (
                    <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                      ✓ {tOnb('userMcpUsed', { date: formatDate(usedAt) })}
                    </span>
                  ) : (
                    <span className="rounded-full bg-paper px-3 py-1 text-xs text-ink-soft">
                      {tOnb('userMcpNever')}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
