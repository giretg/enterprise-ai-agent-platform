'use client'

import type { ComposedRun } from '@/lib/active-runs-compose'
import {
  formatRunClock,
  formatRunElapsed,
  formatRunTimestamp,
  isRoutineStatus,
  kindLabel,
  runPhaseTone,
  statusLabel,
  type RunTone,
} from '@/lib/active-runs-labels'

const DOT_CLASS: Record<RunTone, string> = {
  neutral: 'bg-sky',
  success: 'bg-sage',
  warning: 'bg-honey',
  danger: 'bg-coral',
}

const CHIP_CLASS: Record<RunTone, string> = {
  neutral: 'bg-sky/12 text-sky',
  success: 'bg-sage/12 text-sage',
  warning: 'bg-honey/15 text-honey',
  danger: 'bg-coral/15 text-coral',
}

function KindIcon({ kind }: { kind: ComposedRun['kind'] }) {
  const common = 'h-3.5 w-3.5 shrink-0 text-ink-faint'
  if (kind === 'chat_turn') {
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden className={common}>
        <path
          d="M2.5 6.5A3 3 0 0 1 5.5 3.5h5a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3H7l-3 2.2V11.5a3 3 0 0 1-1.5-2.6v-2.4Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={common}>
      <rect x="3" y="3" width="10" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 6.5h4M6 9h4M6 11.5h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Egy futás egy sorban: állapot-pötty, ki dolgozik rajta, mit csinál éppen,
 * mikor — és csak akkor gomb, ha tényleg tehetsz vele valamit (indítás / leállítás).
 * Maga a sor kattintható a megnyitáshoz, így nem kell külön „Megtekintés”.
 */
export function RunRow({
  run,
  dense = false,
  stopping = false,
  starting = false,
  onOpen,
  onStop,
  onStart,
}: {
  run: ComposedRun
  /** Fejléc-panel: szűkebb sorok, kisebb betű. */
  dense?: boolean
  stopping?: boolean
  starting?: boolean
  onOpen: (run: ComposedRun) => void
  onStop?: (run: ComposedRun) => void
  onStart?: (run: ComposedRun) => void
}) {
  const tone = runPhaseTone(run)
  const active = run.phase === 'active'
  const label = statusLabel(run)
  const routine = isRoutineStatus(run)
  const unseen = run.phase === 'completed' && !run.seen
  const stamp = run.finishedAt ?? run.startedAt
  const when = active ? formatRunElapsed(run.startedAt) : formatRunClock(stamp)
  const canStop = active && run.canStop && onStop
  const canStart = active && run.canStart && onStart
  const actionBusy = stopping || starting

  return (
    <div
      className={`group flex items-center gap-2.5 rounded-xl px-2.5 transition-colors hover:bg-coral/[0.06] ${
        dense ? 'py-1.5' : 'py-2'
      } ${unseen ? 'bg-sky/[0.06]' : ''}`}
    >
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
        {active && run.status !== 'ready' && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${DOT_CLASS[tone]}`}
          />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${DOT_CLASS[tone]}`} />
      </span>

      <button
        type="button"
        onClick={() => onOpen(run)}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
        title={`${kindLabel(run.kind)} · ${label ?? ''} · ${formatRunTimestamp(stamp)}`}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <KindIcon kind={run.kind} />
          <span
            className={`truncate font-medium text-ink transition-colors group-hover:text-coral-deep ${
              dense ? 'text-[13px]' : 'text-sm'
            }`}
          >
            {run.title}
          </span>
          {label &&
            (routine ? (
              <span className="shrink-0 text-[11px] text-sage">{label}</span>
            ) : (
              <span
                className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${CHIP_CLASS[tone]}`}
              >
                {label}
              </span>
            ))}
          {unseen && (
            <span className="shrink-0 rounded-full bg-sky/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky">
              új
            </span>
          )}
        </span>
        {run.latestActivity && (
          <span className="line-clamp-1 w-full text-[11px] text-ink-faint">{run.latestActivity}</span>
        )}
      </button>

      <span
        className="shrink-0 text-[11px] tabular-nums text-ink-faint"
        title={formatRunTimestamp(stamp)}
      >
        {when}
      </span>

      {canStart && (
        <button
          type="button"
          disabled={actionBusy}
          onClick={() => onStart?.(run)}
          className="shrink-0 rounded-full border border-honey/40 bg-honey/10 px-2 py-0.5 text-[11px] font-semibold text-honey transition-colors hover:border-honey/60 hover:bg-honey/20 disabled:opacity-50"
        >
          {starting ? 'Indítás…' : 'Indítás'}
        </button>
      )}

      {canStop && (
        <button
          type="button"
          disabled={actionBusy}
          onClick={() => onStop?.(run)}
          className="shrink-0 rounded-full border border-coral/30 px-2 py-0.5 text-[11px] font-semibold text-coral-deep transition-colors hover:bg-coral/10 disabled:opacity-50"
        >
          {stopping ? 'Leállítás…' : 'Leállítás'}
        </button>
      )}
    </div>
  )
}

export function RunsSummaryChips({
  chips,
}: {
  chips: { key: string; label: string; tone: RunTone }[]
}) {
  if (chips.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${CHIP_CLASS[chip.tone]}`}
        >
          {chip.label}
        </span>
      ))}
    </div>
  )
}
