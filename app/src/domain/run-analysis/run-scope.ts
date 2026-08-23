/**
 * Közös szkóp- és audit-építők a három `run_*` toolnak (RA-03 … RA-06).
 *
 * Egy helyen él (a) a futás-szkóp → ToolCall/ModelCall szűrő leképezés,
 * (b) a folyamat → ticket feloldás, és (c) a napló-olvasás audit-sora. Így a
 * három service ugyanazt a szkóp-szemantikát és ugyanazt a — tartalom-mentes,
 * de az emberi kérőt is rögzítő — audit-alakot használja.
 */
import type { PrismaClient } from '@prisma/client'
import type { AuditRepository } from '@/repositories/interfaces'

/** Egy szkóp alatt feloldott folyamat-ticketek felső korlátja. */
export const MAX_PROCESS_TICKET_ROWS = 5_000

/** ToolCall és ModelCall `where`-be egyaránt beilleszthető szkóp-szűrő. */
type ScopedCallPart = { agentTurnId: { in: string[] } } | { ticketId: { in: string[] } }
export type RunScopeCallFilter = ScopedCallPart | { OR: ScopedCallPart[] }

/**
 * A kiválasztott futásokból ToolCall/ModelCall szűrő. `null`, ha a szkóp üres —
 * ilyenkor a hívó ne indítson lekérdezést (különben a szűrő nélküli `where`
 * a teljes tenant forgalmát hozná).
 */
export function buildScopedCallFilter(input: {
  turnIds: string[]
  ticketIds: string[]
}): RunScopeCallFilter | null {
  const parts: ScopedCallPart[] = []
  if (input.turnIds.length) parts.push({ agentTurnId: { in: input.turnIds } })
  if (input.ticketIds.length) parts.push({ ticketId: { in: input.ticketIds } })
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]!
  return { OR: parts }
}

export type ProcessTicketIndex = {
  /** processInstanceId → ticketId-k */
  byProcess: Map<string, string[]>
  /** ticketId → processInstanceId (a fordított irány, hogy ne kelljen listát végigjárni) */
  processByTicket: Map<string, string>
  /** True, ha a felső korlát miatt nem minden ticket került be. */
  truncated: boolean
}

/** Folyamat-futások ticketjeinek feloldása, felső korláttal (003-paginate-unbounded-lists). */
export async function loadProcessTicketIndex(
  prisma: PrismaClient,
  processIds: string[],
): Promise<ProcessTicketIndex> {
  const empty: ProcessTicketIndex = {
    byProcess: new Map(),
    processByTicket: new Map(),
    truncated: false,
  }
  if (!processIds.length) return empty

  const rows = await prisma.ticket.findMany({
    where: { processInstanceId: { in: processIds } },
    select: { id: true, processInstanceId: true },
    orderBy: { createdAt: 'asc' },
    take: MAX_PROCESS_TICKET_ROWS + 1,
  })
  const truncated = rows.length > MAX_PROCESS_TICKET_ROWS
  const kept = truncated ? rows.slice(0, MAX_PROCESS_TICKET_ROWS) : rows

  const byProcess = new Map<string, string[]>()
  const processByTicket = new Map<string, string>()
  for (const row of kept) {
    if (!row.processInstanceId) continue
    const list = byProcess.get(row.processInstanceId) ?? []
    list.push(row.id)
    byProcess.set(row.processInstanceId, list)
    processByTicket.set(row.id, row.processInstanceId)
  }
  return { byProcess, processByTicket, truncated }
}

/** A napló-olvasás kérőjének azonosítói — mindhárom service ugyanezt kapja. */
export type RunAnalysisRequester = {
  tenantId: string
  requesterAgentId: string
  requesterAgentVersion: number
  /** Az elemzőt megszólító ember (US15). Rendszer-indított futásnál `null`. */
  actingUserId: string | null
}

export type RunAnalysisAuditAction =
  | 'analysis.run_index'
  | 'analysis.run_trace'
  | 'analysis.run_stats'

/**
 * Napló-olvasás audit-sora: szkóp + visszaadott sorszám, TARTALOM NÉLKÜL.
 * A `requestedByUserId` metaadat teszi visszakövethetővé, KI kérte az elemzést —
 * az `actorId` maga az elemző agent (US15).
 */
export async function appendRunAnalysisAudit(
  audit: AuditRepository,
  requester: RunAnalysisRequester,
  entry: {
    action: RunAnalysisAuditAction
    inputRef: string | null
    outputRef: string
    metadata: Record<string, unknown>
  },
): Promise<void> {
  await audit.append({
    actorType: 'agent',
    actorId: requester.requesterAgentId,
    agentVersion: requester.requesterAgentVersion,
    action: entry.action,
    targetType: 'tenant',
    targetId: requester.tenantId,
    tenantId: requester.tenantId,
    modelUsed: null,
    inputRef: entry.inputRef,
    outputRef: entry.outputRef,
    policyDecision: 'allowed',
    metadata: {
      ...entry.metadata,
      requestedByUserId: requester.actingUserId,
    },
  })
}
