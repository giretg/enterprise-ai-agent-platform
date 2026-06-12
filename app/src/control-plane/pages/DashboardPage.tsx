import { Link } from 'react-router-dom'
import { Badge } from '../../shared/components/Badge'
import { Card, StatCard } from '../../shared/components/Card'
import { AgentAvatar } from '../../shared/components/AgentAvatar'
import { getPersona, humanStatus } from '../../shared/agent-persona'
import { useDemo } from '../../shared/context/DemoContext'
import { DemoGuide } from '../ControlPlaneLayout'

function formatNumber(n: number): string {
  return n.toLocaleString('hu-HU')
}

const statusWords: Record<string, string> = {
  backlog: 'sorban áll',
  in_review: 'átnézés alatt',
  approved: 'jóváhagyva',
  in_progress: 'folyamatban',
  awaiting_human: 'rád vár',
  done: 'kész',
}

export function DashboardPage() {
  const { stats, agents, tickets, auditLog, agentDetails } = useDemo()

  const detailList = Object.values(agentDetails)
  const recentTickets = tickets.slice(0, 4)
  const recentAudit = auditLog.slice(0, 3)
  const activeCount = agents.filter((a) => a.status === 'active').length

  return (
    <div>
      <DemoGuide />

      {/* Greeting hero */}
      <div className="rise-in mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <span className="animate-drift text-4xl" aria-hidden>
              👋
            </span>
            <div>
              <h1 className="font-display text-4xl font-semibold text-ink">
                Jó reggelt!
              </h1>
              <p className="mt-1 text-sm text-ink-soft">
                Ostoros-Novaj Agrár Kft. · 2026. június 12. ·{' '}
                <span className="text-sage">
                  {activeCount} munkatárs már dolgozik
                </span>
              </p>
            </div>
          </div>
        </div>
        <Badge variant="mono">napló-pecsét · {auditLog[0]?.hash ?? '—'}</Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="A csapatod"
          value={`${stats.activeAgents} aktív`}
          sub={`${agents.length} munkatárs összesen`}
          accent="violet"
          icon="🧑‍🤝‍🧑"
        />
        <StatCard
          label="Feladatok"
          value={stats.openTickets}
          sub="folyamatban a táblán"
          accent="sky"
          icon="📋"
        />
        <StatCard
          label="Mai munka"
          value={formatNumber(stats.tokensToday)}
          sub={`gondolat · ≈ €${stats.costTodayEur.toFixed(2)}`}
          accent="amber"
          icon="⚡"
        />
        <StatCard
          label="Biztonság"
          value="Minden rendben"
          sub="0 fennakadás az elmúlt 24 órában"
          accent="green"
          icon="🛡️"
        />
      </div>

      {/* Team today */}
      <div className="mb-4 mt-10 flex items-center justify-between">
        <h2 className="font-display text-2xl font-semibold text-ink">
          A csapat ma
        </h2>
        <Link
          to="/control-plane/agents"
          className="text-sm font-medium text-honey hover:underline"
        >
          Mindenki →
        </Link>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {detailList.map((agent, i) => {
          const persona = getPersona(agent)
          const mood = humanStatus(agent.status)
          const job = tickets.find(
            (t) => t.agentId === agent.id && t.status !== 'done',
          )
          return (
            <Link
              key={agent.id}
              to={`/control-plane/agents/${agent.id}`}
              className="atelier-card lift rise-in flex items-start gap-4 p-5"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <AgentAvatar agent={agent} size="md" />
              <div className="min-w-0">
                <p className="font-display text-lg font-semibold leading-tight text-ink">
                  {persona.nickname}
                </p>
                <p
                  className="mt-0.5 text-xs font-medium"
                  style={{ color: mood.color }}
                >
                  {mood.emoji} {mood.label}
                </p>
                <p className="mt-2 truncate text-sm text-ink-soft">
                  {job ? `📌 ${job.title}` : '☁️ Épp ráér — adj neki feladatot'}
                </p>
              </div>
            </Link>
          )
        })}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card
          title="Min dolgozunk"
          action={
            <Link
              to="/control-plane/board"
              className="text-xs font-medium text-honey hover:underline"
            >
              Tábla →
            </Link>
          }
        >
          <ul className="space-y-2.5">
            {recentTickets.map((t) => {
              const persona = t.agentId
                ? getPersona({ id: t.agentId, name: t.assignee })
                : null
              return (
                <li
                  key={t.id}
                  className="atelier-soft flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">
                      {t.title}
                    </p>
                    <p className="text-xs text-ink-faint">
                      {persona ? `${persona.emoji} ${persona.nickname}` : `🙋 ${t.assignee}`}{' '}
                      · {t.id}
                    </p>
                  </div>
                  <Badge variant={t.status === 'done' ? 'success' : 'info'}>
                    {statusWords[t.status] ?? t.status}
                  </Badge>
                </li>
              )
            })}
          </ul>
        </Card>

        <Card
          title="Napló — minden lépés feljegyezve"
          action={
            <Link
              to="/control-plane/audit"
              className="text-xs font-medium text-honey hover:underline"
            >
              Teljes napló →
            </Link>
          }
        >
          <div className="mb-3 flex items-center gap-2">
            <Badge variant="success">✓ Hitelesített</Badge>
            <Badge variant="mono">változtathatatlan</Badge>
          </div>
          <ol className="relative space-y-3 border-l border-white/10 pl-5">
            {recentAudit.map((entry) => (
              <li key={entry.id} className="relative">
                <span className="absolute -left-[1.42rem] top-1.5 h-2 w-2 rounded-full bg-honey" />
                <p className="text-sm text-ink">
                  <span className="font-medium">{entry.actor}</span>{' '}
                  <span className="text-sage">{entry.action}</span>
                </p>
                <p className="text-xs text-ink-faint">
                  {new Date(entry.timestamp).toLocaleString('hu-HU')} ·{' '}
                  {entry.resource}
                </p>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  )
}
