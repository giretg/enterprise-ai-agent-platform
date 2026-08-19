'use client'

import { CreateBoardTicketForm } from '@/components/tickets/create-board-ticket-form'
import { BoardListView } from '@/components/tickets/board-list-view'
import type { BoardView } from '@/components/tickets/board-view-switcher'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type ReactNode,
} from 'react'
import type { Agent } from '@prisma/client'
import { transitionTicket } from '@/app/actions/platform'
import { Badge } from '@/components/ui/shell'
import { ProcessBadge } from '@/components/processes/process-badge'
import { personaFor } from '@/lib/agent-persona'
import { useTicketDispatch } from '@/components/tickets/ticket-dispatch-client'
import { formatDateInput, resolveBoardDateRange } from '@/lib/board-date-range'
import {
  TICKET_STATE_HINTS,
  TICKET_STATE_LABELS,
  ticketStateAccent,
} from '@/lib/ticket-labels'
import {
  canStartTicketDispatch,
  formatRelativeTicketTime,
  formatTicketDateTime,
  getAssigneeFilterKey,
  initialsFor,
  matchesAssigneeFilter,
  type EnrichedBoardTicket,
} from '@/lib/ticket-display'

export type RecentBoardProcess = {
  id: string
  processType: string
  startedAt: string
}

const COLUMN_VISIBLE_LIMIT = 10
const COLUMN_WIDTH_CLASS = 'w-[304px] max-w-[304px]'

const COLUMN_KEYS = [
  'backlog',
  'ready',
  'in_progress',
  'awaiting_human',
  'needs_info',
  'approved',
  'done',
  'rejected',
] as const

type ColumnKey = (typeof COLUMN_KEYS)[number]

const COLUMNS = COLUMN_KEYS.map((key) => ({
  key,
  label: TICKET_STATE_LABELS[key] ?? key,
  hint: TICKET_STATE_HINTS[key] ?? '',
  accent: ticketStateAccent(key),
}))

/**
 * Összesítő csempék: a tábla „mit kell most csinálnom” kérdésre válaszol,
 * mielőtt bárki végigolvasná a nyolc oszlopot. Kattintásra állapotra szűr.
 */
const SUMMARY_TILES: {
  key: string
  label: string
  hint: string
  states: ColumnKey[] | null
  dot: string
  activeClass: string
  urgent?: boolean
}[] = [
  {
    key: 'all',
    label: 'Összes feladat',
    hint: 'A szűrésnek megfelelő összes feladat a kiválasztott időszakban.',
    states: null,
    dot: 'bg-ink-faint',
    activeClass: 'border-ink/25 bg-ink/[0.04]',
  },
  {
    key: 'attention',
    label: 'Rajtad a sor',
    hint: 'Emberi jóváhagyásra vagy pontosításra váró feladatok — ezek nélküled nem haladnak.',
    states: ['awaiting_human', 'needs_info'],
    dot: 'bg-coral',
    activeClass: 'border-coral/45 bg-coral/10',
    urgent: true,
  },
  {
    key: 'running',
    label: 'Éppen fut',
    hint: 'Az AI munkatárs most dolgozik ezeken.',
    states: ['in_progress'],
    dot: 'bg-sky',
    activeClass: 'border-sky/45 bg-sky/10',
  },
  {
    key: 'ready',
    label: 'Indításra kész',
    hint: 'Hozzárendelve, de még nem indult el — a kártya play gombjával indíthatod.',
    states: ['ready'],
    dot: 'bg-honey',
    activeClass: 'border-honey/45 bg-honey/10',
  },
  {
    key: 'closed',
    label: 'Lezárva',
    hint: 'Jóváhagyott, elkészült és visszadobott feladatok.',
    states: ['approved', 'done', 'rejected'],
    dot: 'bg-sage',
    activeClass: 'border-sage/45 bg-sage/10',
  },
]

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  )
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" strokeLinecap="round" />
    </svg>
  )
}

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
    options.push({ key, label: personaFor(agent.name, agent).nickname })
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

