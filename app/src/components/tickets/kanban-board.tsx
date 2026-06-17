'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition, type DragEvent } from 'react'
import type { Agent } from '@prisma/client'
import { transitionTicket } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { personaFor } from '@/lib/agent-persona'
import { TICKET_STATE_LABELS } from '@/lib/ticket-labels'
import {
  getAssigneeFilterKey,
  matchesAssigneeFilter,
  type EnrichedBoardTicket,
} from '@/lib/ticket-display'

const COLUMN_VISIBLE_LIMIT = 10
const COLUMN_WIDTH_CLASS = 'w-[280px] max-w-[280px]'

const COLUMNS = [
  { key: 'backlog', label: TICKET_STATE_LABELS.backlog, accent: 'border-ink-faint/30' },
  { key: 'ready', label: TICKET_STATE_LABELS.ready, accent: 'border-honey/40' },
  { key: 'in_progress', label: TICKET_STATE_LABELS.in_progress, accent: 'border-sky/40' },
  { key: 'awaiting_human', label: TICKET_STATE_LABELS.awaiting_human, accent: 'border-coral/40' },
  { key: 'approved', label: TICKET_STATE_LABELS.approved, accent: 'border-sage/40' },
  { key: 'done', label: TICKET_STATE_LABELS.done, accent: 'border-sage/60' },
  { key: 'rejected', label: TICKET_STATE_LABELS.rejected, accent: 'border-coral/60' },
] as const

type ColumnKey = (typeof COLUMNS)[number]['key']

type AssigneeFilterOption = {
  key: string
  label: string
}

function buildAssigneeFilterOptions(
  tickets: EnrichedBoardTicket[],
  agents: Agent[],
): AssigneeFilterOption[] {
  const options: AssigneeFilterOption[] = [
    { key: 'all', label: 'Mind' },
    { key: 'unassigned', label: 'Nincs hozzárendelve' },
  ]
  const seen = new Set<string>()

  for (const agent of agents.filter((a) => a.status === 'active')) {
    const key = `agent:${agent.id}`
    if (seen.has(key)) continue
    seen.add(key)
    options.push({ key, label: personaFor(agent.name).nickname })
  }

  for (const ticket of tickets) {
    const key = getAssigneeFilterKey(ticket)
    if (key === 'unassigned' || seen.has(key)) continue
    seen.add(key)

    if (key.startsWith('human:')) {
      options.push({ key, label: ticket.assignee.label })
    } else if (key.startsWith('agent:') && !options.some((o) => o.key === key)) {
      options.push({ key, label: ticket.assignee.label })
    }
  }

  return options
}

type KanbanColumnProps = {
  col: (typeof COLUMNS)[number]
  tickets: EnrichedBoardTicket[]
  isTarget: boolean
  isExpanded: boolean
  draggingId: string | null
  onToggleExpand: () => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent) => void
  onDragStart: (ticketId: string) => void
  onDragEnd: () => void
}

function KanbanColumn({
  col,
  tickets,
  isTarget,
  isExpanded,
  draggingId,
  onToggleExpand,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragStart,
  onDragEnd,
}: KanbanColumnProps) {
  const hasOverflow = tickets.length > COLUMN_VISIBLE_LIMIT
  const visibleTickets = isExpanded ? tickets : tickets.slice(0, COLUMN_VISIBLE_LIMIT)
  const hiddenCount = tickets.length - COLUMN_VISIBLE_LIMIT

  return (
    <div
      className={`${COLUMN_WIDTH_CLASS} shrink-0 rounded-xl border-t-2 ${col.accent} pt-3 transition-colors ${
        isTarget ? 'bg-coral/5 ring-1 ring-coral/30' : ''
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-ink-soft">{col.label}</h2>
        <Badge>{tickets.length}</Badge>
      </div>

      <div
        className={`space-y-3 px-1 ${
          isExpanded && hasOverflow
            ? 'max-h-[min(70vh,640px)] overflow-y-auto overscroll-y-contain pr-1'
            : ''
        }`}
      >
        {visibleTickets.map((ticket) => (
          <div
            key={ticket.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/ticket-id', ticket.id)
              onDragStart(ticket.id)
            }}
            onDragEnd={onDragEnd}
            className={`cursor-grab active:cursor-grabbing ${
              draggingId === ticket.id ? 'opacity-40' : ''
            }`}
          >
            <Link href={`/control-plane/tickets/${ticket.id}`} draggable={false} className="block min-w-0">
              <Card className="!p-4 transition hover:border-coral/40">
                <p className="break-words text-sm font-medium">{ticket.title}</p>
                <p className="mt-1 text-xs text-ink-faint">
                  {ticket.type === 'training' ? 'Tanítás' : 'Interakció'}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="break-words text-xs text-ink-soft">{ticket.assignee.label}</span>
                  {ticket.assignee.type === 'agent' && <Badge tone="neutral">AI</Badge>}
                  {ticket.assignee.type === 'human' && <Badge tone="warning">Ember</Badge>}
                </div>
                <p className="mt-1.5 break-words text-xs text-ink-faint">
                  Létrehozta: {ticket.creator.label}
                </p>
              </Card>
            </Link>
          </div>
        ))}
      </div>

      {hasOverflow && (
        <button
          type="button"
          onClick={onToggleExpand}
          className="mt-3 w-full rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink-soft transition hover:border-coral/30 hover:bg-coral/5 hover:text-ink"
        >
          {isExpanded ? 'Kevesebb mutatása' : `${hiddenCount} további feladat`}
        </button>
      )}
    </div>
  )
}

export function KanbanBoard({
  tickets,
  agents,
}: {
  tickets: EnrichedBoardTicket[]
  agents: Agent[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<ColumnKey | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [expandedColumns, setExpandedColumns] = useState<Set<ColumnKey>>(new Set())
  const [assigneeFilter, setAssigneeFilter] = useState('all')

  const filterOptions = useMemo(
    () => buildAssigneeFilterOptions(tickets, agents),
    [tickets, agents],
  )

  const filteredTickets = useMemo(
    () => tickets.filter((ticket) => matchesAssigneeFilter(ticket, assigneeFilter)),
    [tickets, assigneeFilter],
  )

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
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="assignee-filter" className="text-sm font-medium text-ink-soft">
          Hozzárendelve
        </label>
        <select
          id="assignee-filter"
          value={assigneeFilter}
          onChange={(e) => setAssigneeFilter(e.target.value)}
          className="rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
        >
          {filterOptions.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
        {assigneeFilter !== 'all' && (
          <span className="text-xs text-ink-faint">{filteredTickets.length} feladat</span>
        )}
      </div>

      {message && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          {message}
        </p>
      )}

      <div className={`flex gap-4 overflow-x-auto pb-4 ${pending ? 'opacity-70' : ''}`}>
        {COLUMNS.map((col) => {
          const colTickets = filteredTickets.filter((t) => t.state === col.key)
          const isTarget = dropTarget === col.key

          return (
            <KanbanColumn
              key={col.key}
              col={col}
              tickets={colTickets}
              isTarget={isTarget}
              isExpanded={expandedColumns.has(col.key)}
              draggingId={draggingId}
              onToggleExpand={() => {
                setExpandedColumns((prev) => {
                  const next = new Set(prev)
                  if (next.has(col.key)) next.delete(col.key)
                  else next.add(col.key)
                  return next
                })
              }}
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
              onDragStart={setDraggingId}
              onDragEnd={() => setDraggingId(null)}
            />
          )
        })}
      </div>
    </div>
  )
}
