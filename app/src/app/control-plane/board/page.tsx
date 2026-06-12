import { listTickets } from '@/app/actions/platform'
import { KanbanBoard } from '@/components/tickets/kanban-board'

export default async function BoardPage() {
  const res = await listTickets()
  const tickets = res.success ? res.data : []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold">Kanban Board</h1>
        <p className="mt-1 text-ink-soft">
          Húzd a kártyát oszlopok között — a szerver validálja az átmenetet
        </p>
      </div>

      <KanbanBoard tickets={tickets} />
    </div>
  )
}
