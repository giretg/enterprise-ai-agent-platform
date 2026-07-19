/**
 * Ticket futás közbeni progress snapshot (Aktív futások / ticket detail).
 * A `Ticket.payload.runtimeProgress` alá íródik, fojtva.
 */
import type { ToolLoopActivityEvent } from '@/domain/agent/chat-tool-loop'
import { upsertToolLoopActivity } from '@/domain/agent/agent-turn-snapshot'

export const TICKET_PROGRESS_FLUSH_INTERVAL_MS = 1_000
export const TICKET_PROGRESS_MAX_ACTIVITIES = 40

export type TicketRuntimeProgress = {
  updatedAt: string
  activities: ToolLoopActivityEvent[]
  partialText?: string
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
    if (this.lastFlushAt === null || t - this.lastFlushAt >= this.intervalMs) {
      this.lastFlushAt = t
      this.dirty = false
      return true
    }
    return false
  }

  /** Terminális / kényszerített flush. */
  takeSnapshot(): TicketRuntimeProgress | null {
    if (this.activities.length === 0 && !this.dirty) return null
    this.lastFlushAt = this.now()
    this.dirty = false
    return {
      updatedAt: new Date(this.lastFlushAt).toISOString(),
      activities: this.activities,
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
