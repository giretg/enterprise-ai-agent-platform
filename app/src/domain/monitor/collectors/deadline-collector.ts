import type { MonitorRepository } from '@/repositories/interfaces'
import type { CollectorContext, MonitorCollector, MonitorSignalDraft } from './types'

const DEFAULT_WINDOW_HOURS = 24
const MAX_SIGNALS = 100

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Határidő-collector (Feature-spec — Proactive Monitor §5.2, `deadline` kind).
 *
 * Belső, read-only collector: a board azon ticketeit gyűjti, amelyek `due_by`-ja a
 * konfigurált ablakon belül esedékes és még nincs lezárva (done/rejected). Nulla
 * LLM-token. A `severity` a hátralévő időből származik (közelebbi határidő → magasabb).
 *
 * Tenant-izolált: csak a monitor tenantjához tartozó ticketeket olvassa.
 */
export class DeadlineCollector implements MonitorCollector {
  readonly kind = 'deadline' as const

  constructor(private monitors: MonitorRepository) {}

  async collect(ctx: CollectorContext): Promise<MonitorSignalDraft[]> {
    const windowHours = num(ctx.config.windowHours, DEFAULT_WINDOW_HOURS)
    const withinSeconds = Math.max(0, windowHours) * 3600
    const rows = await this.monitors.collectUpcomingTicketDeadlines(
      ctx.tenantId,
      ctx.now,
      withinSeconds,
      MAX_SIGNALS,
    )

    return rows.map((row) => {
      const hoursUntilDue = (row.dueBy.getTime() - ctx.now.getTime()) / 3_600_000
      // Lineáris súlyosság: az ablak kezdetén ~0, a határidőnél (vagy múltban) 100.
      const ratio = windowHours > 0 ? 1 - hoursUntilDue / windowHours : 1
      const severity = Math.max(0, Math.min(100, Math.round(ratio * 100)))
      return {
        dedupKeyParts: { ticketId: row.ticketId },
        severity,
        title: `Közelgő határidő: ${row.title} (${row.dueBy.toISOString()})`,
        dueBy: row.dueBy,
        payload: {
          ticketId: row.ticketId,
          tenantId: row.tenantId,
          ticketTitle: row.title,
          state: row.state,
          dueBy: row.dueBy.toISOString(),
          hoursUntilDue: Math.round(hoursUntilDue * 10) / 10,
        },
      }
    })
  }
}
