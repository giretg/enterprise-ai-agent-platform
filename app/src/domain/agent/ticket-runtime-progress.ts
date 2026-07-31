/**
 * Ticket futás közbeni progress snapshot (Aktív futások / ticket detail).
 * A `Ticket.payload.runtimeProgress` alá íródik, fojtva.
 */
import type { ToolLoopActivityEvent } from '@/domain/agent/chat-tool-loop'
import { upsertToolLoopActivity } from '@/domain/agent/agent-turn-snapshot'

export const TICKET_PROGRESS_FLUSH_INTERVAL_MS = 1_000
export const TICKET_PROGRESS_MAX_ACTIVITIES = 40

/** Ennyi ideig „élőnek” számít a progress snapshot (modell-hívás közben is). */
export const TICKET_PROGRESS_ACTIVE_MS = 45_000
/** Ennyi után a UI „úgy tűnik megállt”-ot jelez. */
export const TICKET_PROGRESS_STALL_MS = 120_000

export type TicketRuntimeProgress = {
  updatedAt: string
  activities: ToolLoopActivityEvent[]
  partialText?: string
}

export type TicketRunLiveness =
  | { kind: 'idle' }
  | { kind: 'cancelling' }
  | { kind: 'starting'; ageMs: number }
  | { kind: 'active'; ageMs: number; currentStep: string | null }
  | { kind: 'quiet'; ageMs: number; currentStep: string | null }
  | { kind: 'stalled'; ageMs: number; currentStep: string | null }

function activityStepLabel(activity: ToolLoopActivityEvent | undefined): string | null {
  if (!activity) return null
  return activity.title?.trim() || activity.kind || null
}

function latestActivityStep(activities: ToolLoopActivityEvent[]): string | null {
  const running = activities.find((activity) => activity.status === 'running')
  return activityStepLabel(running ?? activities[activities.length - 1])
}

/**
 * Ticket futás élősége a UI számára: `in_progress` + progress `updatedAt` / lock.
 * Nem állítja le a futást — csak jelzi, hogy van-e friss aktivitás.
 */
export function assessTicketRunLiveness(input: {
  ticketState: string
  cancelRequested?: boolean
  lockedAt?: string | Date | null
  progress: TicketRuntimeProgress | null
  nowMs?: number
}): TicketRunLiveness {
  if (input.ticketState !== 'in_progress') return { kind: 'idle' }
  if (input.cancelRequested) return { kind: 'cancelling' }

  const now = input.nowMs ?? Date.now()
  const activities = input.progress?.activities ?? []
  const currentStep = latestActivityStep(activities)

  const referenceMs = (() => {
    if (input.progress?.updatedAt) {
      const t = Date.parse(input.progress.updatedAt)
      if (Number.isFinite(t)) return t
    }
    if (input.lockedAt) {
      const t = new Date(input.lockedAt).getTime()
      if (Number.isFinite(t)) return t
    }
    return null
  })()

  if (referenceMs === null) {
    return { kind: 'starting', ageMs: 0 }
  }

  const ageMs = Math.max(0, now - referenceMs)

  if (activities.length === 0) {
    return ageMs >= TICKET_PROGRESS_STALL_MS
      ? { kind: 'stalled', ageMs, currentStep: null }
      : { kind: 'starting', ageMs }
  }

  if (ageMs < TICKET_PROGRESS_ACTIVE_MS) {
    return { kind: 'active', ageMs, currentStep }
  }
  if (ageMs < TICKET_PROGRESS_STALL_MS) {
    return { kind: 'quiet', ageMs, currentStep }
  }
  return { kind: 'stalled', ageMs, currentStep }
}

/** Relatív életkor mondatba illeszthetően: „45 másodperce”, „2 perce”. */
export function formatTicketProgressAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000))
  if (seconds < 60) return `${seconds} másodperce`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} perce`
  const hours = Math.floor(minutes / 60)
  return `${hours} órája`
}

export function readTicketRuntimeProgress(payload: unknown): TicketRuntimeProgress | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const progress = (payload as Record<string, unknown>).runtimeProgress
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return null
  const activities = Array.isArray((progress as Record<string, unknown>).activities)
    ? ((progress as Record<string, unknown>).activities as ToolLoopActivityEvent[])
    : []
  const partialText =
    typeof (progress as Record<string, unknown>).partialText === 'string'
      ? ((progress as Record<string, unknown>).partialText as string)
      : undefined
  const updatedAt =
    typeof (progress as Record<string, unknown>).updatedAt === 'string'
      ? ((progress as Record<string, unknown>).updatedAt as string)
      : new Date(0).toISOString()
  return { updatedAt, activities, partialText }
}

export class TicketProgressFlusher {
  private activities: ToolLoopActivityEvent[] = []
  private lastFlushAt: number | null = null
  private dirty = false

  constructor(
    private readonly now: () => number = Date.now,
    private readonly intervalMs = TICKET_PROGRESS_FLUSH_INTERVAL_MS,
  ) {}

  pushActivity(activity: ToolLoopActivityEvent): boolean {
    this.activities = upsertToolLoopActivity(this.activities, activity).slice(
      -TICKET_PROGRESS_MAX_ACTIVITIES,
    )
    this.dirty = true
    const t = this.now()
    // Ne fogyasszuk el a dirty flaget itt — a hívó snapshotIfDue/takeSnapshot
    // írja ki. (Korábbi bug: true + dirty=false → snapshotIfDue mindig null.)
    return this.lastFlushAt === null || t - this.lastFlushAt >= this.intervalMs
  }

  /** Terminális / kényszerített flush. */
  takeSnapshot(): TicketRuntimeProgress | null {
    if (this.activities.length === 0 && !this.dirty) return null
    this.lastFlushAt = this.now()
    this.dirty = false
    return {
      updatedAt: new Date(this.lastFlushAt).toISOString(),
      activities: [...this.activities],
    }
  }

  snapshotIfDue(): TicketRuntimeProgress | null {
    if (!this.dirty) return null
    const t = this.now()
    if (this.lastFlushAt !== null && t - this.lastFlushAt < this.intervalMs) return null
    return this.takeSnapshot()
  }
}

export function mergeRuntimeProgressIntoPayload(
  payload: Record<string, unknown>,
  progress: TicketRuntimeProgress,
): Record<string, unknown> {
  return {
    ...payload,
    runtimeProgress: progress,
  }
}
