import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { listAgents, listBoardAssignees, listBoardTickets } from '@/app/actions/platform'
import { listProcesses } from '@/app/actions/process'
import { KanbanBoard } from '@/components/tickets/kanban-board'

const RECENT_PROCESS_LIMIT = 20

export default async function BoardPage() {
  const ctx = await getAuthContext()
  const canCreate = hasMinimumRole(ctx?.activeTenantRole, 'operator')

  const [ticketsRes, agentsRes, assigneesRes, processesRes] = await Promise.all([
    listBoardTickets(),
    listAgents(),
    canCreate ? listBoardAssignees() : Promise.resolve(null),
    listProcesses({ limit: RECENT_PROCESS_LIMIT }),
  ])
  const tickets = ticketsRes.success ? ticketsRes.data.tickets : []
  const ticketsHasMore = ticketsRes.success ? ticketsRes.data.hasMore : false
  const agents = agentsRes.success ? agentsRes.data : []
  const assigneeOptions =
    assigneesRes && assigneesRes.success ? assigneesRes.data : undefined
  const recentProcesses = processesRes.success ? processesRes.data : []
  const loadError = !ticketsRes.success ? ticketsRes.error : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold">Kanban Board</h1>
        <p className="mt-1 text-ink-soft">
          Húzd a kártyát oszlopok között — a szerver validálja az átmenetet
          {canCreate ? ', vagy nyiss új feladatot hozzárendeléssel' : ''}
        </p>
      </div>

      {loadError && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          Nem sikerült betölteni a feladatokat: {loadError}
        </p>
      )}

      {ticketsHasMore && (
        <p className="rounded-lg border border-honey/40 bg-honey/10 px-4 py-2 text-sm text-ink-soft">
          A tábla a legutóbb frissült feladatok egy oldalát mutatja. Régebbi elemekhez szűrj vagy
          nyisd meg a feladat részleteit.
        </p>
      )}

      <KanbanBoard
        tickets={tickets}
        agents={agents}
        canCreate={canCreate}
        assigneeOptions={assigneeOptions}
        recentProcesses={recentProcesses}
      />
    </div>
  )
}
