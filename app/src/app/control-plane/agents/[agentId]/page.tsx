import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getAgent } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="font-display text-3xl font-semibold">{agent.name}</h1>
        <Badge tone="success">{agent.status}</Badge>
      </div>

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
