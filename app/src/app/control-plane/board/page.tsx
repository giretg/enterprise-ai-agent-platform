import { listAgents, listBoardTickets } from '@/app/actions/platform'
import { KanbanBoard } from '@/components/tickets/kanban-board'

export default async function BoardPage() {
  const [ticketsRes, agentsRes] = await Promise.all([listBoardTickets(), listAgents()])
  const tickets = ticketsRes.success ? ticketsRes.data : []
  const agents = agentsRes.success ? agentsRes.data : []
  const loadError = !ticketsRes.success ? ticketsRes.error : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold">Kanban Board</h1>
        <p className="mt-1 text-ink-soft">
          Húzd a kártyát oszlopok között — a szerver validálja az átmenetet
        </p>
      </div>

      {loadError && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          Nem sikerült betölteni a ticketeket: {loadError}
        </p>
      )}

      <KanbanBoard tickets={tickets} agents={agents} />
    </div>
  )
}
