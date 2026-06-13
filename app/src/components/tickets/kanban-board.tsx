'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type { Ticket } from '@prisma/client'
import { transitionTicket } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { TICKET_STATE_LABELS } from '@/lib/ticket-labels'

const COLUMNS = [
  { key: 'backlog', label: TICKET_STATE_LABELS.backlog, accent: 'border-ink-faint/30' },
  { key: 'in_review', label: TICKET_STATE_LABELS.in_review, accent: 'border-honey/40' },
  { key: 'awaiting_human', label: TICKET_STATE_LABELS.awaiting_human, accent: 'border-coral/40' },
  { key: 'approved', label: TICKET_STATE_LABELS.approved, accent: 'border-sage/40' },
  { key: 'in_progress', label: TICKET_STATE_LABELS.in_progress, accent: 'border-sky/40' },
  { key: 'done', label: TICKET_STATE_LABELS.done, accent: 'border-sage/60' },
  { key: 'rejected', label: TICKET_STATE_LABELS.rejected, accent: 'border-coral/60' },
] as const

type ColumnKey = (typeof COLUMNS)[number]['key']

export function KanbanBoard({ tickets }: { tickets: Ticket[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<ColumnKey | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const handleDrop = (ticketId: string, toState: ColumnKey) => {
    const ticket = tickets.find((t) => t.id === ticketId)
    if (!ticket || ticket.state === toState) return

    startTransition(async () => {
      const res = await transitionTicket({ id: ticketId, toState })
      if (res.success) {
        setMessage(null)
        router.refresh()
      } else {
        setMessage(res.error ?? 'Átmenet elutasítva')
      }
    })
  }

  return (
    <div className="space-y-4">
      {message && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          {message}
        </p>
      )}

      <div className={`flex gap-4 overflow-x-auto pb-4 ${pending ? 'opacity-70' : ''}`}>
        {COLUMNS.map((col) => {
          const colTickets = tickets.filter((t) => t.state === col.key)
          const isTarget = dropTarget === col.key

          return (
            <div
              key={col.key}
              className={`min-w-[240px] flex-shrink-0 rounded-xl border-t-2 ${col.accent} pt-3 transition-colors ${
                isTarget ? 'bg-coral/5 ring-1 ring-coral/30' : ''
              }`}
              onDragOver={(e) => {
                e.preventDefault()
                setDropTarget(col.key)
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => {
                e.preventDefault()
                setDropTarget(null)
                const ticketId = e.dataTransfer.getData('text/ticket-id')
                if (ticketId) handleDrop(ticketId, col.key)
              }}
            >
              <div className="mb-3 flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold text-ink-soft">{col.label}</h2>
                <Badge>{colTickets.length}</Badge>
              </div>
              <div className="space-y-3 px-1">
                {colTickets.map((ticket) => (
                  <div
                    key={ticket.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/ticket-id', ticket.id)
                      setDraggingId(ticket.id)
                    }}
                    onDragEnd={() => setDraggingId(null)}
                    className={`cursor-grab active:cursor-grabbing ${
                      draggingId === ticket.id ? 'opacity-40' : ''
                    }`}
                  >
                    <Link href={`/control-plane/tickets/${ticket.id}`} draggable={false}>
                      <Card className="!p-4 transition hover:border-coral/40">
                        <p className="text-sm font-medium">{ticket.title}</p>
                        <p className="mt-1 text-xs text-ink-faint">{ticket.type}</p>
                      </Card>
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
