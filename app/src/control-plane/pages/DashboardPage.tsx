import { Link } from 'react-router-dom'
import { Badge } from '../../shared/components/Badge'
import { Card, StatCard } from '../../shared/components/Card'
import { useDemo } from '../../shared/context/DemoContext'
import { DemoGuide } from '../ControlPlaneLayout'

function formatNumber(n: number): string {
  return n.toLocaleString('hu-HU')
}

export function DashboardPage() {
  const { stats, agents, tickets, auditLog } = useDemo()

  const guardrailBadge =
    stats.guardrailStatus === 'ok'
      ? { variant: 'success' as const, label: 'Minden guardrail OK' }
      : stats.guardrailStatus === 'warning'
        ? { variant: 'warning' as const, label: 'Figyelmeztetés' }
        : { variant: 'danger' as const, label: 'Blokkolva' }

  const recentTickets = tickets.slice(0, 4)
  const recentAudit = auditLog.slice(0, 3)

  return (
    <div>
      <DemoGuide />
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-50">
            Irányítóközpont
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Ostoros-Novaj Agrár Kft. — 2026. június 12.
          </p>
        </div>
        <Badge variant="mono">hash-lánc: {auditLog[0]?.hash ?? '—'}</Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Aktív agentek"
          value={stats.activeAgents}
          sub={`${agents.length} regisztrálva`}
          accent="violet"
        />
        <StatCard
          label="Nyitott ticketek"
          value={stats.openTickets}
          sub="Board összes oszlop"
          accent="sky"
        />
        <StatCard
          label="Token ma"
          value={formatNumber(stats.tokensToday)}
          sub={`≈ €${stats.costTodayEur.toFixed(2)} költség`}
          accent="amber"
        />
        <StatCard
          label="Guardrail"
          value={guardrailBadge.label}
          sub="0 sértés az elmúlt 24 órában"
          accent="green"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card
          title="Aktív agentek"
          action={
            <Link
              to="/control-plane/agents"
              className="text-xs text-sky-400 hover:text-sky-300"
            >
              Registry →
            </Link>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-xs uppercase text-slate-500">
                  <th className="pb-2 pr-4">Név</th>
                  <th className="pb-2 pr-4">Modell</th>
                  <th className="pb-2 pr-4">Verzió</th>
                  <th className="pb-2">Állapot</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id} className="border-b border-slate-800/60">
                    <td className="py-2.5 pr-4 font-medium text-slate-200">
                      {agent.name}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-slate-400">
                      {agent.model}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge variant="mono">v{agent.version}</Badge>
                    </td>
                    <td className="py-2.5">
                      <Badge
                        variant={
                          agent.status === 'active' ? 'success' : 'warning'
                        }
                      >
                        {agent.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          title="Legutóbbi ticketek"
          action={
            <Link
              to="/control-plane/board"
              className="text-xs text-sky-400 hover:text-sky-300"
            >
              Board →
            </Link>
          }
        >
          <ul className="space-y-3">
            {recentTickets.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between rounded border border-slate-700/50 bg-slate-900/40 px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium text-slate-200">{t.title}</p>
                  <p className="text-xs text-slate-500">{t.id}</p>
                </div>
                <Badge variant={t.status === 'done' ? 'success' : 'info'}>
                  {t.status.replace('_', ' ')}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card
        title="Audit előnézet (append-only)"
        className="mt-6"
        action={
          <Link
            to="/control-plane/audit"
            className="text-xs text-sky-400 hover:text-sky-300"
          >
            Teljes napló →
          </Link>
        }
      >
        <div className="mb-3 flex items-center gap-2">
          <Badge variant="success">Audited</Badge>
          <Badge variant="mono">tamper-evident hash-lánc</Badge>
        </div>
        <div className="space-y-2 font-mono text-xs">
          {recentAudit.map((entry) => (
            <div
              key={entry.id}
              className="rounded border border-slate-700/40 bg-slate-900/50 px-3 py-2 text-slate-400"
            >
              <span className="text-slate-500">
                {new Date(entry.timestamp).toLocaleString('hu-HU')}
              </span>{' '}
              <span className="text-slate-300">{entry.actor}</span>{' '}
              <span className="text-emerald-400">{entry.action}</span>{' '}
              <span className="text-slate-500">→ {entry.resource}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
