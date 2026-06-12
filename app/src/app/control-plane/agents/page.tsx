import Link from 'next/link'
import { listAgents } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

export default async function AgentRegistryPage() {
  const res = await listAgents()
  const agents = res.success ? res.data : []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-semibold">Agent Registry</h1>
        <Link
          href="/control-plane/agents/new"
          className="rounded-full bg-coral/20 px-4 py-2 text-sm font-semibold text-coral hover:bg-coral/30"
        >
          + Új agent
        </Link>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {agents.map((agent) => (
          <Link key={agent.id} href={`/control-plane/agents/${agent.id}`}>
            <Card className="transition hover:border-coral/40">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-display text-xl font-semibold">{agent.name}</h2>
                  <p className="mt-1 text-sm text-ink-soft">{agent.roleDescription}</p>
                </div>
                <Badge tone={agent.status === 'active' ? 'success' : 'neutral'}>{agent.status}</Badge>
              </div>
              <p className="mt-4 text-xs text-ink-faint">
                v{agent.currentVersion} · {(agent.modelConfig as { model?: string }).model ?? '—'}
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
