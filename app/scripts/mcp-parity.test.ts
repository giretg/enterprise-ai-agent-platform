/**
 * MCP-paritás telemetria egységteszt (#666) — DB nélkül, minden PR-en.
 * Futtatás: npm run test:mcp-parity
 *
 * Amit őrzünk (#35 "ki őrzi az őrzőket" szabálya szerint):
 * - minden metrika tud BUKNI is (negatív + pozitív fixture párban),
 * - a sorrend számít (definíció/memória az ELSŐ keresés előtt),
 * - a hibakódok (agent_stale, endpoint_not_allowed, tool_not_allowed) számolva vannak,
 * - az érvénytelen sessionId nem találgat, az ismeretlen kliens nem mászik át másikba.
 */
import assert from 'node:assert/strict'
import {
  detectMcpClient,
  getMcpRequestContext,
  parseMcpSessionId,
  scopeMcpAuditSink,
} from '../src/lib/mcp-session'
import {
  aggregateParityReport,
  buildParityTrend,
  computeSessionMetrics,
  groupMcpSessions,
  type McpParityEvent,
} from '../src/lib/mcp-parity'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✅ ${name}`))
    .catch((e) => {
      failures++
      console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

function ev(
  action: string,
  toolName: string | null,
  meta: Record<string, unknown> = {},
  extra: Partial<McpParityEvent> = {},
): McpParityEvent {
  return {
    action,
    inputRef: toolName,
    policyDecision: action.endsWith('.deny') || action.endsWith('.denied') ? 'denied' : 'allowed',
    metadata: { ...(toolName ? { toolName } : {}), ...meta },
    ...extra,
  }
}

const DEF = 'platform.agent.get_definition'
const MEM = 'platform.project_memory.read'
const SKILL = 'platform.skills.read'
const SEARCH = 'kb_search'
const WRITE = 'platform.work_file.write'

function goodSession(id = 's-good'): McpParityEvent[] {
  return [
    ev('mcp.tools.call', DEF, { sessionId: id, agentId: 'kati', clientName: 'claude' }),
    ev('mcp.tools.call', MEM, { sessionId: id, agentId: 'kati', clientName: 'claude' }),
    ev('mcp.tools.call', SKILL, { sessionId: id, agentId: 'kati', clientName: 'claude' }),
    ev('mcp.tools.call', SEARCH, { sessionId: id, agentId: 'kati', clientName: 'claude' }),
    ev('mcp.tools.call', WRITE, { sessionId: id, agentId: 'kati', clientName: 'claude' }),
  ]
}

async function main() {
  console.log('=== mcp-parity: telemetria egységteszt ===')

  await check('jó sorrend mindent zöldre hoz', () => {
    const m = computeSessionMetrics('s-good', goodSession())
    assert.equal(m.definitionBeforeSearch, true)
    assert.equal(m.memoryBeforeSearch, true)
    assert.equal(m.entrySkillRead, true)
    assert.equal(m.logWritten, true)
    assert.equal(m.agentId, 'kati')
    assert.equal(m.clientName, 'claude')
  })

  await check('NEGATÍV: keresés definíció előtt → definitionBeforeSearch hamis', () => {
    const m = computeSessionMetrics('s', [
      ev('mcp.tools.call', SEARCH, { sessionId: 's' }),
      ev('mcp.tools.call', DEF, { sessionId: 's' }),
    ])
    assert.equal(m.hasSearch, true)
    assert.equal(m.definitionBeforeSearch, false)
  })

  await check('NEGATÍV: memória csak a keresés UTÁN → memoryBeforeSearch hamis', () => {
    const m = computeSessionMetrics('s', [
      ev('mcp.tools.call', DEF, { sessionId: 's' }),
      ev('mcp.tools.call', SEARCH, { sessionId: 's' }),
      ev('mcp.tools.call', MEM, { sessionId: 's' }),
    ])
    assert.equal(m.definitionBeforeSearch, true)
    assert.equal(m.memoryBeforeSearch, false)
  })

  await check('NEGATÍV: skill olvasása nélkül → entrySkillRead hamis', () => {
    const m = computeSessionMetrics('s', [
      ev('mcp.tools.call', DEF, { sessionId: 's' }),
      ev('mcp.tools.call', SEARCH, { sessionId: 's' }),
    ])
    assert.equal(m.entrySkillRead, false)
  })

  await check('NEGATÍV: írás nélkül → logWritten és memoryWritten hamis', () => {
    const m = computeSessionMetrics('s', goodSession().slice(0, 4))
    assert.equal(m.logWritten, false)
    assert.equal(m.memoryWritten, false)
  })

  await check('keresés nélküli munkamenet nem számít "időben betöltöttnek"', () => {
    const m = computeSessionMetrics('s', [ev('mcp.tools.call', DEF, { sessionId: 's' })])
    assert.equal(m.hasSearch, false)
    assert.equal(m.definitionBeforeSearch, false)
  })

  await check('hibakódok számolva: agent_stale / endpoint_not_allowed / tool_not_allowed', () => {
    const m = computeSessionMetrics('s', [
      ev('enterprise.tool.denied', 'gmail_send', { sessionId: 's', code: 'agent_stale' }),
      ev('enterprise.tool.denied', 'http_api_request', {
        sessionId: 's',
        code: 'endpoint_not_allowed',
      }),
      ev('mcp.tools.call.deny', 'platform.agent.publish', {
        sessionId: 's',
        code: 'tool_not_allowed',
      }),
    ])
    assert.equal(m.agentStale, 1)
    assert.equal(m.endpointNotAllowed, 1)
    assert.equal(m.toolNotAllowed, 1)
  })

  await check('kód nélküli mcp deny is tool_not_allowed-nak számít', () => {
    const m = computeSessionMetrics('s', [
      { action: 'mcp.tools.call.deny', inputRef: 'x', policyDecision: 'denied', metadata: {} },
    ])
    assert.equal(m.toolNotAllowed, 1)
  })

  await check('csoportosítás sessionId szerint, időrendben', () => {
    const groups = groupMcpSessions([
      ev('mcp.tools.call', DEF, { sessionId: 'b' }, { createdAt: '2026-09-02T00:00:00Z' }),
      ev('mcp.tools.call', DEF, { sessionId: 'a' }, { createdAt: '2026-09-01T00:00:00Z' }),
      ev('mcp.tools.call', SEARCH, { sessionId: 'a' }, { createdAt: '2026-09-03T00:00:00Z' }),
    ])
    assert.equal(groups.length, 2)
    assert.equal(groups[0].length, 2)
    assert.equal(groups[0][0].createdAt, '2026-09-01T00:00:00Z')
  })

  await check('sessionId nélküli sorok unknown-be kerülnek, nem vesznek el', () => {
    const groups = groupMcpSessions([ev('mcp.tools.call', DEF, {})])
    assert.equal(groups.length, 1)
    const m = computeSessionMetrics('unknown', groups[0])
    assert.equal(m.sessionId, 'unknown')
  })

  await check('aggregáció: százalékok + hiba/munkamenet agent×kliens cellánként', () => {
    const report = aggregateParityReport([
      computeSessionMetrics('s1', goodSession('s1')),
      computeSessionMetrics('s2', [
        ev('mcp.tools.call', SEARCH, { sessionId: 's2', agentId: 'kati', clientName: 'claude' }),
      ]),
    ])
    assert.equal(report.sessions, 2)
    assert.equal(report.cells.length, 1)
    const cell = report.cells[0]
    assert.equal(cell.pctDefinition, 50)
    assert.equal(cell.pctSkill, 50)
    assert.equal(cell.pctLogOrMemory, 50)
    assert.equal(cell.errorsPerSession, 0)
  })

  await check('üres kereséses nevező → null, nem 0% (nincs félrevezető zöld/piros)', () => {
    const report = aggregateParityReport([
      computeSessionMetrics('s', [ev('mcp.tools.call', DEF, { sessionId: 's' })]),
    ])
    assert.equal(report.cells[0].pctDefinition, null)
  })

  await check('trend: jó munkamenet = skill + (napló vagy memória)', () => {
    const trend = buildParityTrend([
      {
        day: '2026-09-01',
        sessions: [
          computeSessionMetrics('s1', goodSession('s1')),
          computeSessionMetrics('s2', [ev('mcp.tools.call', DEF, { sessionId: 's2' })]),
        ],
      },
    ])
    assert.equal(trend[0].pctGood, 50)
  })

  await check('sessionId: érvénytelen fejléc → null', () => {
    assert.equal(parseMcpSessionId(null), null)
    assert.equal(parseMcpSessionId(''), null)
    assert.equal(parseMcpSessionId('a b'), null)
    assert.equal(parseMcpSessionId('x'.repeat(65)), null)
    assert.equal(parseMcpSessionId('sess-123_ABC'), 'sess-123_ABC')
  })

  await check('kliens-felismerés: claude / cursor / codex / ismeretlen', () => {
    assert.equal(detectMcpClient('Claude-Desktop/1.0'), 'claude')
    assert.equal(detectMcpClient('Cursor/0.5'), 'cursor')
    assert.equal(detectMcpClient('codex-cli/2'), 'codex')
    assert.equal(detectMcpClient('curl/8.0'), 'other')
    assert.equal(detectMcpClient(null), 'unknown')
  })

  await check('getMcpRequestContext fejlécekből dolgozik', () => {
    const ctx = getMcpRequestContext({
      get: (n: string) =>
        n === 'mcp-session-id'
          ? 'sess-1001'
          : n === 'user-agent'
            ? 'Cursor/0.5'
            : n === 'x-excellence-agent-id'
              ? 'agent-9'
              : null,
    })
    assert.equal(ctx.sessionId, 'sess-1001')
    assert.equal(ctx.clientName, 'cursor')
    assert.equal(ctx.headerAgentId, 'agent-9')
  })

  await check('szótár = valódi MCP tool-nevek (get_definition + memory.read + skills.read + kb_search)', () => {
    const m = computeSessionMetrics('s', [
      ev('mcp.tools.call', 'platform.agent.get_definition', { sessionId: 's' }),
      ev('mcp.tools.call', 'platform.project_memory.read', { sessionId: 's' }),
      ev('mcp.tools.call', 'platform.skills.read', { sessionId: 's' }),
      ev('mcp.tools.call', 'kb_list_index', { sessionId: 's' }),
      ev('mcp.tools.call', 'platform.work_file.write', { sessionId: 's' }),
    ])
    assert.equal(m.definitionBeforeSearch, true)
    assert.equal(m.memoryBeforeSearch, true)
    assert.equal(m.entrySkillRead, true)
    assert.equal(m.hasSearch, true)
  })

  await check('NEGATÍV: kb_ingest nem keresés (írás, ne húzza előre a sapkát)', () => {
    const m = computeSessionMetrics('s', [
      ev('mcp.tools.call', 'kb_ingest', { sessionId: 's' }),
      ev('mcp.tools.call', DEF, { sessionId: 's' }),
    ])
    assert.equal(m.hasSearch, false)
  })

  await check('NEGATÍV: skills.list nem belépő-skill olvasás', () => {
    const m = computeSessionMetrics('s', [
      ev('mcp.tools.call', DEF, { sessionId: 's' }),
      ev('mcp.tools.call', 'platform.skills.list', { sessionId: 's' }),
      ev('mcp.tools.call', SEARCH, { sessionId: 's' }),
    ])
    assert.equal(m.entrySkillRead, false)
  })

  await check('scoped sink: session+kliens minden sorba, meglévőt nem ír felül', async () => {
    const written: { metadata?: unknown }[] = []
    const scoped = scopeMcpAuditSink(
      { append: async (d: { metadata?: unknown }) => void written.push(d) },
      { sessionId: 'sess-9', clientName: 'codex', headerAgentId: 'a1' },
    )
    await scoped!.append({
      actorType: 'human',
      action: 'mcp.tools.call',
      targetType: 'mcp',
      metadata: { toolName: 'x' },
    })
    await scoped!.append({
      actorType: 'human',
      action: 'mcp.tools.call',
      targetType: 'mcp',
      metadata: { toolName: 'y', sessionId: 'más', clientName: 'claude' },
    })
    const first = written[0].metadata as Record<string, unknown>
    const second = written[1].metadata as Record<string, unknown>
    assert.equal(first.sessionId, 'sess-9')
    assert.equal(first.clientName, 'codex')
    assert.equal(first.headerAgentId, 'a1')
    assert.equal(second.sessionId, 'más')
    assert.equal(second.clientName, 'claude')
  })

  console.log(failures === 0 ? '\nMinden teszt zöld.' : `\n${failures} teszt bukott.`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
