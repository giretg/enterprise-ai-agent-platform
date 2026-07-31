'use client'

import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/shell'
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
  state: string
  payload: unknown
  cancelRequested?: boolean
  lockedAt?: string | Date | null
}

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

function activityDisplayTitle(activity: ToolLoopActivityEvent): string {
  if (activity.kind === 'tool') return getToolUiLabel(activity.title).label
  return activity.title
}

function livenessCopy(liveness: TicketRunLiveness): {
  label: string
  detail: string
  tone: 'sky' | 'honey' | 'coral' | 'neutral'
} {
  switch (liveness.kind) {
    case 'cancelling':
      return {
        label: 'Leállítás folyamatban',
        detail: 'A stop kérés megérkezett; az agent a következő biztonságos ponton kilép.',
        tone: 'honey',
      }
    case 'starting':
      return {
        label: 'Indul…',
        detail:
          liveness.ageMs > 0
            ? `Még nincs tool-hívás · ${formatTicketProgressAge(liveness.ageMs)}`
            : 'A dispatcher elindította a futást, az első aktivitásra várunk.',
        tone: 'sky',
      }
    case 'active':
      return {
        label: 'Élő folyamat',
        detail: liveness.currentStep
          ? `Most: ${liveness.currentStep}`
          : `Utolsó jelzés ${formatTicketProgressAge(liveness.ageMs)}`,
        tone: 'sky',
      }
    case 'quiet':
      return {
        label: 'Lassú jelzés',
        detail: liveness.currentStep
          ? `Utolsó lépés: ${liveness.currentStep} · ${formatTicketProgressAge(liveness.ageMs)}`
          : `Nincs friss aktivitás ${formatTicketProgressAge(liveness.ageMs)} — hosszú modell-hívás is lehet.`,
        tone: 'honey',
      }
    case 'stalled':
      return {
        label: 'Úgy tűnik megállt',
        detail: liveness.currentStep
          ? `Beragadt itt: ${liveness.currentStep} · nincs friss jelzés ${formatTicketProgressAge(liveness.ageMs)}`
          : `Nincs friss aktivitás ${formatTicketProgressAge(liveness.ageMs)}. Beragadás esetén állítsd le.`,
        tone: 'coral',
      }
    case 'idle':
      return {
        label: 'Lezárva',
        detail: 'A futás már nem folyamatban van.',
        tone: 'neutral',
      }
  }
}

function toneClasses(tone: 'sky' | 'honey' | 'coral' | 'neutral'): string {
  switch (tone) {
    case 'sky':
      return 'border-sky/35 bg-sky/5'
    case 'honey':
      return 'border-honey/40 bg-honey/5'
    case 'coral':
      return 'border-coral/40 bg-coral/5'
    case 'neutral':
      return 'border-line bg-night-2/70'
  }
}

function ActivityRow({
  activity,
  prominent = false,
}: {
  activity: ToolLoopActivityEvent
  prominent?: boolean
}) {
  const running = activity.status === 'running'
  return (
    <div
      className={`flex min-w-0 items-start gap-2 rounded-md ${
        prominent && running ? '-mx-1 px-1 py-1 animate-activity-run-row' : ''
      }`}
    >
      <span
        className={`mt-1.5 shrink-0 rounded-full ${activityDotClass(activity.status)} ${
          running
            ? prominent
              ? 'h-2.5 w-2.5 animate-activity-run-dot'
              : 'h-2 w-2 animate-pulse'
            : 'h-2 w-2'
        }`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium text-ink" title={activity.title}>
            {activityDisplayTitle(activity)}
          </span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">
            {activityStatusLabel(activity.status)}
          </span>
        </div>
        {(activity.detail || activity.archivePath) && (
          <p
            className={`truncate text-[11px] text-ink-faint ${
              activity.kind === 'reasoning' ? 'italic' : ''
            }`}
            title={activity.archivePath ?? activity.detail}
          >
            {activity.detail}
            {activity.archivePath ? ` · ${activity.archivePath}` : ''}
          </p>
        )}
      </div>
    </div>
  )
}

function ActivityTimeline({
  progress,
  liveness,
  defaultOpen = false,
}: {
  progress: TicketRuntimeProgress
  liveness: TicketRunLiveness
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const activities = progress.activities
  const running = activities.find((activity) => activity.status === 'running')
  const latest = running ?? activities[activities.length - 1]
  const hasError = activities.some((activity) => activity.status === 'error')
  const doneCount = activities.filter((activity) => activity.status === 'done').length
  const { label, detail, tone } = livenessCopy(liveness)

  const headerHint =
    liveness.kind === 'idle'
      ? hasError
        ? 'Hibával zárult'
        : `${doneCount}/${activities.length} lépés kész`
      : label

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className={`rounded-lg border px-3 py-2 text-xs text-ink-soft transition-colors ${toneClasses(tone)}`}
    >
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-3 font-medium text-ink">
          <span className="min-w-0 truncate">
            Tool-hívások és lépések
            <span className="ml-2 font-normal text-ink-faint">{headerHint}</span>
          </span>
          <span className="shrink-0 rounded-full bg-card px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint">
            {open ? 'Bezár' : 'Megnyit'} · {activities.length}
          </span>
        </div>
        {!open && latest ? (
          <div className="mt-2">
            <ActivityRow activity={latest} prominent={latest.status === 'running'} />
          </div>
        ) : null}
        {!open && liveness.kind !== 'idle' ? (
          <p className="mt-1.5 text-[11px] text-ink-faint">{detail}</p>
        ) : null}
      </summary>
      {open ? (
        <div className="mt-2 space-y-1.5 border-t border-ink/10 pt-2">
          {activities.map((activity) => (
            <ActivityRow
              key={activity.id}
              activity={activity}
              prominent={activity.status === 'running'}
            />
          ))}
        </div>
      ) : null}
    </details>
  )
}

export function TicketActivityHistory({ ticket }: { ticket: TicketActivitySource }) {
  const progress = readTicketRuntimeProgress(ticket.payload)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const inProgress = ticket.state === 'in_progress'
  const hasActivities = Boolean(progress && progress.activities.length > 0)

  useEffect(() => {
    if (!inProgress) return
    const tick = window.setInterval(() => setNowMs(Date.now()), 5_000)
    return () => window.clearInterval(tick)
  }, [inProgress])

  const liveness = assessTicketRunLiveness({
    ticketState: ticket.state,
    cancelRequested: ticket.cancelRequested,
    lockedAt: ticket.lockedAt,
    progress,
    nowMs,
  })

  if (!inProgress && !hasActivities) return null

  const { label, detail, tone } = livenessCopy(liveness)

  return (
    <Card title="Eseménytörténet">
      {inProgress && (
        <div className={`mb-3 rounded-lg border px-3 py-2 ${toneClasses(tone)}`}>
          <p className="text-sm font-semibold text-ink">{label}</p>
          <p className="mt-0.5 text-xs text-ink-faint">{detail}</p>
        </div>
      )}

      {hasActivities && progress ? (
        <ActivityTimeline
          progress={progress}
          liveness={liveness}
          defaultOpen={inProgress && (liveness.kind === 'stalled' || liveness.kind === 'quiet')}
        />
      ) : (
        <p className="text-sm text-ink-soft">
          Még nincs tool-hívás vagy gondolkodási lépés rögzítve. Ha sokáig így marad, a futás
          beragadhatott — állítsd le a Műveletek panelen.
        </p>
      )}
    </Card>
  )
}