function matchesQuery(ticket: EnrichedBoardTicket, query: string): boolean {
  if (!query) return true
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [ticket.title, ticket.taskDescription, ticket.assignee.label, ticket.creator.label]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(needle))
}

/** Egységes űrlapmező-keret a szűrősávban: felirat fölötte, vezérlő alatta. */
function Field({
  label,
  htmlFor,
  children,
  className = '',
}: {
  label: string
  htmlFor?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint"
      >
        {label}
      </label>
      {children}
    </div>
  )
}

const CONTROL_CLASS =
  'h-9 w-full rounded-lg border border-line bg-paper px-3 text-sm text-ink transition focus:border-coral/50 focus:outline-none focus:ring-2 focus:ring-coral/15'

type TicketCardProps = {
  ticket: EnrichedBoardTicket
  canDispatch: boolean
  isBusy: boolean
  isDragging: boolean
  onDragStart: (ticketId: string) => void
  onDragEnd: () => void
  onStartDispatch: (ticketId: string) => void
  onStopDispatch: (ticketId: string) => void
}

function TicketCard({
  ticket,
  canDispatch,
  isBusy,
  isDragging,
  onDragStart,
  onDragEnd,
  onStartDispatch,
  onStopDispatch,
}: TicketCardProps) {
  const canStart = canDispatch && canStartTicketDispatch(ticket)
  const canStop = canDispatch && ticket.state === 'in_progress'
  const accent = ticketStateAccent(ticket.state)
  const needsHuman = ticket.state === 'awaiting_human' || ticket.state === 'needs_info'
  const updatedTitle = `Módosítva: ${formatTicketDateTime(ticket.updatedAt)}\nLétrehozva: ${formatTicketDateTime(
    ticket.createdAt,
  )}`

  return (
    <article
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/ticket-id', ticket.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart(ticket.id)
      }}
      onDragEnd={onDragEnd}
      className={`group relative cursor-grab overflow-hidden rounded-xl border bg-card pl-4 pr-3 py-3 shadow-[0_1px_2px_-1px_rgba(70,45,30,0.12)] transition active:cursor-grabbing hover:-translate-y-px hover:shadow-[0_12px_26px_-18px_rgba(90,55,35,0.6)] ${
        needsHuman ? 'border-coral/30' : 'border-line'
      } hover:border-coral/45 ${isDragging ? 'opacity-40' : ''} ${isBusy ? 'animate-pulse' : ''}`}
    >
      <span className={`absolute inset-y-0 left-0 w-[3px] ${accent.bar}`} aria-hidden />

      <div className="flex items-start gap-2">
        <Link
          href={`/control-plane/tickets/${ticket.id}`}
          draggable={false}
          title={ticket.title}
          className="min-w-0 flex-1"
        >
          <h3 className="line-clamp-2 break-words text-[13px] font-semibold leading-snug text-ink transition group-hover:text-coral-deep">
            {ticket.title}
          </h3>
        </Link>

        {(canStart || canStop) && (
          <button
            type="button"
            draggable={false}
            disabled={isBusy}
            title={canStart ? 'Feldolgozás indítása' : 'Feldolgozás leállítása'}
            aria-label={canStart ? 'Feldolgozás indítása' : 'Feldolgozás leállítása'}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (canStart) onStartDispatch(ticket.id)
              else onStopDispatch(ticket.id)
            }}
            className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition disabled:opacity-40 ${
              canStart
                ? 'border-honey/40 bg-honey/10 text-honey hover:border-honey/60 hover:bg-honey/20'
                : 'border-coral/35 bg-coral/10 text-coral hover:border-coral/55 hover:bg-coral/20'
            }`}
          >
            {canStart ? <PlayIcon className="h-3.5 w-3.5" /> : <StopIcon className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {ticket.taskDescription && (
        <p className="mt-1.5 line-clamp-2 break-words text-xs leading-relaxed text-ink-soft">
          {ticket.taskDescription}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-ink/[0.05] px-2 py-0.5 text-[11px] font-medium text-ink-soft">
          {ticket.type === 'training' ? 'Tanítás' : 'Interakció'}
        </span>
        {ticket.state === 'in_progress' && (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold text-sky animate-activity-run-row">
            <span className="relative flex h-1.5 w-1.5" aria-hidden>
              <span className="absolute inline-flex h-full w-full rounded-full bg-sky opacity-60 animate-activity-run-dot" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky" />
            </span>
            Fut
          </span>
        )}
        {ticket.process && (
          <ProcessBadge
            processInstanceId={ticket.process.id}
            processType={ticket.process.processType}
            status={ticket.process.status}
          />
        )}
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <span
          className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
            ticket.assignee.type === 'agent'
              ? 'bg-sky/15 text-sky'
              : ticket.assignee.type === 'human'
                ? 'bg-honey/15 text-honey'
                : 'bg-ink/[0.06] text-ink-faint'
          }`}
          aria-hidden
        >
          {ticket.assignee.type ? initialsFor(ticket.assignee.label) : '–'}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-soft" title={ticket.assignee.label}>
          {ticket.assignee.label}
        </span>
        {ticket.assignee.type === 'agent' && <Badge tone="neutral">AI</Badge>}
        {ticket.assignee.type === 'human' && <Badge tone="warning">Ember</Badge>}
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line/60 pt-2 text-[11px] text-ink-faint">
        <span className="truncate" title={`Létrehozta: ${ticket.creator.label}`}>
          {ticket.creator.label}
        </span>
        <time
          dateTime={new Date(ticket.updatedAt).toISOString()}
          title={updatedTitle}
          suppressHydrationWarning
          className="shrink-0 whitespace-nowrap"
        >
          {formatRelativeTicketTime(ticket.updatedAt)}
        </time>
      </div>
    </article>
  )
}

