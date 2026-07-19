/**
 * chat-agent-turn-resilience-spec.md §5.3 / D9 / Q4 — futó forduló
 * snapshot-kiírásának fojtása és tartalom-őre (issue #63).
 *
 * A részszöveg NEM minden tokennél megy a DB-be: idő- (~1 mp) vagy
 * karakterszám- (~200) küszöb felett flushol. Az aktivitások ritkábbak —
 * eseményenként. Terminális állapotban a teljes aktuális részszöveg kiíródik.
 *
 * Tartalom-őr (Q4): a kiírandó részszöveg ugyanazon a `redactSensitiveText`
 * szűrőn megy át, mint az outbound reasoning/válasz — osztályozatlan tartalom
 * nem kerülhet tartós tárba.
 */
import { redactSensitiveText } from '../gateway/sensitivity-router'
import type { ToolLoopActivityEvent } from './chat-tool-loop'

/** Spec §5.3 / D9 — dokumentált alapérték. */
export const PARTIAL_TEXT_FLUSH_INTERVAL_MS = 1_000
/** Spec §5.3 / D9 — dokumentált alapérték. */
export const PARTIAL_TEXT_FLUSH_CHARS = 200

export type TurnSnapshotFlush = {
  /** Tartalom-őrön átesett részszöveg — csak ha a flush partial-t is tartalmaz. */
  partialText?: string
  /** Teljes aktivitás-lista (upsert után) — csak ha a flush activity-t tartalmaz. */
  activities?: ToolLoopActivityEvent[]
}

export type TurnSnapshotFlusherOptions = {
  /** Injektálható óra (tesztekhez). Alapértelmezés: `Date.now`. */
  now?: () => number
  intervalMs?: number
  charThreshold?: number
}

/** A részszöveg tartalom-őre — ugyanaz, mint a végleges outbound redakció. */
export function guardTurnPartialText(text: string): string {
  return redactSensitiveText(text).text
}

function upsertActivity(
  activities: ToolLoopActivityEvent[],
  event: ToolLoopActivityEvent,
): ToolLoopActivityEvent[] {
  const index = activities.findIndex((item) => item.id === event.id)
  if (index < 0) return [...activities, event]
  return activities.map((item, i) => (i === index ? { ...item, ...event } : item))
}

/**
 * Egy futó forduló in-memory snapshot-állapota: tokeneket és aktivitásokat
 * gyűjt, és eldönti, mikor kell a DB-be írni.
 */
export class TurnSnapshotFlusher {
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly charThreshold: number

  private rawText = ''
  private activities: ToolLoopActivityEvent[] = []
  private lastFlushAt: number
  private charsSinceFlush = 0

  constructor(options: TurnSnapshotFlusherOptions = {}) {
    this.now = options.now ?? Date.now
    this.intervalMs = options.intervalMs ?? PARTIAL_TEXT_FLUSH_INTERVAL_MS
    this.charThreshold = options.charThreshold ?? PARTIAL_TEXT_FLUSH_CHARS
    this.lastFlushAt = this.now()
  }

  /** Aktuális (őrizetlen) részszöveg — a hívó a streamhez a nyerset használja. */
  get partialText(): string {
    return this.rawText
  }

  get activityList(): ToolLoopActivityEvent[] {
    return this.activities
  }

  /**
   * Token hozzáadása. Küszöb felett `{ partialText }` flushot ad (őrizve);
   * egyébként `null`.
   */
  pushToken(chunk: string): TurnSnapshotFlush | null {
    if (!chunk) return null
    this.rawText += chunk
    this.charsSinceFlush += chunk.length
    if (!this.shouldFlushPartial()) return null
    return this.takePartialFlush()
  }

  /**
   * Aktivitás eseményenként. Mindig flushol — a teljes upsertelt listával.
   * Ha van még ki nem írt részszöveg ÉS a partial-küszöb is teljesül, a
   * partial is együtt megy (egy DB-írás).
   */
  pushActivity(event: ToolLoopActivityEvent): TurnSnapshotFlush {
    this.activities = upsertActivity(this.activities, event)
    const flush: TurnSnapshotFlush = { activities: this.activities }
    if (this.charsSinceFlush > 0 && this.shouldFlushPartial()) {
      flush.partialText = guardTurnPartialText(this.rawText)
      this.markPartialFlushed()
    }
    return flush
  }

  /**
   * Terminális / kényszerített kiírás: a teljes aktuális részszöveg (őrizve)
   * és az aktivitások. Akkor is visszaadja, ha üresek — a hívó dönti el,
   * mit ír a rekordra.
   */
  flushFinal(): TurnSnapshotFlush {
    this.markPartialFlushed()
    return {
      partialText: guardTurnPartialText(this.rawText),
      activities: this.activities,
    }
  }

  private shouldFlushPartial(): boolean {
    if (this.charsSinceFlush <= 0) return false
    if (this.charsSinceFlush >= this.charThreshold) return true
    return this.now() - this.lastFlushAt >= this.intervalMs
  }

  private takePartialFlush(): TurnSnapshotFlush {
    this.markPartialFlushed()
    return { partialText: guardTurnPartialText(this.rawText) }
  }

  private markPartialFlushed(): void {
    this.charsSinceFlush = 0
    this.lastFlushAt = this.now()
  }
}
