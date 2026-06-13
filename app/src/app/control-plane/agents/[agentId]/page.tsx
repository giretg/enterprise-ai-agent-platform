import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getAgent } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { personaFor, humanStatus } from '@/lib/agent-persona'

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ agentId: string }>
}) {
  const { agentId } = await params
  const res = await getAgent({ id: agentId })
  if (!res.success) notFound()

  const { agent, memoryContent, memoryVersion, resources, apiKeyPreview } = res.data
  const modelConfig = agent.modelConfig as Record<string, unknown>
  const persona = personaFor(agent.name)
  const mood = humanStatus(agent.status)

  return (
    <div className="space-y-6">
      <Link
        href="/control-plane/agents"
        className="inline-block text-sm font-medium text-ink-soft hover:text-coral-deep"
      >
        ← Vissza a csapathoz
      </Link>

      {/* Persona header — meet the coworker */}
      <Card className="animate-rise">
        <div className="flex flex-wrap items-center gap-5">
          <AgentAvatar name={agent.name} status={agent.status} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-[2.2rem] font-semibold leading-none">
                {persona.nickname}
              </h1>
              <span className="text-2xl" aria-hidden>
                {persona.emoji}
              </span>
              <Badge tone={agent.status === 'active' ? 'success' : 'neutral'}>{mood.label}</Badge>
            </div>
            <p className="mt-2 text-sm text-ink-faint">{agent.name}</p>
            <p className="mt-2 max-w-2xl text-base italic text-ink-soft">“{persona.greeting}”</p>
          </div>
        </div>
        <div className="estate-rule my-4" />
        <p className="text-sm leading-relaxed text-ink-soft">{persona.trait}</p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="System prompt">
          <pre className="whitespace-pre-wrap text-sm text-ink-soft">{agent.systemPrompt}</pre>
        </Card>
        <Card title="Modell konfig">
          <pre className="text-sm text-ink-soft">{JSON.stringify(modelConfig, null, 2)}</pre>
          <p className="mt-3 text-xs text-ink-faint">API kulcs: {apiKeyPreview ?? '—'}</p>
        </Card>
        <Card title={`Memória (v${memoryVersion ?? '?'})`}>
          <pre className="whitespace-pre-wrap text-sm text-ink-soft">{memoryContent ?? '(üres)'}</pre>
        </Card>
        <Card title="Erőforrások">
          <ul className="space-y-2 text-sm">
            {resources.map((r) => (
              <li key={r.id} className="atelier-soft p-3">
                <span className="font-medium">{r.name}</span>
                <span className="ml-2 text-ink-faint">
                  {r.type} · {r.scope} · v{r.version}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="Tanítás">
        <p className="text-sm text-ink-soft">
          Memória-verziózás és rollback a dedikált Tanítás képernyőn (C7).
        </p>
        <Link
          href={`/control-plane/training?agentId=${agent.id}`}
          className="mt-3 inline-block rounded-full bg-sky/20 px-4 py-2 text-sm font-semibold text-sky"
        >
          Tanítás megnyitása →
        </Link>
      </Card>
    </div>
  )
}
