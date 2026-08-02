'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { getToolUiLabel } from '@/lib/tool-ui-labels'
import {
  assessTicketRunLiveness,
  formatTicketProgressAge,
  readTicketRuntimeProgress,
  type TicketRunLiveness,
  type TicketRuntimeProgress,
} from '@/domain/agent/ticket-runtime-progress'
import type { ToolLoopActivityEvent } from '@/domain/agent/chat-tool-loop'

type TicketActivitySource = {
  id: string
  state: string
  payload: unknown
  cancelRequested?: boolean
  lockedAt?: string | Date | null
}

type Tone = 'sky' | 'honey' | 'coral' | 'sage' | 'neutral'

function activityStatusLabel(status: ToolLoopActivityEvent['status']): string {
  switch (status) {
    case 'running':
      return 'fut'
    case 'done':
      return 'kész'
    case 'skipped':
      return 'kihagyva'
    case 'error':
      return 'hiba'
  }
}

function activityDotClass(status: ToolLoopActivityEvent['status']): string {
  switch (status) {
    case 'running':
      return 'bg-sky'
    case 'done':
      return 'bg-sage'
    case 'skipped':
      return 'bg-honey'
    case 'error':
      return 'bg-coral'
  }
}

function activityStatusChipClass(status: ToolLoopActivityEvent['status']): string {
  switch (status) {
    case 'running':
      return 'bg-sky/12 text-sky'
    case 'done':
      return 'bg-sage/12 text-sage'
    case 'skipped':
      return 'bg-honey/12 text-honey'
    case 'error':
      return 'bg-coral/12 text-coral'
  }
}

function activityDisplayTitle(activity: ToolLoopActivityEvent): string {
  if (activity.kind === 'tool') return getToolUiLabel(activity.title).label
  return activity.title
}

function livenessCopy(liveness: TicketRunLiveness): {
  label: string
  detail: string
  tone: Tone
} {
  switch (liveness.kind) {
    case 'cancelling':
      return {
        label: 'Leállítás folyamatban',
        detail: 'A stop kérés megérkezett; az AI munkatárs a következő biztonságos ponton kilép.',
        tone: 'honey',
      }
    case 'starting':
      return {
        label: 'Indul…',
        detail:
          liveness.ageMs > 0
            ? `Még nincs tool-hívás · ${formatTicketProgressAge(liveness.ageMs)}`
            : 'A dispatcher elindította a futást, az első lépésre várunk.',
        tone: 'sky',
      }
    case 'active':
      return {
        label: 'Feldolgozás folyamatban',
        detail: liveness.currentStep
          ? `Most ezen dolgozik: ${liveness.currentStep}`
          : `Utolsó jelzés ${formatTicketProgressAge(liveness.ageMs)}`,
        tone: 'sky',
      }
    case 'quiet':
      return {
        label: 'Dolgozik — lassabb szakasz',
        detail: liveness.currentStep
          ? `Utolsó lépés: ${liveness.currentStep} · ${formatTicketProgressAge(liveness.ageMs)}`
          : `Nincs friss jelzés ${formatTicketProgressAge(liveness.ageMs)} — hosszú modell-hívás is lehet.`,
        tone: 'honey',
      }
    case 'stalled':
      return {
        label: 'Úgy tűnik megállt',
        detail: liveness.currentStep
          ? `Beragadt itt: ${liveness.currentStep} · nincs friss jelzés ${formatTicketProgressAge(liveness.ageMs)}`
          : `Nincs friss aktivitás ${formatTicketProgressAge(liveness.ageMs)}. Ha így marad, állítsd le.`,
        tone: 'coral',
      }
    case 'idle':
      return {
        label: 'Eseménytörténet',
        detail: 'Most nem fut semmi — alább a legutóbbi futás lépései.',
        tone: 'neutral',
      }
  }
}

function bandClasses(tone: Tone): string {
  switch (tone) {
    case 'sky':
      return 'border-sky/30 bg-sky/8'
    case 'honey':
      return 'border-honey/35 bg-honey/8'
    case 'coral':
      return 'border-coral/35 bg-coral/8'
    case 'sage':
      return 'border-sage/30 bg-sage/8'
    case 'neutral':
      return 'border-line bg-night-2/50'
  }
}

