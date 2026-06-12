import { Link } from 'react-router-dom'
import { AgentAvatar } from '../../shared/components/AgentAvatar'
import { getPersona, humanStatus } from '../../shared/agent-persona'
import { useDemo } from '../../shared/context/DemoContext'

export function AgentRegistryPage() {
  const { agentDetails } = useDemo()
  const agentList = Object.values(agentDetails)

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="rise-in">
          <p className="text-sm font-semibold uppercase tracking-wider text-coral">
            A csapatod
          </p>
          <h1 className="font-display mt-1 text-4xl font-semibold text-ink">
            Ismerd meg a kollégákat
          </h1>
          <p className="mt-2 max-w-xl text-sm text-ink-soft">
            Hús-vér gondolkodású AI-munkatársak — mindegyiknek megvan a maga
            szakterülete, stílusa és emléke. Kattints rá bármelyikre, és nézz be
            a fejébe.
          </p>
        </div>
        <Link
          to="/control-plane/agents/new"
          className="group rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-night shadow-[0_10px_30px_-10px_var(--color-coral)] transition-transform hover:-translate-y-0.5"
        >
          <span className="mr-1 inline-block transition-transform group-hover:rotate-90">
            ＋
          </span>
          Új munkatárs felvétele
        </Link>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {agentList.map((agent, i) => {
          const persona = getPersona(agent)
          const mood = humanStatus(agent.status)
          return (
            <Link
              key={agent.id}
              to={`/control-plane/agents/${agent.id}`}
              className="atelier-card lift rise-in group flex flex-col p-6"
              style={{ animationDelay: `${i * 90}ms` }}
            >
              <div className="flex items-center gap-4">
                <AgentAvatar agent={agent} size="lg" />
                <div className="min-w-0">
                  <p className="font-display text-2xl font-semibold leading-tight text-ink">
                    {persona.nickname}
                  </p>
                  <p className="truncate text-sm text-ink-soft">{agent.name}</p>
                </div>
              </div>

              <p className="mt-4 flex-1 text-sm leading-relaxed text-ink-soft">
                “{persona.blurb}”
              </p>

              <div className="mt-5 space-y-2.5 text-sm">
                <div className="flex items-center gap-2 text-ink-soft">
                  <span aria-hidden>💪</span>
                  <span>{persona.superpower}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                    style={{ background: `${mood.dot}1f`, color: mood.color }}
                  >
                    <span aria-hidden>{mood.emoji}</span>
                    {mood.label}
                  </span>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between border-t border-white/8 pt-4 text-xs text-ink-faint">
                <span className="font-mono">
                  agya: {agent.modelConfig.model} · v{agent.version}
                </span>
                <span className="font-medium text-honey transition-transform group-hover:translate-x-0.5">
                  Ismerd meg →
                </span>
              </div>
            </Link>
          )
        })}

        <Link
          to="/control-plane/agents/new"
          className="atelier-soft lift group flex min-h-[18rem] flex-col items-center justify-center gap-3 border-dashed p-6 text-center"
        >
          <span className="text-4xl transition-transform group-hover:scale-110" aria-hidden>
            🫶
          </span>
          <p className="font-display text-xl font-semibold text-ink">
            Bővítenéd a csapatot?
          </p>
          <p className="max-w-[16rem] text-sm text-ink-soft">
            Pár lépésben felveszel egy új AI-munkatársat, és kioktatod a dolgára.
          </p>
        </Link>
      </div>
    </div>
  )
}
