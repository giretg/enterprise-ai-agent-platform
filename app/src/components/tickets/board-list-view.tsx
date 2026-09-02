'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { deleteBoardTicket } from '@/app/actions/platform'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { Badge } from '@/components/ui/shell'
import { ProcessBadge } from '@/components/processes/process-badge'
import { TICKET_STATE_LABELS, TICKET_STATE_TONE, TICKET_TONE_DOT_CLASS } from '@/lib/ticket-labels'
import {
  canDeleteBoardTicket,
  canStartTicketDispatch,
  formatTicketDateTime,
  type EnrichedBoardTicket,
} from '@/lib/ticket-display'
import { formatOriginLabel } from '@/lib/work-traceability'

export const BOARD_STATUS_GROUPS = [
  { key: 'backlog', label: TICKET_STATE_LABELS.backlog, accent: 'border-ink-faint/30' },
  { key: 'ready', label: TICKET_STATE_LABELS.ready, accent: 'border-honey/40' },
  { key: 'in_progress', label: TICKET_STATE_LABELS.in_progress, accent: 'border-sky/40' },
  { key: 'awaiting_human', label: TICKET_STATE_LABELS.awaiting_human, accent: 'border-coral/40' },
  { key: 'needs_info', label: TICKET_STATE_LABELS.needs_info, accent: 'border-honey/50' },
  { key: 'approved', label: TICKET_STATE_LABELS.approved, accent: 'border-sage/40' },
  { key: 'done', label: TICKET_STATE_LABELS.done, accent: 'border-sage/60' },
  { key: 'rejected', label: TICKET_STATE_LABELS.rejected, accent: 'border-coral/60' },
] as const

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

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  )
}

type BoardListViewProps = {
  tickets: EnrichedBoardTicket[]
  canDispatch: boolean
  isAdmin: boolean
  currentUserId?: string | null
  busyTicketId: string | null
  pending?: boolean
  onStartDispatch: (ticketId: string) => void
  onStopDispatch: (ticketId: string) => void
  onDeleteError: (message: string) => void
}

function TicketActions({
  ticket,
  canDispatch,
  isAdmin,
  currentUserId,
  busyTicketId,
  deleteBusyTicketId,
  onStartDispatch,
  onStopDispatch,
  onDelete,
}: {
  ticket: EnrichedBoardTicket
  canDispatch: boolean
  isAdmin: boolean
  currentUserId?: string | null
  busyTicketId: string | null
  deleteBusyTicketId: string | null
  onStartDispatch: (ticketId: string) => void
  onStopDispatch: (ticketId: string) => void
  onDelete: (ticketId: string, isAdminDelete: boolean) => void
}) {
  const canStart = canDispatch && canStartTicketDispatch(ticket)
  const canStop = canDispatch && ticket.state === 'in_progress'
  const deleteInfo = canDeleteBoardTicket(ticket, {
    isAdmin,
    canManage: canDispatch,
    userId: currentUserId,
  })
  const isBusy = busyTicketId === ticket.id
  const isDeleteBusy = deleteBusyTicketId === ticket.id

  if (!canStart && !canStop && !deleteInfo.allowed) {
    return <span className="text-xs text-ink-faint">—</span>
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {canStart && (
        <button
          type="button"
          disabled={isBusy || isDeleteBusy}
          title="Feldolgozás indítása"
          aria-label="Feldolgozás indítása"
          onClick={() => onStartDispatch(ticket.id)}
          className="inline-flex items-center gap-1 rounded-lg border border-accent/30 px-2.5 py-1.5 text-xs font-semibold text-accent transition hover:border-accent/50 hover:bg-accent/10 disabled:opacity-40"
        >
          <PlayIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Indítás</span>
        </button>
      )}
      {canStop && (
        <button
          type="button"
          disabled={isBusy || isDeleteBusy}
          title="Feldolgozás leállítása"
          aria-label="Feldolgozás leállítása"
          onClick={() => onStopDispatch(ticket.id)}
          className="inline-flex items-center gap-1 rounded-lg border border-coral/30 px-2.5 py-1.5 text-xs font-semibold text-coral transition hover:border-coral/50 hover:bg-coral/10 disabled:opacity-40"
        >
          <StopIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Leállítás</span>
        </button>
      )}
      {deleteInfo.allowed && (
        <button
          type="button"
          disabled={isBusy || isDeleteBusy}
          title={
            deleteInfo.isAdminDelete
              ? 'Admin törlés — bármilyen állapotú feladat'
              : 'Feladat törlése — csak feldolgozás megkezdése előtt'
          }
          aria-label="Feladat törlése"
          onClick={() => onDelete(ticket.id, deleteInfo.isAdminDelete)}
          className="inline-flex items-center gap-1 rounded-lg border border-coral/25 px-2.5 py-1.5 text-xs font-semibold text-coral/90 transition hover:border-coral/45 hover:bg-coral/10 disabled:opacity-40"
        >
          <TrashIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{isDeleteBusy ? 'Törlés…' : 'Törlés'}</span>
        </button>
      )}
    </div>
  )
}

