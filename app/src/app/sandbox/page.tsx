import Link from 'next/link'
import { listAgents } from '@/app/actions/platform'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { Badge, Card } from '@/components/ui/shell'
import { sandboxKindForAgent, sandboxLabelForKind } from '@/lib/agent-kind'
import { personaFor } from '@/lib/agent-persona'

export default async function SandboxIndexPage() {
  const res = await listAgents()
  const agents = res.success ? res.data : []

  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sage">Sandboxok</p>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">
          Válassz agent munkateret
        </h1>
        <p className="mt-2 max-w-xl text-ink-soft">
          Minden agent saját sandboxot kap. A wiki agent tudásbázist kezel, a könyvelő agent
          számlákat dolgoz fel, az új agentekhez pedig külön munkafelület köthető.
        </p>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {agents.map((agent) => {
          const persona = personaFor(agent.name, agent)
          const kind = sandboxKindForAgent(agent)
          return (
            <Link key={agent.id} href={`/sandbox/${agent.id}`}>
              <Card className="h-full transition-transform duration-200 hover:-translate-y-1">
                <div className="flex items-start gap-4">
                  <AgentAvatar name={agent.name} status={agent.status} size="lg" avatarUrl={agent.avatarUrl} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-display text-2xl font-semibold leading-none">
                        {persona.nickname}
                      </h2>
                      <Badge tone={kind === 'generic' ? 'neutral' : 'success'}>
                        {sandboxLabelForKind(kind)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-ink-faint">{agent.name}</p>
                    <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                      {agent.roleInstruction}
                    </p>
                  </div>
                </div>
              </Card>
            </Link>
          )
        })}

        {agents.length === 0 && (
          <Card className="md:col-span-2">
            <p className="text-sm text-ink-faint">
              Még nincs agent a sandboxhoz. Futtasd:{' '}
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
