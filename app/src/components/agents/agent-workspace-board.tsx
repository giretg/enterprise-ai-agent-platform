import { Suspense } from 'react'
import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { listBoardAssignees, listBoardTickets } from '@/app/actions/platform'
import { KanbanBoard } from '@/components/tickets/kanban-board'
import { BoardViewSwitcher, type BoardView } from '@/components/tickets/board-view-switcher'
import { resolveBoardDateRange } from '@/lib/board-date-range'

export async function AgentWorkspaceBoard({
  agentId,
  searchParams,
}: {
  agentId: string
  searchParams: { from?: string; to?: string; view?: string; scheduled?: string }
}) {
  const ctx = await getAuthContext()
  const canCreate = hasMinimumRole(ctx?.activeTenantRole, 'operator')
  const isAdmin = hasMinimumRole(ctx?.activeTenantRole, 'admin')
  const view: BoardView = searchParams.view === 'list' ? 'list' : 'kanban'
  const hasExplicitDateRange = Boolean(searchParams.from || searchParams.to)
  const dateRange = resolveBoardDateRange({ from: searchParams.from, to: searchParams.to })

  const [ticketsRes, assigneesRes] = await Promise.all([
    listBoardTickets({
      updatedFrom: dateRange.from,
      updatedTo: dateRange.to,
      involvedAgentId: agentId,
    }),
    canCreate ? listBoardAssignees() : Promise.resolve(null),
  ])
  const tickets = ticketsRes.success ? ticketsRes.data.tickets : []
  const ticketsHasMore = ticketsRes.success ? ticketsRes.data.hasMore : false
  const assigneeOptions =
    assigneesRes && assigneesRes.success ? assigneesRes.data : undefined
  const loadError = !ticketsRes.success ? ticketsRes.error : null

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-ink-soft">
          Csak azok a feladatok, amelyeket ez a munkatárs létrehozott vagy végrehajtott.
        </p>
        <Suspense fallback={<div className="h-9 w-40 animate-pulse rounded-full bg-line/40" />}>
          <BoardViewSwitcher currentView={view} />
        </Suspense>
      </div>

      {loadError && (
        <p className="mb-4 rounded-xl border border-coral/30 bg-coral/10 px-4 py-3 text-sm text-coral">
          Nem sikerült betölteni a feladatokat: {loadError}
        </p>
      )}

      {ticketsHasMore && (
        <p className="mb-4 rounded-xl border border-honey/40 bg-honey/10 px-4 py-3 text-sm text-ink-soft">
          <span className="font-semibold text-honey">Nem fér ki minden:</span> a tábla a
          kiválasztott időszakban módosult feladatoknak csak az első oldalát mutatja. Szűkítsd a
          dátumtartományt, hogy biztosan mindent láss.
        </p>
      )}

      <KanbanBoard
        tickets={tickets}
        agents={[]}
        canCreate={canCreate}
        assigneeOptions={assigneeOptions}
        recentProcesses={[]}
        updatedFrom={dateRange.from}
        updatedTo={dateRange.to}
        dateRangeIsDefault={!hasExplicitDateRange}
        view={view}
        isAdmin={isAdmin}
        currentUserId={ctx?.user.id}
        initialScheduledFilter={searchParams.scheduled === '1'}
        initialAgentId={agentId}
        hideAssigneeFilter
      />
    </div>
  )
}
