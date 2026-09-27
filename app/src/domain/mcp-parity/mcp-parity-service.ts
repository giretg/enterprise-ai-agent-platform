/**
 * MCP-paritás riport service (#666): audit-sorokból munkamenet-metrikák és
 * agent×kliens összesítés. A tiszta számítás az `src/lib/mcp-parity.ts`-ben
 * van — ez a réteg csak beolvas és formáz.
 */
import {
  aggregateParityReport,
  buildParityTrend,
  computeSessionMetrics,
  groupMcpSessions,
  type McpParityEvent,
  type McpParityReport,
  type McpParityTrendPoint,
  type McpSessionMetrics,
} from '@/lib/mcp-parity'
import type { AuditRepository } from '@/repositories/interfaces'

const PARITY_ACTIONS = [
  'mcp.tools.call',
  'mcp.tools.call.deny',
  'mcp.resources.read',
  'mcp.prompts.get',
  'enterprise.tool.ok',
  'enterprise.tool.denied',
  'enterprise.tool.error',
  'project.work_file.write',
  'project.project_memory.write',
]

function toEvent(row: {
  action: string
  inputRef?: string | null
  outputRef?: string | null
  policyDecision?: string | null
  metadata?: unknown
  createdAt?: Date | string | null
  actorId?: string | null
}): McpParityEvent {
  return {
    action: row.action,
    inputRef: row.inputRef ?? null,
    outputRef: row.outputRef ?? null,
    policyDecision: row.policyDecision ?? null,
    metadata:
      row.metadata && typeof row.metadata === 'object'
        ? (row.metadata as Record<string, unknown>)
        : null,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : ((row.createdAt as string | null | undefined) ?? null),
    actorId: row.actorId ?? null,
  }
}

function dayOf(e: McpParityEvent): string {
  if (!e.createdAt) return 'ismeretlen'
  const d = e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt)
  return Number.isNaN(d.getTime()) ? 'ismeretlen' : d.toISOString().slice(0, 10)
}

export async function getMcpParityReport(
  audit: Pick<AuditRepository, 'findMany'>,
  input: { tenantId: string; since?: Date; limit?: number },
): Promise<McpParityReport & { sessionsDetail: McpSessionMetrics[] }> {
  const rows = await audit.findMany({
    tenantId: input.tenantId,
    since: input.since,
    order: 'asc',
    limit: input.limit ?? 5000,
  })
  const parityRows = rows.filter((r) => PARITY_ACTIONS.includes(r.action))
  const events = parityRows.map(toEvent)
  const groups = groupMcpSessions(events)
  const detail = groups.map((list, i) =>
    computeSessionMetrics(`session-${i + 1}`, list),
  )
  // A valódi sessionId az első sor metadata-jából jön (csoportosítás kulcsa).
  const withRealIds = groups.map((list, i) => {
    const meta = list[0]?.metadata
    const sid = meta && typeof meta.sessionId === 'string' ? meta.sessionId : `session-${i + 1}`
    return { ...detail[i], sessionId: sid }
  })
  const agg = aggregateParityReport(withRealIds)
  const byDay = new Map<string, McpSessionMetrics[]>()
  groups.forEach((list, i) => {
    const day = dayOf(list[0] ?? { action: '' })
    const cur = byDay.get(day) ?? []
    cur.push(withRealIds[i])
    byDay.set(day, cur)
  })
  const trend: McpParityTrendPoint[] = buildParityTrend(
    [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, sessions]) => ({ day, sessions })),
  )
  return { ...agg, trend, sessionsDetail: withRealIds }
}