function toneDotClass(tone: Tone): string {
  switch (tone) {
    case 'sky':
      return 'bg-sky'
    case 'honey':
      return 'bg-honey'
    case 'coral':
      return 'bg-coral'
    case 'sage':
      return 'bg-sage'
    case 'neutral':
      return 'bg-ink-faint'
  }
}

/** Élő pötty: futás közben lüktet, lezárt futásnál nyugodt. */
function StatusDot({ tone, live }: { tone: Tone; live: boolean }) {
  return (
    <span className="relative mt-1 flex h-3 w-3 shrink-0" aria-hidden>
      {live && (
        <span
          className={`absolute inline-flex h-full w-full rounded-full opacity-60 ${toneDotClass(tone)} animate-activity-run-dot`}
        />
      )}
      <span className={`relative inline-flex h-3 w-3 rounded-full ${toneDotClass(tone)}`} />
    </span>
  )
}

function ActivityRow({ activity, live }: { activity: ToolLoopActivityEvent; live: boolean }) {
  const running = activity.status === 'running'
  // Lezárt futásban ottfelejtett „running” lépés nem fut — félrevezető lenne annak mutatni.
  const stale = running && !live
  return (
    <li className="relative pl-7">
      <span
        className={`absolute left-[3px] top-[7px] h-2.5 w-2.5 rounded-full ring-4 ring-card ${
          stale ? 'bg-ink-faint' : activityDotClass(activity.status)
        } ${running && live ? 'animate-activity-run-dot' : ''}`}
        aria-hidden
      />
      <div
        className={`min-w-0 rounded-lg px-2 py-1 ${
          running && live ? '-ml-2 animate-activity-run-row' : ''
        }`}
      >
        <div className="flex min-w-0 flex-wrap items-baseline gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-ink" title={activity.title}>
            {activityDisplayTitle(activity)}
          </span>
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              stale ? 'bg-ink/8 text-ink-faint' : activityStatusChipClass(activity.status)
            }`}
          >
            {stale ? 'félbemaradt' : activityStatusLabel(activity.status)}
          </span>
          {activity.kind === 'reasoning' && (
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">
              gondolkodás
            </span>
          )}
        </div>
        {(activity.detail || activity.archivePath) && (
          <p
            className={`mt-0.5 truncate text-xs text-ink-faint ${
              activity.kind === 'reasoning' ? 'italic' : ''
            }`}
            title={activity.archivePath ?? activity.detail}
          >
            {activity.detail}
            {activity.archivePath ? ` · ${activity.archivePath}` : ''}
          </p>
        )}
      </div>
    </li>
  )
}

const COLLAPSED_STEPS = 6

function ActivityTimeline({
  progress,
  live,
}: {
  progress: TicketRuntimeProgress
  live: boolean
}) {
  const activities = progress.activities
  const [expanded, setExpanded] = useState(false)
  // Futás közben mindig a friss lépések látszanak, lezárt futásnál a végállapot.
  const collapsible = activities.length > COLLAPSED_STEPS
  const visible = expanded || !collapsible ? activities : activities.slice(-COLLAPSED_STEPS)

  return (
    <div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="mb-3 rounded-full border border-line bg-card px-3 py-1 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep"
        >
          {expanded
            ? 'Csak az utolsó lépések'
            : `Korábbi lépések mutatása (${activities.length - COLLAPSED_STEPS})`}
        </button>
      )}
      <ol className="relative space-y-2.5">
        <span className="absolute bottom-2 left-[7px] top-2 w-px bg-ink/12" aria-hidden />
        {visible.map((activity) => (
          <ActivityRow key={activity.id} activity={activity} live={live} />
        ))}
      </ol>
    </div>
  )
}

/**
 * Feldolgozás-panel: egy helyen mutatja, hogy fut-e a feladat, mit csinál most
 * az AI munkatárs, mi történt eddig, és hogyan lehet leállítani.
 */
export function TicketActivityHistory({ ticket }: { ticket: TicketActivitySource }) {
  const router = useRouter()
  const progress = readTicketRuntimeProgress(ticket.payload)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [stopPending, setStopPending] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const inProgress = ticket.state === 'in_progress'
  const hasActivities = Boolean(progress && progress.activities.length > 0)

  // Élő futásnál a szerver-oldali payload újratöltése tartja frissen a lépéseket.
  useEffect(() => {
    if (!inProgress) return
    const refresh = window.setInterval(() => router.refresh(), 2_000)
    const tick = window.setInterval(() => setNowMs(Date.now()), 5_000)
    return () => {
      window.clearInterval(refresh)
      window.clearInterval(tick)
    }
  }, [inProgress, router])

  const liveness = assessTicketRunLiveness({
    ticketState: ticket.state,
    cancelRequested: ticket.cancelRequested,
    lockedAt: ticket.lockedAt,
    progress,
    nowMs,
  })

  if (!inProgress && !hasActivities) return null

  const { label, detail, tone } = livenessCopy(liveness)
  const activities = progress?.activities ?? []
  const doneCount = activities.filter((activity) => activity.status === 'done').length
  const errorCount = activities.filter((activity) => activity.status === 'error').length
  const partialText = progress?.partialText?.trim()

  const stopProcessing = () => {
    if (stopPending) return
    setStopPending(true)
    setStopError(null)
    void (async () => {
      try {
        const res = await fetch(`/api/v1/tickets/${ticket.id}/cancel`, { method: 'POST' })
        if (!res.ok) {
          setStopError(
            res.status === 404
              ? 'A feladat már nem fut — lehet, hogy közben befejeződött.'
              : 'A leállítás nem sikerült.',
          )
        }
        router.refresh()
      } catch {
        setStopError('A leállítás nem sikerült.')
      } finally {
        setStopPending(false)
      }
    })()
  }

  return (
    <section className="atelier-card overflow-hidden">
      <div className={`flex flex-wrap items-start gap-3 border-b px-5 py-4 ${bandClasses(tone)}`}>
        <StatusDot tone={tone} live={inProgress} />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg font-semibold tracking-tight text-ink">{label}</h2>
          <p className="mt-0.5 text-sm text-ink-soft">{detail}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {activities.length > 0 && (
            <span className="rounded-full bg-card px-2.5 py-1 text-xs font-semibold text-ink-soft">
              {doneCount}/{activities.length} lépés kész
              {errorCount > 0 ? ` · ${errorCount} hiba` : ''}
            </span>
          )}
          {inProgress && (
            <button
              type="button"
              disabled={stopPending}
              onClick={stopProcessing}
              className="rounded-full border border-coral/40 bg-coral/12 px-3.5 py-1.5 text-xs font-semibold text-coral-deep transition-colors hover:bg-coral/22 disabled:opacity-50"
            >
              {stopPending ? 'Leállítás…' : 'Feldolgozás leállítása'}
            </button>
          )}
        </div>
      </div>

      <div className="p-5">
        {stopError && <p className="mb-3 text-sm text-coral">{stopError}</p>}

        {hasActivities && progress ? (
          <ActivityTimeline progress={progress} live={inProgress} />
        ) : (
          <p className="text-sm text-ink-soft">
            Még nincs rögzített lépés. Ha percek múlva sem történik semmi, a futás beragadhatott —
            állítsd le a fenti gombbal, majd indítsd újra.
          </p>
        )}

        {inProgress && partialText && (
          <div className="mt-4 rounded-xl border border-line bg-night-2/60 p-3">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Készülő válasz
            </p>
            <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">
              {partialText.slice(-600)}
            </p>
          </div>
        )}

        {inProgress && (
          <p className="mt-4 text-xs text-ink-faint">
            Ez a lista magától frissül, nem kell újratöltened az oldalt. A végleges válasz a
            Feladat-szálban jelenik meg.
          </p>
        )}
      </div>
    </section>
  )
}
