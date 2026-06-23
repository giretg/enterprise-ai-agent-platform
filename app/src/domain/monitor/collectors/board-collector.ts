import type { MonitorRepository } from '@/repositories/interfaces'
import type { CollectorContext, MonitorCollector, MonitorSignalDraft } from './types'

const DEFAULT_STALE_HOURS = 4
const MAX_SIGNALS = 100

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Board-backlog collector (Feature-spec — Proactive Monitor §5.2, `board_backlog` kind).
 *
 * Azokat a ticketeket gyűjti, amelyek `awaiting_human` vagy `ready` állapotban vannak
 * és `updatedAt`-juk több mint `staleHours` órával régebbi — azaz elakadtak. Nulla
 * LLM-token. A `severity` az életkorból számított (régebbi → magasabb).
 */
export class BoardBacklogCollector implements MonitorCollector {
  readonly kind = 'board_backlog' as const

  constructor(private monitors: MonitorRepository) {}

  async collect(ctx: CollectorContext): Promise<MonitorSignalDraft[]> {
    const staleHours = num(ctx.config.staleHours, DEFAULT_STALE_HOURS)
    const staleAfterMs = Math.max(0, staleHours) * 3_600_000
    const cutoff = new Date(ctx.now.getTime() - staleAfterMs)

    const rows = await this.monitors.collectStaleBacklogTickets(cutoff, MAX_SIGNALS)

    return rows.map((row) => {
      const ageHours = (ctx.now.getTime() - row.updatedAt.getTime()) / 3_600_000
      // Severity: staleHours-nál ~0, 3× staleHours-nál 100.
      const ratio = staleHours > 0 ? Math.min(1, (ageHours - staleHours) / (staleHours * 2)) : 1
      const severity = Math.max(0, Math.min(100, Math.round(ratio * 100)))
      return {
        dedupKeyParts: { ticketId: row.ticketId },
        severity,
        title: `Elakadt ticket (${row.state}): ${row.title} (${Math.round(ageHours)}ó)`,
        dueBy: row.dueBy,
        payload: {
          ticketId: row.ticketId,
          ticketTitle: row.title,
          state: row.state,
          updatedAt: row.updatedAt.toISOString(),
          ageHours: Math.round(ageHours * 10) / 10,
          dueBy: row.dueBy?.toISOString() ?? null,
        },
      }
    })
  }
}
