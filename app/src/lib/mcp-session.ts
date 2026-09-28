/**
 * MCP-munkamenet azonosítás (#666).
 *
 * Az MCP Streamable HTTP hordozó állapotmentes: minden tool-hívás külön HTTP
 * kérés. A munkamenet-szintű összesítéshez (definíció-betöltés, skill-olvasás,
 * napló/memória-írás, hibák) a kliens küld egy `mcp-session-id` fejlécet —
 * ha hiányzik, a kérés nem csoportosítható, és a telemetria `unknown`
 * munkamenetbe teszi (nem dobjuk el, de nem is találgatunk).
 *
 * DB-migráció nincs: a sessionId az audit-sor `metadata`-jába kerül.
 */

export const MCP_SESSION_ID_HEADER = 'mcp-session-id'

export type McpClientName =
  | 'claude'
  | 'cursor'
  | 'codex'
  | 'goose'
  | 'hermes'
  | 'other'
  | 'unknown'

export type McpRequestContext = {
  /** Normalizált sessionId, vagy null ha a kliens nem küldött érvényeset. */
  sessionId: string | null
  clientName: McpClientName
  /** A per-client agent-kötő fejléc nyers értéke (legfeljebb 64 kar.). */
  headerAgentId: string | null
}

const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/

/** Fejléc-érték normalizálása: érvénytelen → null (nincs találgatás). */
export function parseMcpSessionId(value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  if (!v || !SESSION_RE.test(v)) return null
  return v
}

/** Kliens nevének felismerése user-agent + MCP fejlécek alapján. */
export function detectMcpClient(
  userAgent: string | null | undefined,
  extra?: { headers?: Record<string, string | null | undefined> },
): McpClientName {
  const ua = (userAgent ?? '').toLowerCase()
  const extras = Object.values(extra?.headers ?? {})
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.toLowerCase())
    .join(' ')
  const hay = `${ua} ${extras}`
  if (!hay.trim()) return 'unknown'
  if (hay.includes('claude')) return 'claude'
  if (hay.includes('cursor')) return 'cursor'
  if (hay.includes('codex') || hay.includes('openai')) return 'codex'
  if (hay.includes('goose')) return 'goose'
  if (hay.includes('hermes') || hay.includes('excellence')) return 'hermes'
  return 'other'
}

export function getMcpRequestContext(headers: {
  get: (name: string) => string | null
}): McpRequestContext {
  return {
    sessionId: parseMcpSessionId(headers.get(MCP_SESSION_ID_HEADER)),
    clientName: detectMcpClient(headers.get('user-agent')),
    headerAgentId: (headers.get('x-excellence-agent-id') ?? '').trim().slice(0, 64) || null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export type AuditSinkLike = {
  append: (data: {
    actorType: 'human' | 'agent' | 'system'
    actorId?: string | null
    agentVersion?: number | null
    action: string
    targetType: string
    targetId?: string | null
    modelUsed?: string | null
    inputRef?: string | null
    outputRef?: string | null
    policyDecision?: string | null
    metadata?: unknown
    tenantId?: string | null
  }) => Promise<unknown>
}

/**
 * Per-request audit-hatókör: minden ezen a sinken átmenő sor metadata-jába
 * bepecsételi a sessionId-t, a klienst és a header-agentet — ha az adott sor
 * még nem hordozza. Így a 15+ MCP audit-hívást NEM kell egyesével átírni,
 * és az enterprise/project írók sorai is korrelálhatók maradnak.
 */
export function scopeMcpAuditSink<T extends AuditSinkLike | undefined>(
  sink: T,
  ctx: McpRequestContext,
): T {
  if (!sink) return sink
  const scoped = {
    append: (data: Parameters<NonNullable<T>['append']>[0]) => {
      const meta = isRecord(data.metadata) ? { ...data.metadata } : {}
      if (ctx.sessionId && meta.sessionId === undefined) meta.sessionId = ctx.sessionId
      if (meta.clientName === undefined) meta.clientName = ctx.clientName
      if (ctx.headerAgentId && meta.headerAgentId === undefined) {
        meta.headerAgentId = ctx.headerAgentId
      }
      return (sink as AuditSinkLike).append({ ...data, metadata: meta })
    },
  }
  return scoped as T
}
