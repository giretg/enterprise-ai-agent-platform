import { Link } from 'react-router-dom'
import { Badge } from '../../shared/components/Badge'
import { useDemo } from '../../shared/context/DemoContext'
import { TICKET_COLUMNS } from '../../shared/types'
import { DemoGuide } from '../ControlPlaneLayout'

export function BoardPage() {
  const { tickets } = useDemo()

  return (
    <div>
      <DemoGuide />
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-50">Kanban Board</h1>
        <p className="mt-1 text-sm text-slate-400">
          Minden munka — ember és agent — ticketként, állapotgépen
        </p>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-4">
        {TICKET_COLUMNS.map((col) => {
          const colTickets = tickets.filter((t) => t.status === col.key)
          return (
            <div
              key={col.key}
              className="min-w-[220px] flex-1 rounded-lg border border-slate-700/60 bg-slate-900/40"
            >
              <div className="flex items-center justify-between border-b border-slate-700/60 px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {col.label}
                </span>
                <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-500">
                  {colTickets.length}
                </span>
              </div>
              <div className="space-y-2 p-2">
                {colTickets.map((ticket) => (
                  <Link
                    key={ticket.id}
                    to={`/control-plane/tickets/${ticket.id}`}
                    className="block rounded-md border border-slate-700/50 bg-slate-800/60 p-3 text-left transition-colors hover:border-slate-500 hover:bg-slate-800"
                  >
                    <div className="mb-2 flex flex-wrap gap-1">
                      <Badge variant="mono">{ticket.id}</Badge>
                      {ticket.type === 'training' && (
                        <Badge variant="purple">tanítás</Badge>
                      )}
                      {ticket.proposal && (
                        <Badge variant="warning">human-in-the-loop</Badge>
                      )}
                    </div>
                    <p className="text-sm font-medium text-slate-200">
                      {ticket.title}
                    </p>
                    <p className="mt-2 text-xs text-slate-500">
                      {ticket.assigneeType === 'agent' ? '🤖' : '👤'}{' '}
                      {ticket.assignee}
                    </p>
                  </Link>
                ))}
                {colTickets.length === 0 && (
                  <p className="py-4 text-center text-xs text-slate-600">
                    üres
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
