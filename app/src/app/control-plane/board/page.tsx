import { Suspense } from 'react'
import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { listAgents, listBoardAssignees, listBoardTickets } from '@/app/actions/platform'
import { listProcesses } from '@/app/actions/process'
import { KanbanBoard } from '@/components/tickets/kanban-board'
import { BoardViewSwitcher, type BoardView } from '@/components/tickets/board-view-switcher'
import { resolveBoardDateRange } from '@/lib/board-date-range'

const RECENT_PROCESS_LIMIT = 20

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; view?: string; scheduled?: string }>
}) {
  const ctx = await getAuthContext()
  const canCreate = hasMinimumRole(ctx?.activeTenantRole, 'operator')
  const isAdmin = hasMinimumRole(ctx?.activeTenantRole, 'admin')
  const query = await searchParams
  const view: BoardView = query.view === 'list' ? 'list' : 'kanban'
  const hasExplicitDateRange = Boolean(query.from || query.to)
  const dateRange = resolveBoardDateRange({ from: query.from, to: query.to })

  const [ticketsRes, agentsRes, assigneesRes, processesRes] = await Promise.all([
    listBoardTickets({ updatedFrom: dateRange.from, updatedTo: dateRange.to }),
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="font-display text-3xl font-semibold">Feladat-tábla</h1>
          <p className="mt-1.5 text-ink-soft">
            Minden feladat egy oszlopban áll aszerint, hogy hol tart: mire vár, ki dolgozik rajta, és
            mi az, amihez rád van szükség.
            {view === 'list'
              ? ' A listanézetben állapotonként, táblázatosan látod őket — indítás, leállítás és törlés egy helyen.'
              : null}
          </p>
        </div>
        <Suspense fallback={<div className="h-9 w-40 animate-pulse rounded-full bg-line/40" />}>
          <BoardViewSwitcher currentView={view} />
        </Suspense>
      </div>

      {loadError && (
        <p className="rounded-xl border border-coral/30 bg-coral/10 px-4 py-3 text-sm text-coral">
          Nem sikerült betölteni a feladatokat: {loadError}
        </p>
      )}

      {ticketsHasMore && (
        <p className="rounded-xl border border-honey/40 bg-honey/10 px-4 py-3 text-sm text-ink-soft">
          <span className="font-semibold text-honey">Nem fér ki minden:</span> a tábla a kiválasztott
          időszakban módosult feladatoknak csak az első oldalát mutatja. Szűkítsd a dátumtartományt,
          hogy biztosan mindent láss.
        </p>
      )}

      <KanbanBoard
        tickets={tickets}
        agents={agents}
        canCreate={canCreate}
        assigneeOptions={assigneeOptions}
        recentProcesses={recentProcesses}
        updatedFrom={dateRange.from}
        updatedTo={dateRange.to}
        dateRangeIsDefault={!hasExplicitDateRange}
        view={view}
        isAdmin={isAdmin}
        currentUserId={ctx?.user.id}
        initialScheduledFilter={query.scheduled === '1'}
      />
    </div>
  )
}
