import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getDashboardStats, listAgents, listBoardAssignees } from '@/app/actions/platform'
import { getCurrentUser } from '@/auth'
import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { Badge, Card } from '@/components/ui/shell'
import { DashboardAgentCard } from '@/components/agents/dashboard-agent-card'
import { DashboardRunsList } from '@/components/active-runs/dashboard-runs-list'
import { loadActiveRuns } from '@/lib/active-runs-load'
import { summarizeAgentActivity } from '@/lib/agent-activity'

function greeting() {
  const h = new Date().getHours()
  if (h < 10) return 'Jó reggelt'
  if (h < 18) return 'Szép napot'
  return 'Jó estét'
}

export default async function DashboardPage() {
  const me = await getCurrentUser()
  if (me && (me.status !== 'active' || !me.role)) {
    redirect('/control-plane/pending')
  }

  const ctx = await getAuthContext()
  const isAdmin = hasMinimumRole(ctx?.activeTenantRole, 'admin')
  const canCreateTicket = hasMinimumRole(ctx?.activeTenantRole, 'operator')
  const canSeeRuns = hasMinimumRole(ctx?.activeTenantRole, 'operator')

  const [statsRes, agentsRes, activeRuns, assigneesRes] = await Promise.all([
    isAdmin ? getDashboardStats() : Promise.resolve({ success: false as const, error: '' }),
    listAgents(),
    canSeeRuns && ctx?.activeTenantId && ctx.user
      ? loadActiveRuns({
          tenantId: ctx.activeTenantId,
          userId: ctx.user.id,
          activeTenantRole: ctx.activeTenantRole,
        })
      : Promise.resolve([]),
    canCreateTicket ? listBoardAssignees() : Promise.resolve(null),
  ])

  const stats = isAdmin && statsRes.success ? statsRes.data : null
  const agents = agentsRes.success ? agentsRes.data : []
  const agentsLoadError = agentsRes.success ? null : agentsRes.error
  const assigneeOptions =
    assigneesRes && assigneesRes.success ? assigneesRes.data : undefined
  const awaitingHuman = activeRuns.filter(
    (r) => r.phase === 'active' && r.status === 'awaiting_human',
  ).length
  // A kártyák „min dolgozik / mi vár rád” sávja ebből él. A relatív időt itt,
  // szerveren formázzuk, hogy hidratáláskor ne térjen el a kliens szövegétől.
  const activityByAgent = summarizeAgentActivity(activeRuns)
  const activeCount = agents.filter((a) => a.status === 'active').length

  const statCards = [
    { icon: '🧑‍🌾', label: 'Csapat dolgozik', value: activeCount, tone: 'text-ink' },
    { icon: '📥', label: 'Nyitott ügy', value: stats?.openTickets ?? '—', tone: 'text-ink' },
    { icon: '🤝', label: 'Rád vár', value: awaitingHuman, tone: 'text-coral' },
    {
      icon: '🪙',
      label: 'Token ma',
      value: stats ? stats.tokensToday.toLocaleString('hu-HU') : '—',
      tone: 'text-ink',
    },
    {
      icon: '💶',
      label: 'Költség ma',
      value: stats ? `€${stats.costTodayEur.toFixed(4)}` : '—',
      tone: 'text-ink',
    },
  ]

  return (
    <div className="space-y-9">
      {/* Hero welcome — warm, human, estate-editorial */}
      <header className="animate-rise">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{greeting()}</p>
        <h1 className="mt-2 max-w-3xl font-display text-[2.6rem] font-semibold leading-[1.05]">
          A csapatod <span className="italic text-coral-deep">megfontoltan</span> dolgozik a háttérben.
        </h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-soft">
          {awaitingHuman > 0
            ? `${awaitingHuman} javaslat türelmesen vár a véleményedre. A többit nyugodtan rájuk bízhatod.`
            : 'Minden a helyén — nincs döntés, ami most rád várna. Nézz körül a pincében.'}
        </p>
      </header>

      {isAdmin && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {statCards.map((c) => (
            <Card key={c.label}>
              <span className="text-2xl" aria-hidden>
                {c.icon}
              </span>
              <p className={`mt-3 font-display text-[2rem] leading-none ${c.tone}`}>{c.value}</p>
              <p className="mt-1.5 text-sm text-ink-faint">{c.label}</p>
            </Card>
          ))}
        </div>
      )}

      {/* The team — lovable coworkers, front and centre */}
      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="font-display text-2xl font-semibold">A csapat ma</h2>
            <p className="text-sm text-ink-soft">
              Hús-vér munkatársak — mindegyiknek van neve és stílusa.
            </p>
          </div>
          <Link
            href="/control-plane/agents"
            className="text-sm font-semibold text-coral-deep hover:underline"
          >
            Egész csapat →
          </Link>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <DashboardAgentCard
              key={agent.id}
              agent={agent}
              canCreateTicket={canCreateTicket}
              assigneeOptions={assigneeOptions}
              activity={activityByAgent.get(agent.id)}
            />
          ))}
          {agentsLoadError && (
            <Card className="md:col-span-3 border-coral/40 bg-coral/5">
              <p className="text-sm font-medium text-coral-deep">A csapat betöltése sikertelen</p>
              <p className="mt-1 text-sm text-ink-soft">{agentsLoadError}</p>
            </Card>
          )}
          {!agentsLoadError && agents.length === 0 && (
            <Card className="md:col-span-3">
              <p className="text-sm text-ink-faint">Még senki sincs a csapatban ebben a tenantban.</p>
            </Card>
          )}
        </div>
      </section>

      {isAdmin && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Hogy állunk?" className="lg:col-span-1">
            <ul className="space-y-3 text-sm">
              <li className="flex items-center justify-between atelier-soft p-3">
                <span>Audit napló</span>
                <Badge tone="success">Aktív</Badge>
              </li>
              <li className="flex items-center justify-between atelier-soft p-3">
                <span>Emberi jóváhagyás</span>
                <Badge tone="success">Aktív</Badge>
              </li>
              <li className="flex items-center justify-between atelier-soft p-3">
                <span>Guardrail / PII</span>
                <Badge tone="warning">Fázis 2</Badge>
              </li>
              <li className="flex items-center justify-between atelier-soft p-3">
                <span>Hash-lánc audit</span>
                <Badge tone="success">Aktív</Badge>
              </li>
            </ul>
          </Card>

          <Card title="Nézzünk körül együtt" className="lg:col-span-2">
            <ol className="space-y-2.5 text-sm text-ink-soft">
              {[
                { href: '/control-plane/apps', label: 'Mini-appok → böngészőben megnyitható agent-felületek' },
                { href: '/control-plane/board', label: 'Tábla → nézd át és hagyd jóvá a választ' },
                { href: '/control-plane/audit', label: 'Audit → minden lépés visszakövethető' },
                { href: '/control-plane/training', label: 'Tanítás → finomítsd a munkatársaid' },
              ].map((step, i) => (
                <li key={step.href} className="flex items-center gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-coral/12 font-display text-sm font-semibold text-coral-deep">
                    {i + 1}
                  </span>
                  <Link href={step.href} className="hover:text-coral-deep">
                    {step.label}
                  </Link>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      )}

      {canSeeRuns && (
        <Card title="Legutóbbi ügyek">
          <p className="-mt-2 mb-3 text-xs text-ink-faint">
            Chat-válaszaid és a rád tartozó feladatok — kattints egy sorra a megnyitáshoz.
          </p>
          <DashboardRunsList initialRuns={activeRuns} />
        </Card>
      )}
    </div>
  )
}
