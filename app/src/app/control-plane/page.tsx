import Link from 'next/link'
import { getDashboardStats, listAgents, listTickets } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { personaFor, humanStatus } from '@/lib/agent-persona'
import { TICKET_STATE_LABELS, TICKET_STATE_TONE } from '@/lib/ticket-labels'

function greeting() {
  const h = new Date().getHours()
  if (h < 10) return 'Jó reggelt'
  if (h < 18) return 'Szép napot'
  return 'Jó estét'
}

export default async function DashboardPage() {
  const [statsRes, agentsRes, ticketsRes] = await Promise.all([
    getDashboardStats(),
    listAgents(),
    listTickets(),
  ])

  const stats = statsRes.success ? statsRes.data : null
  const agents = agentsRes.success ? agentsRes.data : []
  const tickets = ticketsRes.success ? ticketsRes.data : []
  const awaitingHuman = tickets.filter((t) => t.state === 'awaiting_human').length
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

      {/* Stat strip — soft cream tiles, each with a face */}
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

        <div className="grid gap-4 md:grid-cols-3">
          {agents.slice(0, 3).map((agent) => {
            const p = personaFor(agent.name)
            const mood = humanStatus(agent.status)
            return (
              <Link key={agent.id} href={`/control-plane/agents/${agent.id}`}>
                <Card className="h-full transition-transform duration-200 hover:-translate-y-1">
                  <div className="flex items-center gap-4">
                    <AgentAvatar name={agent.name} status={agent.status} size="md" />
                    <div className="min-w-0">
                      <p className="font-display text-xl font-semibold leading-tight">{p.nickname}</p>
                      <p className="truncate text-xs text-ink-faint">{agent.name}</p>
                      <p className="mt-1 text-xs font-medium text-sage">{mood.label}</p>
                    </div>
                  </div>
                  <p className="mt-4 text-sm italic leading-relaxed text-ink-soft">“{p.greeting}”</p>
                </Card>
              </Link>
            )
          })}
          {agents.length === 0 && (
            <Card className="md:col-span-3">
              <p className="text-sm text-ink-faint">
                Még senki sincs a csapatban — futtasd:{' '}
                <code className="rounded bg-night-2 px-1.5 py-0.5 font-mono text-xs">
                  npm run db:seed
                </code>
              </p>
            </Card>
          )}
        </div>
      </section>

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
              { href: '/sandbox', label: 'Wiki Sandbox → tölts fel tudást és kérdezz rá' },
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

      <Card title="Legutóbbi ügyek">
        <ul className="divide-y divide-line">
          {tickets.slice(0, 6).map((ticket) => (
            <li
              key={ticket.id}
              className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <Link
                href={`/control-plane/tickets/${ticket.id}`}
                className="font-medium hover:text-coral-deep"
              >
                {ticket.title}
              </Link>
              <Badge tone={TICKET_STATE_TONE[ticket.state] ?? 'neutral'}>
                {TICKET_STATE_LABELS[ticket.state] ?? ticket.state}
              </Badge>
            </li>
          ))}
          {tickets.length === 0 && <p className="py-2 text-sm text-ink-faint">Még nincs ügy</p>}
        </ul>
      </Card>
    </div>
  )
}