type KanbanColumnProps = {
  col: (typeof COLUMNS)[number]
  tickets: EnrichedBoardTicket[]
  isTarget: boolean
  isExpanded: boolean
  draggingId: string | null
  busyTicketId: string | null
  canDispatch: boolean
  onToggleExpand: () => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent) => void
  onDragStart: (ticketId: string) => void
  onDragEnd: () => void
  onStartDispatch: (ticketId: string) => void
  onStopDispatch: (ticketId: string) => void
}

function KanbanColumn({
  col,
  tickets,
  isTarget,
  isExpanded,
  draggingId,
  busyTicketId,
  canDispatch,
  onToggleExpand,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragStart,
  onDragEnd,
  onStartDispatch,
  onStopDispatch,
}: KanbanColumnProps) {
  const hasOverflow = tickets.length > COLUMN_VISIBLE_LIMIT
  const visibleTickets = isExpanded ? tickets : tickets.slice(0, COLUMN_VISIBLE_LIMIT)
  const hiddenCount = tickets.length - COLUMN_VISIBLE_LIMIT

  return (
    <section
      id={`board-column-${col.key}`}
      aria-label={`${col.label} — ${tickets.length} feladat`}
      className={`${COLUMN_WIDTH_CLASS} flex shrink-0 flex-col overflow-hidden rounded-2xl border transition ${
        isTarget
          ? 'border-coral/50 ring-2 ring-coral/25'
          : 'border-line'
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className={`${col.accent.bar} h-1`} aria-hidden />

      <header className="border-b border-line/70 bg-card/70 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${col.accent.dot}`} aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" title={col.label}>
            {col.label}
          </h2>
          <span
            className={`inline-flex min-w-6 justify-center rounded-full px-2 py-0.5 text-xs font-bold ${col.accent.count}`}
          >
            {tickets.length}
          </span>
        </div>
        {col.hint && (
          <p className="mt-1 text-[11px] leading-snug text-ink-faint">{col.hint}</p>
        )}
      </header>

      <div
        className={`flex-1 space-y-2.5 p-2.5 ${col.accent.wash} ${
          isTarget ? 'bg-coral/[0.06]' : ''
        } ${
          isExpanded && hasOverflow
            ? 'max-h-[min(70vh,640px)] overflow-y-auto overscroll-y-contain'
            : ''
        }`}
      >
        {visibleTickets.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-3 py-6 text-center">
            <p className="text-xs text-ink-faint">
              {draggingId ? 'Húzd ide a kártyát' : 'Nincs itt feladat'}
            </p>
          </div>
        ) : (
          visibleTickets.map((ticket) => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              canDispatch={canDispatch}
              isBusy={busyTicketId === ticket.id}
              isDragging={draggingId === ticket.id}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onStartDispatch={onStartDispatch}
              onStopDispatch={onStopDispatch}
            />
          ))
        )}

        {hasOverflow && (
          <button
            type="button"
            onClick={onToggleExpand}
            className="w-full rounded-lg border border-line bg-card/80 px-3 py-2 text-xs font-semibold text-ink-soft transition hover:border-coral/35 hover:bg-coral/5 hover:text-coral-deep"
          >
            {isExpanded ? 'Kevesebb mutatása' : `+${hiddenCount} további feladat`}
          </button>
        )}
      </div>
    </section>
  )
}

