import Link from 'next/link'
import { getDashboardStats, listAgents, listTickets } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

export default async function DashboardPage() {
  const [statsRes, agentsRes, ticketsRes] = await Promise.all([
    getDashboardStats(),
    listAgents(),
    listTickets(),
  ])

  const stats = statsRes.success ? statsRes.data : null
  const agents = agentsRes.success ? agentsRes.data : []
  const tickets = ticketsRes.success ? ticketsRes.data : []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-ink-soft">Élő adatok a Postgres-ből</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <p className="text-sm text-ink-faint">Aktív agentek</p>
          <p className="mt-2 font-display text-3xl">{stats?.activeAgents ?? '—'}</p>
        </Card>
        <Card>
          <p className="text-sm text-ink-faint">Nyitott ticketek</p>
          <p className="mt-2 font-display text-3xl">{stats?.openTickets ?? '—'}</p>
        </Card>
        <Card>
          <p className="text-sm text-ink-faint">Token ma</p>
          <p className="mt-2 font-display text-3xl">
            {stats ? stats.tokensToday.toLocaleString('hu-HU') : '—'}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-ink-faint">Költség ma (EUR)</p>
          <p className="mt-2 font-display text-3xl">
            {stats ? stats.costTodayEur.toFixed(4) : '—'}
          </p>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Agentek">
          <ul className="space-y-3">
            {agents.map((agent) => (
              <li key={agent.id} className="flex items-center justify-between atelier-soft p-3">
                <div>
                  <Link href={`/control-plane/agents/${agent.id}`} className="font-medium hover:text-coral">
                    {agent.name}
                  </Link>
                  <p className="text-xs text-ink-faint">{agent.roleDescription}</p>
                </div>
                <Badge tone={agent.status === 'active' ? 'success' : 'neutral'}>{agent.status}</Badge>
              </li>
            ))}
            {agents.length === 0 && <p className="text-sm text-ink-faint">Nincs agent — futtasd: npm run db:seed</p>}
          </ul>
        </Card>

        <Card title="Legutóbbi ticketek">
          <ul className="space-y-3">
            {tickets.slice(0, 6).map((ticket) => (
              <li key={ticket.id} className="flex items-center justify-between atelier-soft p-3">
                <Link href={`/control-plane/tickets/${ticket.id}`} className="font-medium hover:text-coral">
                  {ticket.title}
                </Link>
                <Badge>{ticket.state}</Badge>
              </li>
            ))}
            {tickets.length === 0 && <p className="text-sm text-ink-faint">Még nincs ticket</p>}
          </ul>
        </Card>
      </div>
    </div>
  )
}
