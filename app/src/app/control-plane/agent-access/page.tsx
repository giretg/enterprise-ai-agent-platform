import { requireTenantRole } from '@/auth/tenant-context'
import { loadAgentAccessGraph } from '@/app/actions/agent-access'
import { AgentAccessGraphEditor } from '@/components/agents/agent-access-graph-editor'

/**
 * Kapcsolati ábra — az agent-hozzáférési gráf admin felülete (issue #142).
 *
 * Tenant admin jog. A superadmin csak assume-tenant kontextusban, a tenant nevében
 * jár el — a `requireTenantRole` guard ezt kényszeríti ki.
 */
export default async function AgentAccessPage() {
  const user = await requireTenantRole('admin')
  const graph = await loadAgentAccessGraph()

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Kapcsolatok</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Ki kivel dolgozhat</h1>
        <p className="mt-1 max-w-3xl text-ink-soft">
          Itt állítod be, hogy a munkatársak és az agentek kiket látnak, és kiket szólíthatnak
          meg. Alapból a szervezeten belül mindenki elér mindenkit — szűkíteni ott érdemes, ahol
          egy agent érzékeny munkát végez.
        </p>
      </div>

      {user.activeTenantId && graph.success ? (
        <AgentAccessGraphEditor tenantId={user.activeTenantId} initialGraph={graph.data} />
      ) : (
        <p className="text-sm text-ink-faint">
          {graph.success ? 'Nincs aktív szervezet.' : graph.error}
        </p>
      )}
    </div>
  )
}
