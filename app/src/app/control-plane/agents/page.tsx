import Link from 'next/link'
import { listAgents } from '@/app/actions/platform'
import { requireTenantRole } from '@/auth/tenant-context'
import { Card } from '@/components/ui/shell'

export const dynamic = 'force-dynamic'

export default async function AgentsIndexPage() {
  await requireTenantRole('viewer')
  const agentsRes = await listAgents({ limit: 100 })
  const agents = agentsRes.success ? agentsRes.data : []

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Munkatársak</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Agentek</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Definíció, skill és konnektor — a published snapshot az MCP-n olvasható.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {agents.map((agent) => (
          <Link key={agent.id} href={`/control-plane/agents/${agent.id}`}>
            <Card title={agent.name}>
              <p className="text-sm text-ink-soft">{agent.status}</p>
            </Card>
          </Link>
        ))}
        {agents.length === 0 ? (
          <p className="text-sm text-ink-soft">Még nincs agent ebben a szervezetben.</p>
        ) : null}
      </div>
    </div>
  )
}
