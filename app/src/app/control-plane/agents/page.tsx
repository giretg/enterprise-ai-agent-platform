import Link from 'next/link'
import { listAgents } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { personaFor, humanStatus } from '@/lib/agent-persona'

export default async function AgentRegistryPage() {
  const res = await listAgents()
  const agents = res.success ? res.data : []

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="animate-rise">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">A csapat</p>
          <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">
            Munkatársak, akikre számíthatsz
          </h1>
          <p className="mt-2 max-w-xl text-ink-soft">
            Minden agent egy-egy hús-vér munkatárs: saját névvel, stílussal és hangulattal. Kattints
            rájuk, és ismerd meg őket közelebbről.
          </p>
        </div>
        <Link
          href="/control-plane/agents/new"
          className="rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(178,58,85,0.7)] transition-transform hover:-translate-y-0.5"
        >
          + Új munkatárs
        </Link>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {agents.map((agent) => {
          const p = personaFor(agent.name)
          const mood = humanStatus(agent.status)
          return (
            <Link key={agent.id} href={`/control-plane/agents/${agent.id}`}>
              <Card className="h-full transition-transform duration-200 hover:-translate-y-1">
                <div className="flex items-start gap-4">
                  <AgentAvatar name={agent.name} status={agent.status} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="font-display text-2xl font-semibold leading-none">{p.nickname}</h2>
                      <span className="text-lg" aria-hidden>
                        {p.emoji}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-ink-faint">{agent.name}</p>
                    <p className="mt-1 text-xs font-medium text-sage">{mood.label}</p>
                  </div>
                  <Badge tone={agent.status === 'active' ? 'success' : 'neutral'}>
                    {agent.status === 'active' ? 'aktív' : 'pihen'}
                  </Badge>
                </div>

                <p className="mt-4 text-sm leading-relaxed text-ink-soft">{p.trait}</p>

                <div className="estate-rule my-4" />

                <div className="flex items-center justify-between text-xs text-ink-faint">
                  <span>{agent.roleDescription}</span>
                  <span className="font-mono">
                    v{agent.currentVersion} ·{' '}
                    {(agent.modelConfig as { model?: string }).model ?? '—'}
                  </span>
                </div>
              </Card>
            </Link>
          )
        })}
        {agents.length === 0 && (
          <Card className="md:col-span-2">
            <p className="text-sm text-ink-faint">
              Még nincs munkatárs a csapatban — futtasd:{' '}
              <code className="rounded bg-night-2 px-1.5 py-0.5 font-mono text-xs">
                npm run db:seed
              </code>
            </p>
          </Card>
        )}
      </div>
    </div>
  )
}
