/**
 * MCP-agent paritás telemetria (#666): munkamenet-szintű összesítés az audit
 * naplóból. Tiszta (DB-mentes) függvények — élő DB csak a service-rétegben.
 *
 * Egy munkamenet akkor "jól" használja az agentet, ha:
 *  - az első keresés ELŐTT betöltötte a definíciót és a memóriát,
 *  - elolvasta a belépő skillt,
 *  - a végén írt naplót / memóriát,
 *  - kevés a hibája (agent_stale, endpoint_not_allowed, tool_not_allowed).
 */

export type McpParityEvent = {
  action: string
  inputRef?: string | null
  outputRef?: string | null
  policyDecision?: string | null
  metadata?: Record<string, unknown> | null
  createdAt?: string | Date | null
  actorId?: string | null
}

export type McpSessionMetrics = {
  sessionId: string
  agentId: string
  clientName: string
  eventCount: number
  hasSearch: boolean
  definitionBeforeSearch: boolean
  memoryBeforeSearch: boolean
  entrySkillRead: boolean
  logWritten: boolean
  memoryWritten: boolean
  agentStale: number
  endpointNotAllowed: number
  toolNotAllowed: number
}

export type McpParityCell = {
  agentId: string
  clientName: string
  sessions: number
  pctDefinition: number | null
  pctMemory: number | null
  pctSkill: number | null
  pctLogOrMemory: number | null
  errorsPerSession: number
}

export type McpParityTrendPoint = {
  day: string
  sessions: number
  pctGood: number | null
}

export type McpParityReport = {
  sessions: number
  cells: McpParityCell[]
  trend: McpParityTrendPoint[]
  limited?: boolean
  unattributedEvents?: number
}

const DEFINITION_TOOLS = new Set([
  'platform.agent.get_definition',
  'platform.agent.checkout',
  'platform.agent.get_working_set',
])

const MEMORY_READ_TOOLS = new Set([
  'platform.project_memory.read',
])

const SEARCH_TOOLS = new Set([
  'kb_search',
  'kb_list_index',
  'kb_get_page',
  'kb_get_document',
  'google_drive_search',
])

const LOG_WRITE_TOOLS = new Set([
  'platform.work_file.write',
  'platform.work_file.append',
  'platform.skills.submit',
])

const MEMORY_WRITE_TOOLS = new Set([
  'platform.project_memory.write',
  'platform.agent.create_draft',
  'platform.agent.publish',
])

function toolOf(e: McpParityEvent): string {
  const m = e.metadata ?? {}
  const t = typeof m.toolName === 'string' ? m.toolName : ''
  return t || e.inputRef || ''
}

function codeOf(e: McpParityEvent): string {
  const m = e.metadata ?? {}
  return typeof m.code === 'string' ? m.code : ''
}

function isSearchTool(tool: string): boolean {
  return SEARCH_TOOLS.has(tool)
}

function isSkillRead(e: McpParityEvent): boolean {
  return e.action === 'mcp.resources.read' &&
    /^skill:\/\/[^/]+\/SKILL\.md$/.test(e.inputRef ?? '')
}

function isLogWrite(e: McpParityEvent): boolean {
  return e.action === 'enterprise.tool.ok' && LOG_WRITE_TOOLS.has(toolOf(e))
}

function isMemoryWrite(e: McpParityEvent): boolean {
  return e.action === 'enterprise.tool.ok' && MEMORY_WRITE_TOOLS.has(toolOf(e))
}

export function sessionKeyOf(e: McpParityEvent): string {
  const m = e.metadata ?? {}
  const s = typeof m.sessionId === 'string' && m.sessionId ? m.sessionId : ''
  return s ? `${e.actorId ?? 'unknown'}\t${s}` : 'unknown'
}

export function agentOf(e: McpParityEvent): string {
  const m = e.metadata ?? {}
  for (const k of ['agentId', 'headerAgentId', 'promptAgentId']) {
    const v = m[k]
    if (typeof v === 'string' && v) return v.slice(0, 64)
  }
  return typeof e.outputRef === 'string' && e.outputRef ? e.outputRef.slice(0, 64) : 'unknown'
}

export function clientOf(e: McpParityEvent): string {
  const m = e.metadata ?? {}
  return typeof m.clientName === 'string' && m.clientName ? m.clientName : 'unknown'
}

/** Események csoportosítása munkamenetenként, időrendben. */
export function groupMcpSessions(events: McpParityEvent[]): McpParityEvent[][] {
  const by = new Map<string, McpParityEvent[]>()
  for (const e of events) {
    const k = sessionKeyOf(e)
    const list = by.get(k) ?? []
    list.push(e)
    by.set(k, list)
  }
  const time = (e: McpParityEvent) => {
    if (!e.createdAt) return 0
    const t = e.createdAt instanceof Date ? e.createdAt.getTime() : Date.parse(e.createdAt)
    return Number.isNaN(t) ? 0 : t
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, list]) => list.sort((x, y) => time(x) - time(y)))
}