function SyncedHorizontalScroll({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const mainRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const spacerRef = useRef<HTMLDivElement>(null)
  const [hasOverflow, setHasOverflow] = useState(false)

  useEffect(() => {
    const main = mainRef.current
    const top = topRef.current
    const spacer = spacerRef.current
    if (!main || !top || !spacer) return

    let syncing = false

    const updateSpacer = () => {
      spacer.style.width = `${main.scrollWidth}px`
      setHasOverflow(main.scrollWidth > main.clientWidth + 1)
    }

    const syncScroll = (source: HTMLDivElement, target: HTMLDivElement) => {
      if (syncing || source.scrollLeft === target.scrollLeft) return
      syncing = true
      target.scrollLeft = source.scrollLeft
      syncing = false
    }

    const onMainScroll = () => syncScroll(main, top)
    const onTopScroll = () => syncScroll(top, main)

    updateSpacer()
    main.addEventListener('scroll', onMainScroll, { passive: true })
    top.addEventListener('scroll', onTopScroll, { passive: true })

    const observer = new ResizeObserver(updateSpacer)
    observer.observe(main)

    return () => {
      main.removeEventListener('scroll', onMainScroll)
      top.removeEventListener('scroll', onTopScroll)
      observer.disconnect()
    }
  }, [children])

  return (
    <div>
      <div
        ref={topRef}
        className={`overflow-x-auto overflow-y-hidden ${hasOverflow ? 'mb-1' : 'h-0 overflow-hidden'}`}
        aria-hidden
      >
        <div ref={spacerRef} className="h-px" />
      </div>
      <div ref={mainRef} className={className}>
        {children}
      </div>
    </div>
  )
}

export function KanbanBoard({
  tickets,
  agents,
  canCreate = false,
  assigneeOptions,
  recentProcesses = [],
  updatedFrom,
  updatedTo,
  dateRangeIsDefault = true,
  view = 'kanban',
  isAdmin = false,
  currentUserId,
}: {
  tickets: EnrichedBoardTicket[]
  agents: Agent[]
  canCreate?: boolean
  assigneeOptions?: { agents: { id: string; name: string }[]; users: { id: string; name: string; role: string }[] }
  recentProcesses?: RecentBoardProcess[]
  updatedFrom: string
  updatedTo: string
  dateRangeIsDefault?: boolean
  view?: BoardView
  isAdmin?: boolean
  currentUserId?: string | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const dispatchTicket = useTicketDispatch()
  const [pending, startTransition] = useTransition()
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<ColumnKey | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busyTicketId, setBusyTicketId] = useState<string | null>(null)
  const [expandedColumns, setExpandedColumns] = useState<Set<ColumnKey>>(new Set())
  const [assigneeFilter, setAssigneeFilter] = useState('all')
  const [processFilter, setProcessFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [stateFocus, setStateFocus] = useState<string | null>(null)
  const [hideEmptyColumns, setHideEmptyColumns] = useState(true)
  /**
   * A dátum-inputok azonnal követik a kattintást (a navigáció csak utána fut le),
   * de ha az URL-ből új tartomány érkezik, az felülírja a helyi értéket. A
   * szinkront renderelés közben végezzük — effectben setState kaszkád-rendert okozna.
   */
  const [dateRange, setDateRange] = useState({
    from: updatedFrom,
    to: updatedTo,
    propsFrom: updatedFrom,
    propsTo: updatedTo,
  })
  if (dateRange.propsFrom !== updatedFrom || dateRange.propsTo !== updatedTo) {
    setDateRange({
      from: updatedFrom,
      to: updatedTo,
      propsFrom: updatedFrom,
      propsTo: updatedTo,
    })
  }
  const fromDate = dateRange.from
  const toDate = dateRange.to

  const filterOptions = useMemo(
    () => buildAssigneeFilterOptions(tickets, agents),
    [tickets, agents],
  )

  const filteredTickets = useMemo(
    () =>
      tickets
        .filter((ticket) => matchesAssigneeFilter(ticket, assigneeFilter))
        .filter((ticket) => processFilter === 'all' || ticket.process?.id === processFilter)
        .filter((ticket) => matchesQuery(ticket, query)),
    [tickets, assigneeFilter, processFilter, query],
  )

  const focusedStates = useMemo(
    () => SUMMARY_TILES.find((tile) => tile.key === stateFocus)?.states ?? null,
    [stateFocus],
  )

  const countsByState = useMemo(() => {
    const counts = new Map<string, number>()
    for (const ticket of filteredTickets) {
      counts.set(ticket.state, (counts.get(ticket.state) ?? 0) + 1)
    }
    return counts
  }, [filteredTickets])

  const visibleColumns = useMemo(
    () =>
      COLUMNS.filter((col) => {
        // Húzás közben minden oszlop látszik, különben eltűnnének a célpontok.
        if (draggingId) return true
        if (focusedStates && !focusedStates.includes(col.key)) return false
        if (hideEmptyColumns && (countsByState.get(col.key) ?? 0) === 0) return false
        return true
      }),
    [countsByState, draggingId, focusedStates, hideEmptyColumns],
  )

  const hiddenColumnCount = COLUMNS.length - visibleColumns.length
  const filtersActive =
    assigneeFilter !== 'all' ||
    processFilter !== 'all' ||
    query.trim() !== '' ||
    stateFocus !== null ||
    !dateRangeIsDefault

  const listTickets = useMemo(
    () =>
      focusedStates
        ? filteredTickets.filter((ticket) => focusedStates.includes(ticket.state as ColumnKey))
        : filteredTickets,
    [filteredTickets, focusedStates],
  )

  const applyDateRange = (nextFrom: string, nextTo: string) => {
    const range = resolveBoardDateRange({ from: nextFrom, to: nextTo })
    setDateRange((prev) => ({ ...prev, from: range.from, to: range.to }))
    const params = new URLSearchParams()
    params.set('from', range.from)
    params.set('to', range.to)
    if (view === 'list') params.set('view', 'list')
    router.replace(`${pathname}?${params.toString()}`)
  }

  const applyDayPreset = (days: number) => {
    const now = new Date()
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1)
    applyDateRange(formatDateInput(from), formatDateInput(now))
  }

  const resetFilters = () => {
    setAssigneeFilter('all')
    setProcessFilter('all')
    setQuery('')
    setStateFocus(null)
    if (!dateRangeIsDefault) router.replace(view === 'list' ? `${pathname}?view=list` : pathname)
  }

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

  const handleStartDispatch = (ticketId: string) => {
    if (busyTicketId) return
    setBusyTicketId(ticketId)
    setMessage(null)
    void (async () => {
      try {
        const res = await dispatchTicket(ticketId)
        if (!res.success) {
          setMessage(res.error)
        } else {
          if (res.warning) setMessage(res.warning)
        }
      } finally {
        setBusyTicketId(null)
      }
    })()
  }

  const handleStopDispatch = (ticketId: string) => {
    if (busyTicketId) return
    setBusyTicketId(ticketId)
    setMessage(null)
    void (async () => {
      try {
        const res = await fetch(`/api/v1/tickets/${ticketId}/cancel`, { method: 'POST' })
        if (!res.ok) {
          setMessage(
            res.status === 404
              ? 'A feladat már nem fut — lehet, hogy befejeződött.'
              : 'Leállítás sikertelen.',
          )
        }
        router.refresh()
      } catch {
        setMessage('Leállítás sikertelen.')
      } finally {
        setBusyTicketId(null)
      }
    })()
  }

  return (
    <div className="space-y-4">
      {canCreate && assigneeOptions && <CreateBoardTicketForm assigneeOptions={assigneeOptions} />}

      {/* Áttekintő csempék — kattintásra a kapcsolódó állapotokra szűkít. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {SUMMARY_TILES.map((tile) => {
          const count = tile.states
            ? tile.states.reduce((sum, state) => sum + (countsByState.get(state) ?? 0), 0)
            : filteredTickets.length
          const active = tile.states ? stateFocus === tile.key : stateFocus === null
          const urgent = Boolean(tile.urgent) && count > 0

          return (
            <button
              key={tile.key}
              type="button"
              title={tile.hint}
              aria-pressed={active}
              onClick={() => setStateFocus(tile.states ? (active ? null : tile.key) : null)}
              className={`rounded-xl border px-3 py-2.5 text-left transition hover:border-coral/35 hover:bg-coral/[0.04] ${
                active ? tile.activeClass : 'border-line bg-card/70'
              } ${urgent && !active ? 'border-coral/30' : ''}`}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${tile.dot} ${urgent ? 'animate-soul' : ''}`}
                  aria-hidden
                />
                <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                  {tile.label}
                </span>
              </span>
              <span className="mt-1 block font-display text-2xl font-semibold leading-none text-ink">
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {/* Szűrősáv */}
      <div className="atelier-card !rounded-2xl !p-3 sm:!p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Keresés" htmlFor="board-search" className="w-full sm:w-56">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <input
                id="board-search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Cím, leírás, személy…"
                className={`${CONTROL_CLASS} !pl-9`}
              />
            </div>
          </Field>

          <Field label="Hozzárendelve" htmlFor="assignee-filter" className="w-full sm:w-48">
            <select
              id="assignee-filter"
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              className={CONTROL_CLASS}
            >
              {filterOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Módosítva">
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                id="updated-from-filter"
                type="date"
                value={fromDate}
                max={toDate}
                onChange={(e) => applyDateRange(e.target.value, toDate)}
                className={`${CONTROL_CLASS} !w-auto`}
              />
              <span className="text-sm text-ink-faint">–</span>
              <label htmlFor="updated-to-filter" className="sr-only">
                Módosítva eddig
              </label>
              <input
                id="updated-to-filter"
                type="date"
                value={toDate}
                min={fromDate}
                onChange={(e) => applyDateRange(fromDate, e.target.value)}
                className={`${CONTROL_CLASS} !w-auto`}
              />
              <div className="flex items-center gap-1">
                {[
                  { days: 7, label: '7 nap' },
                  { days: 30, label: '30 nap' },
                  { days: 90, label: '90 nap' },
                ].map((preset) => (
                  <button
                    key={preset.days}
                    type="button"
                    onClick={() => applyDayPreset(preset.days)}
                    title={`Az elmúlt ${preset.days} napban módosult feladatok`}
                    className="h-9 rounded-lg border border-line px-2.5 text-xs font-semibold text-ink-soft transition hover:border-coral/35 hover:bg-coral/5 hover:text-coral-deep"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </Field>

          {recentProcesses.length > 0 && (
            <Field label="Folyamat" htmlFor="process-filter" className="w-full sm:w-64">
              <select
                id="process-filter"
                value={processFilter}
                onChange={(e) => setProcessFilter(e.target.value)}
                className={CONTROL_CLASS}
              >
                <option value="all">Mind</option>
                {recentProcesses.map((process) => (
                  <option key={process.id} value={process.id}>
                    {process.processType} · #{process.id.slice(0, 8)} ·{' '}
                    {new Date(process.startedAt).toLocaleDateString('hu-HU')}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div className="ml-auto flex items-center gap-3 pb-0.5">
            <span className="whitespace-nowrap text-xs text-ink-faint">
              <span className="font-semibold text-ink-soft">{listTickets.length}</span> feladat
              látszik
            </span>
            {filtersActive && (
              <button
                type="button"
                onClick={resetFilters}
                className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:border-coral/35 hover:bg-coral/5 hover:text-coral-deep"
              >
                Szűrők törlése
              </button>
            )}
          </div>
        </div>

        {view === 'kanban' && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line/60 pt-3 text-xs text-ink-faint">
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={hideEmptyColumns}
                onChange={(e) => setHideEmptyColumns(e.target.checked)}
                className="accent-coral"
              />
              Üres oszlopok elrejtése
              {hideEmptyColumns && hiddenColumnCount > 0 && (
                <span className="rounded-full bg-ink/[0.05] px-2 py-0.5 font-semibold text-ink-soft">
                  {hiddenColumnCount} rejtve
                </span>
              )}
            </label>
            <span>
              Húzd a kártyát másik oszlopba az állapot módosításához — húzás közben az üres oszlopok
              is előjönnek.
            </span>
          </div>
        )}
      </div>

      {message && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          {message}
        </p>
      )}

      {view === 'list' ? (
        <BoardListView
          tickets={listTickets}
          canDispatch={canCreate}
          isAdmin={isAdmin}
          currentUserId={currentUserId}
          busyTicketId={busyTicketId}
          pending={pending}
          onStartDispatch={handleStartDispatch}
          onStopDispatch={handleStopDispatch}
          onDeleteError={setMessage}
        />
      ) : visibleColumns.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-card/50 px-6 py-14 text-center">
          <p className="font-display text-lg font-semibold text-ink">Nincs megjeleníthető feladat</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
            {filteredTickets.length === 0
              ? 'A tábla csak a kiválasztott időszakban módosult feladatokat mutatja. Bővítsd a dátumtartományt, vagy lazíts a szűrőkön.'
              : 'A kiválasztott állapotban most nincs feladat — a többi oszlopban viszont van.'}
          </p>
          {filtersActive && (
            <button
              type="button"
              onClick={resetFilters}
              className="mt-4 rounded-lg border border-coral/40 bg-coral/10 px-4 py-2 text-sm font-semibold text-coral transition hover:bg-coral/15"
            >
              Szűrők törlése
            </button>
          )}
        </div>
      ) : (
        <>
          {focusedStates && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
              <span className="rounded-full border border-coral/30 bg-coral/10 px-3 py-1 font-semibold text-coral-deep">
                Szűkítve: {SUMMARY_TILES.find((tile) => tile.key === stateFocus)?.label}
              </span>
              <button
                type="button"
                onClick={() => setStateFocus(null)}
                className="underline transition hover:text-coral-deep"
              >
                Minden oszlop mutatása
              </button>
            </div>
          )}

          <SyncedHorizontalScroll
            className={`flex items-start gap-3 overflow-x-auto pb-4 ${pending ? 'opacity-70' : ''}`}
          >
            {visibleColumns.map((col) => {
              const colTickets = filteredTickets.filter((t) => t.state === col.key)

              return (
                <KanbanColumn
                  key={col.key}
                  col={col}
                  tickets={colTickets}
                  isTarget={dropTarget === col.key}
                  isExpanded={expandedColumns.has(col.key)}
                  draggingId={draggingId}
                  busyTicketId={busyTicketId}
                  canDispatch={canCreate}
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
                    setDraggingId(null)
                    const ticketId = e.dataTransfer.getData('text/ticket-id')
                    if (ticketId) handleDrop(ticketId, col.key)
                  }}
                  onDragStart={setDraggingId}
                  onDragEnd={() => {
                    setDraggingId(null)
                    setDropTarget(null)
                  }}
                  onStartDispatch={handleStartDispatch}
                  onStopDispatch={handleStopDispatch}
                />
              )
            })}
          </SyncedHorizontalScroll>
        </>
      )}
    </div>
  )
}
