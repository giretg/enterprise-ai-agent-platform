import Link from 'next/link'
import { listAgents } from '@/app/actions/platform'
import { listPendingGatewayOperationsAction } from '@/app/actions/gateway-operation'
import { hasMinimumRole } from '@/lib/iam-policy'
import { Card } from '@/components/ui/shell'
import { requireControlPlaneTenantViewer } from '@/lib/default-agent-workspace'
import { personaFor } from '@/lib/agent-persona'
import { OperationsPanel } from '../operations/operations-panel'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const ctx = await requireControlPlaneTenantViewer()
  const canApprove = hasMinimumRole(ctx.activeTenantRole, 'approver')
  const canCreateAgent = hasMinimumRole(ctx.activeTenantRole, 'admin')

  const [agentsRes, pendingRes] = await Promise.all([
    listAgents({ limit: 100 }),
    canApprove ? listPendingGatewayOperationsAction() : Promise.resolve(null),
  ])
  const agents = agentsRes.success ? agentsRes.data : []
  const pendingOperations = pendingRes?.success ? pendingRes.data.operations : []

  return (
    <div className="space-y-10">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Kezdőlap</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Áttekintés</h1>
      </div>

      {canApprove ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="flex items-center font-display text-xl font-semibold">
              Jóváhagyásra váró műveletek
              {pendingOperations.length > 0 ? (
                <span className="ml-2 rounded-full bg-coral px-2 py-0.5 text-xs font-semibold text-white">
                  {pendingOperations.length}
                </span>
              ) : null}
            </h2>
            <Link href="/control-plane/operations" className="text-sm text-coral-deep hover:underline">
              Összes megtekintése →
            </Link>
          </div>
          <OperationsPanel operations={pendingOperations} />
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-xl font-semibold">Munkatársak</h2>
          <Link href="/control-plane/agents" className="text-sm text-coral-deep hover:underline">
            Összes megtekintése →
          </Link>
        </div>
        {agentsRes.success ? (
          <div className="grid gap-4 md:grid-cols-2">
            {agents.map((agent) => {
              const persona = personaFor(agent.name)
              return (
                <Link key={agent.id} href={`/control-plane/agents/${agent.id}`}>
                  <Card title={persona.nickname || agent.name}>
                    {agent.description ? <p className="text-sm text-ink">{agent.description}</p> : null}
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
        ) : (
          <div className="rounded-2xl border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
            A munkatársak most nem tölthetők be.
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Egyéb</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Link href="/control-plane/skills">
            <Card title="Képességek (skill-ek)">
              <p className="text-sm text-ink-soft">Amit a munkatársaid tudnak.</p>
            </Card>
          </Link>
          <Link href="/control-plane/knowledge">
            <Card title="Tudásbázis">
              <p className="text-sm text-ink-soft">Dokumentumok és wiki-oldalak.</p>
            </Card>
          </Link>
          {hasMinimumRole(ctx.activeTenantRole, 'admin') ? (
            <Link href="/control-plane/provisioning">
              <Card title="Konnektorok">
                <p className="text-sm text-ink-soft">Csatlakoztatott külső rendszerek.</p>
              </Card>
            </Link>
          ) : null}
        </div>
      </section>
    </div>
  )
}