/** Egy munkamenet mérőszámai az időrendezett nyomból. */
export function computeSessionMetrics(sessionId: string, events: McpParityEvent[]): McpSessionMetrics {
  let firstSearchIdx = -1
  let definitionIdx = -1
  let memoryIdx = -1
  let skill = false
  let log = false
  let memWrite = false
  let stale = 0
  let endpoint = 0
  let tool = 0
  const agents = new Map<string, number>()
  const clients = new Map<string, number>()

  events.forEach((e, i) => {
    const t = toolOf(e)
    if (firstSearchIdx < 0 && isSearchTool(t)) firstSearchIdx = i
    if (definitionIdx < 0 && (DEFINITION_TOOLS.has(t) || e.action === 'mcp.prompts.get')) {
      definitionIdx = i
    }
    if (memoryIdx < 0 && e.action === 'enterprise.tool.ok' && MEMORY_READ_TOOLS.has(t)) memoryIdx = i
    if (!skill && isSkillRead(e)) skill = true
    if (!log && isLogWrite(e)) log = true
    if (!memWrite && isMemoryWrite(e)) memWrite = true
    const code = codeOf(e)
    if (code === 'agent_stale') stale++
    if (code === 'endpoint_not_allowed') endpoint++
    if (code === 'tool_not_allowed') tool++
    if (e.policyDecision === 'denied' && !code && e.action === 'mcp.tools.call.deny') tool++
    agents.set(agentOf(e), (agents.get(agentOf(e)) ?? 0) + 1)
    clients.set(clientOf(e), (clients.get(clientOf(e)) ?? 0) + 1)
  })

  const top = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown'
  const hasSearch = firstSearchIdx >= 0
  return {
    sessionId,
    agentId: top(agents),
    clientName: top(clients),
    eventCount: events.length,
    hasSearch,
    // Keresés nélküli munkamenetben nincs mit megelőzni → nem számít jónak.
    definitionBeforeSearch: hasSearch && definitionIdx >= 0 && definitionIdx < firstSearchIdx,
    memoryBeforeSearch: hasSearch && memoryIdx >= 0 && memoryIdx < firstSearchIdx,
    entrySkillRead: skill,
    logWritten: log,
    memoryWritten: memWrite,
    agentStale: stale,
    endpointNotAllowed: endpoint,
    toolNotAllowed: tool,
  }
}

function pct(ok: number, all: number): number | null {
  if (all <= 0) return null
  return Math.round((ok / all) * 100)
}

/** Munkamenet-metrikák összesítése agent×kliens cellákra + napi trendre. */
export function aggregateParityReport(sessions: McpSessionMetrics[]): McpParityReport {
  const cells = new Map<string, McpSessionMetrics[]>()
  for (const s of sessions) {
    const k = `${s.agentId}	${s.clientName}`
    const list = cells.get(k) ?? []
    list.push(s)
    cells.set(k, list)
  }
  const out: McpParityCell[] = [...cells.entries()]
    .map(([k, list]) => {
      const [agentId, clientName] = k.split('	')
      const withSearch = list.filter((s) => s.hasSearch)
      return {
        agentId,
        clientName,
        sessions: list.length,
        pctDefinition: pct(
          withSearch.filter((s) => s.definitionBeforeSearch).length,
          withSearch.length,
        ),
        pctMemory: pct(withSearch.filter((s) => s.memoryBeforeSearch).length, withSearch.length),
        pctSkill: pct(list.filter((s) => s.entrySkillRead).length, list.length),
        pctLogOrMemory: pct(
          list.filter((s) => s.logWritten || s.memoryWritten).length,
          list.length,
        ),
        errorsPerSession:
          Math.round(
            ((list.reduce((a, s) => a + s.agentStale + s.endpointNotAllowed + s.toolNotAllowed, 0) /
              list.length) || 0) * 10,
          ) / 10,
      }
    })
    .sort((a, b) => b.sessions - a.sessions)

  return { sessions: sessions.length, cells: out, trend: [] }
}

/** Napi trend külön lépésben (a createdAt az eseményeken van, nem a metrikán). */
export function buildParityTrend(
  groups: { day: string; sessions: McpSessionMetrics[] }[],
): McpParityTrendPoint[] {
  return groups.map(({ day, sessions }) => ({
    day,
    sessions: sessions.length,
    pctGood: pct(
      sessions.filter((s) => s.entrySkillRead && (s.logWritten || s.memoryWritten)).length,
      sessions.length,
    ),
  }))
}
