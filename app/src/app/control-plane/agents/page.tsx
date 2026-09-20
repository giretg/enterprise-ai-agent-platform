import Link from 'next/link'
import { listAgents } from '@/app/actions/platform'
import { hasMinimumRole } from '@/auth/types'
import { Card } from '@/components/ui/shell'
import { requireControlPlaneTenantViewer } from '@/lib/default-agent-workspace'
import { personaFor } from '@/lib/agent-persona'

export const dynamic = 'force-dynamic'

export default async function AgentsIndexPage() {
  const ctx = await requireControlPlaneTenantViewer()
  const agentsRes = await listAgents({ limit: 100 })
  const agents = agentsRes.success ? agentsRes.data : []
  const loadError = agentsRes.success ? null : agentsRes.error
  const canCreateAgent = hasMinimumRole(ctx.activeTenantRole, 'admin')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Munkatársak</p>
          <h1 className="mt-2 font-display text-3xl font-semibold">Agentek</h1>
          <p className="mt-1 max-w-2xl text-ink-soft">
            Definíció, skill és konnektor — a published snapshot az MCP-n olvasható.
          </p>
        </div>
        {canCreateAgent ? (
          <Link
            href="/control-plane/agents/new"
            className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white hover:bg-coral/90"
          >
            Új munkatárs
          </Link>
        ) : null}
      </div>
      {loadError ? (
        <div className="rounded-2xl border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          A munkatársak most nem tölthetők be.
          <span className="mt-1 block text-xs opacity-70">{loadError}</span>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {agents.map((agent) => {
            const persona = personaFor(agent.name)
            return (
              <Link key={agent.id} href={`/control-plane/agents/${agent.id}`}>
                <Card title={persona.nickname || agent.name}>
                  {agent.description ? (
                    <p className="text-sm text-ink">{agent.description}</p>
                  ) : null}
                  <p className="mt-1 text-sm text-ink-soft">{agent.status}</p>
                </Card>
              </Link>
            )
          })}
          {agents.length === 0 ? (
            <Card title="Még nincs munkatárs">
              <p className="text-sm text-ink-soft">
                Ebben a szervezetben még nincs AI-munkatárs.
                {canCreateAgent
                  ? ' Vedd fel az elsőt az „Új munkatárs” gombbal.'
                  : ' Kérj egy admint, hogy vegyen fel egyet.'}
              </p>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  )
}
