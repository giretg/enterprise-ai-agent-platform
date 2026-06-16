import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getAgent, getAgentGovernance } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { personaFor, humanStatus } from '@/lib/agent-persona'
import { sandboxKindForAgent, sandboxLabelForKind } from '@/lib/agent-kind'

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ agentId: string }>
}) {
  const { agentId } = await params
  const [res, govRes] = await Promise.all([
    getAgent({ id: agentId }),
    getAgentGovernance({ agentId }),
  ])
  if (!res.success) notFound()

  const { agent, memoryContent, memoryVersion, recipe, resources, apiKeyPreview } = res.data
  const governance = govRes.success ? govRes.data : null
  const modelConfig = agent.modelConfig as Record<string, unknown>
  const persona = personaFor(agent.name)
  const mood = humanStatus(agent.status)
  const sandboxKind = sandboxKindForAgent(agent)

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
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href={`/sandbox/${agent.id}`}
            className="rounded-full bg-sage px-5 py-2.5 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(93,138,79,0.7)] transition-transform hover:-translate-y-0.5"
          >
            Sandbox megnyitása
          </Link>
          <Badge tone={sandboxKind === 'generic' ? 'neutral' : 'success'}>
            {sandboxLabelForKind(sandboxKind)}
          </Badge>
        </div>
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
        <Card title="Recipe">
          {recipe ? (
            <div className="space-y-1 text-sm">
              <p className="font-medium">{recipe.name}</p>
              <p className="text-ink-faint">
                {recipe.ticketType} · v{recipe.version} · {recipe.status}
              </p>
            </div>
          ) : (
            <p className="text-sm text-ink-faint">Nincs recipe kötve ehhez a verzióhoz.</p>
          )}
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

      {governance && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Eszközjogok (capabilities)">
            {governance.capabilities.length === 0 ? (
              <p className="text-sm text-ink-faint">Nincs meghatározott eszközjog.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {governance.capabilities.map((cap) => (
                  <li key={cap.toolName} className="flex items-center justify-between atelier-soft p-3">
                    <span className="font-mono font-medium text-ink">{cap.toolName}</span>
                    <Badge tone={cap.allowed ? 'success' : 'danger'}>
                      {cap.allowed ? 'engedélyezett' : 'tiltott'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Connectorok">
            {governance.connectors.length === 0 ? (
              <p className="text-sm text-ink-faint">Nincs connector hozzárendelve.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {governance.connectors.map(({ connector, accessMode }) => (
                  <li key={connector.id} className="atelier-soft p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-ink">{connector.name}</span>
                      <Badge tone={accessMode === 'write' ? 'warning' : 'neutral'}>
                        {accessMode}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-ink-faint">
                      {connector.type} · {connector.scope}
                      {connector.secretAlias && ` · secret: ${connector.secretAlias}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

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