export function BoardListView({
  tickets,
  canDispatch,
  isAdmin,
  currentUserId,
  busyTicketId,
  pending = false,
  onStartDispatch,
  onStopDispatch,
  onDeleteError,
}: BoardListViewProps) {
  const router = useRouter()
  const [, startDeleteTransition] = useTransition()
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null)

  const handleDelete = (ticketId: string, isAdminDelete: boolean) => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: isAdminDelete ? 'Feladat végleges törlése' : 'Feladat törlése',
        description: isAdminDelete
          ? 'Biztosan véglegesen törlöd ezt a feladatot (admin)? A művelet nem vonható vissza, és a csatolt fájlok is törlődnek.'
          : 'Biztosan törlöd ezt a feladatot? A művelet nem vonható vissza, és a csatolt fájlok is törlődnek.',
        confirmLabel: 'Törlés',
        tone: 'danger',
      })
      if (!confirmed) return

      setDeleteBusyId(ticketId)
      startDeleteTransition(async () => {
        try {
          const res = await deleteBoardTicket({ ticketId })
          if (!res.success) {
            onDeleteError(res.error ?? 'Törlés sikertelen.')
            return
          }
          router.refresh()
        } finally {
          setDeleteBusyId(null)
        }
      })
    })()
  }

  const grouped = BOARD_STATUS_GROUPS.map((group) => ({
    ...group,
    tickets: tickets.filter(
      (ticket) =>
        !ticket.hiddenAsProcessChild && (ticket.boardColumnState || ticket.state) === group.key,
    ),
  })).filter((group) => group.tickets.length > 0)

  if (grouped.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-night-2/50 px-6 py-12 text-center">
        <p className="text-sm font-medium text-ink-soft">Nincs megjeleníthető feladat</p>
        <p className="mt-1 text-xs text-ink-faint">Próbálj lazítani a szűrőkön, vagy módosítsd a dátumtartományt.</p>
      </div>
    )
  }

  return (
    <div className={`space-y-8 ${pending ? 'opacity-70' : ''}`}>
      {grouped.map((group) => {
        const tone = TICKET_STATE_TONE[group.key] ?? 'neutral'
        const dotClass = TICKET_TONE_DOT_CLASS[tone]

        return (
          <section
            key={group.key}
            className={`rounded-xl border border-line border-t-2 ${group.accent} bg-night-2/30`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 px-4 py-3 sm:px-5">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden />
                <h2 className="text-sm font-semibold text-ink">{group.label}</h2>
              </div>
              <Badge>{group.tickets.length}</Badge>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-line/50 text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold sm:px-5">Feladat</th>
                    <th className="hidden px-3 py-2.5 font-semibold md:table-cell">Típus</th>
                    <th className="px-3 py-2.5 font-semibold">Hozzárendelve</th>
                    <th className="hidden px-3 py-2.5 font-semibold lg:table-cell">Létrehozta</th>
                    <th className="hidden px-3 py-2.5 font-semibold xl:table-cell">Folyamat</th>
                    <th className="hidden px-3 py-2.5 font-semibold lg:table-cell">Ütemezés</th>
                    <th className="px-3 py-2.5 font-semibold">Módosítva</th>
                    <th className="px-4 py-2.5 text-right font-semibold sm:px-5">Műveletek</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {group.tickets.map((ticket) => (
                    <tr
                      key={ticket.id}
                      className="transition-colors hover:bg-coral/[0.03]"
                    >
                      <td className="px-4 py-3 sm:px-5">
                        <Link
                          href={`/control-plane/tickets/${ticket.openTicketId}`}
                          className="group block min-w-0"
                        >
                          <p className="font-medium text-ink transition group-hover:text-coral-deep">
                            {ticket.title}
                          </p>
                          {ticket.stepsTotal != null && ticket.stepsTotal > 0 ? (
                            <p className="mt-0.5 text-[11px] text-ink-faint">
                              {ticket.stepsDone ?? 0}/{ticket.stepsTotal} lépés
                            </p>
                          ) : null}
                          {ticket.origin?.href ? (
                            <Link
                              href={ticket.origin.href}
                              className="mt-0.5 block text-[11px] font-medium text-coral hover:underline"
                            >
                              {formatOriginLabel(ticket.origin)} →
                            </Link>
                          ) : ticket.origin ? (
                            <p className="mt-0.5 text-[11px] text-ink-faint">
                              {formatOriginLabel(ticket.origin)}
                            </p>
                          ) : null}
                          {ticket.nestedSteps.length > 0 ? (
                            <p className="mt-0.5 text-[11px] text-ink-faint">
                              {ticket.nestedSteps
                                .map((step) => `${step.stepName} (${step.stateLabel})`)
                                .join(' · ')}
                            </p>
                          ) : null}
                          <p className="mt-0.5 text-xs text-ink-faint md:hidden">
                            {ticket.type === 'training' ? 'Tanítás' : 'Interakció'}
                          </p>
                        </Link>
                      </td>
                      <td className="hidden px-3 py-3 md:table-cell">
                        <Badge tone="neutral">
                          {ticket.type === 'training' ? 'Tanítás' : 'Interakció'}
                        </Badge>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-ink-soft">{ticket.assignee.label}</span>
                          {ticket.assignee.type === 'agent' && <Badge tone="neutral">AI</Badge>}
                          {ticket.assignee.type === 'human' && <Badge tone="warning">Ember</Badge>}
                        </div>
                      </td>
                      <td className="hidden px-3 py-3 text-ink-soft lg:table-cell">
                        {ticket.creator.label}
                      </td>
                      <td className="hidden px-3 py-3 xl:table-cell">
                        {ticket.process ? (
                          <ProcessBadge
                            processInstanceId={ticket.process.id}
                            processType={ticket.process.processType}
                            status={ticket.process.status}
                          />
                        ) : (
                          <span className="text-xs text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="hidden px-3 py-3 lg:table-cell">
                        {ticket.schedule ? (
                          <span
                            className="text-xs font-medium text-honey"
                            title={ticket.schedule.label}
                          >
                            {ticket.schedule.compactLabel}
                          </span>
                        ) : (
                          <span className="text-xs text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-ink-faint">
                        <time dateTime={new Date(ticket.updatedAt).toISOString()}>
                          {formatTicketDateTime(ticket.updatedAt)}
                        </time>
                      </td>
                      <td className="px-4 py-3 sm:px-5">
                        <TicketActions
                          ticket={ticket}
                          canDispatch={canDispatch}
                          isAdmin={isAdmin}
                          currentUserId={currentUserId}
                          busyTicketId={busyTicketId}
                          deleteBusyTicketId={deleteBusyId}
                          onStartDispatch={onStartDispatch}
                          onStopDispatch={onStopDispatch}
                          onDelete={handleDelete}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}
    </div>
  )
}
