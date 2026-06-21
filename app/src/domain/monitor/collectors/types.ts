import type { MonitorKind } from '@prisma/client'

/**
 * Egy collector által kibocsátott nyers jel (Feature-spec — Proactive Monitor §5.1).
 * A collectorok determinisztikusak és nem-LLM-ek; a `severity` (0..100) a szűrő-küszöb
 * összevetéséhez, a `dedupKeyParts` a cooldown-kulcs sablon kitöltéséhez kell.
 */
export type MonitorSignalDraft = {
  /** A `dedupKeyTemplate` ({rész}) kitöltéséhez — pl. { ticketId: '...' }. */
  dedupKeyParts: Record<string, string>
  /** 0..100 — minél fontosabb, annál magasabb. A szűrő ezt veti össze a küszöbbel. */
  severity: number
  /** Ember-olvasható cím; a nyitott ticket címének alapja. */
  title: string
  /** Ha a jel egy határidőhöz kötött, a ticket `due_by`-ja ebből öröklődik. */
  dueBy?: Date | null
  /** A jel pillanatképe — a ticket payloadba és az auditba kerül (provenance). */
  payload: Record<string, unknown>
}

export type CollectorContext = {
  tenantId: string
  config: Record<string, unknown>
  now: Date
}

/**
 * Determinisztikus, nem-LLM signal collector. Minden külső-forrás collector a Tool
 * Brokeren át hív (§4.11.7 kötelező kontroll); a belső board/DB collectorok read-only
 * repository-lekérdezést használnak, mert nem hagyják el a control plane határát.
 */
export interface MonitorCollector {
  readonly kind: MonitorKind
  collect(ctx: CollectorContext): Promise<MonitorSignalDraft[]>
}
