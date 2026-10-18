/**
 * MCP-paritás eval-készlet (#666) — DB nélkül, a valódi service ellen.
 * Futtatás: npm run test:mcp-parity-eval
 *
 * 9 Kati-forgatókönyv (szintetikus tool-nyom): a riport-láncot
 * (audit → session-metrika → admin-aggregáció) vizsgálja. Nem LLM-eval:
 * azt méri, hogy a nyom jól pontozódik — briefing-regressziót a #35
 * prompt-eval adja, ha egyszer van élő MCP-hívó.
 */
import assert from 'node:assert/strict'
import { getMcpParityReport } from '../src/domain/mcp-parity/mcp-parity-service'
import type { AuditListFilter, AuditRepository } from '../src/repositories/interfaces'

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

const KATI = 'kati'
const GABOR = 'gabor'
const TENANT = 'tenant-eval'

type Row = {
  action: string
  tool: string | null
  code?: string
  agentId?: string
  client: string
}

type Stored = {
  action: string
  inputRef: string | null
  outputRef: string | null
  policyDecision: string | null
  metadata: Record<string, unknown>
  createdAt: Date
  actorId: string | null
  tenantId: string
}

function memAudit(): Pick<AuditRepository, 'findMany'> & { rows: Stored[]; lastFilter?: AuditListFilter } {
  const rows: Stored[] = []
  const store: Pick<AuditRepository, 'findMany'> & { rows: Stored[]; lastFilter?: AuditListFilter } = {
    rows,
    async findMany(filter?: AuditListFilter) {
      store.lastFilter = filter
      const actions = filter?.action
        ? new Set(Array.isArray(filter.action) ? filter.action : [filter.action])
        : null
      return rows
        .filter((r) => !filter?.tenantId || r.tenantId === filter.tenantId)
        .filter((r) => !filter?.since || r.createdAt >= filter.since)
        .filter((r) => !actions || actions.has(r.action))
        .sort((a, b) => filter?.order === 'desc'
          ? b.createdAt.getTime() - a.createdAt.getTime()
          : a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, filter?.limit ?? 100) as Awaited<ReturnType<AuditRepository['findMany']>>
    },
  }
  return store
}

async function main() {
  const audit = memAudit()
  const run = `eval-${Date.now().toString(36)}`
  const since = new Date()
  let seq = since.getTime()

  async function session(name: string, rows: Row[]) {
    const sessionId = `${run}-${name}`
    for (const r of rows) {
      seq += 1
      audit.rows.push({
        action: r.action,
        inputRef: r.tool,
        outputRef: null,
        policyDecision: r.action.includes('deny') || r.action.includes('denied') ? 'denied' : 'allowed',
        metadata: {
          ...(r.tool ? { toolName: r.tool } : {}),
          ...(r.code ? { code: r.code } : {}),
          ...(r.agentId ? { agentId: r.agentId } : {}),
          clientName: r.client,
          sessionId,
        },
        createdAt: new Date(seq),
        actorId: null,
        tenantId: TENANT,
      })
    }
    return sessionId
  }

  console.log('=== mcp-parity eval: 9 Kati-forgatókönyv (in-memory) ===')

  // 1. Blog-draft: mintaszerű sorrend → minden zöld.
  await session('blog-ok', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'claude' },
    { action: 'enterprise.tool.ok', tool: 'platform.project_memory.read', agentId: KATI, client: 'claude' },
    { action: 'mcp.resources.read', tool: 'skill://kati/SKILL.md', agentId: KATI, client: 'claude' },
    { action: 'mcp.tools.call', tool: 'kb_search', agentId: KATI, client: 'claude' },
    { action: 'enterprise.tool.ok', tool: 'platform.work_file.write', agentId: KATI, client: 'claude' },
  ])

  // 2. Céges tény memóriával: definíció+memória, keresés, memória-írás.
  await session('fact-memory', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'cursor' },
    { action: 'enterprise.tool.ok', tool: 'platform.project_memory.read', agentId: KATI, client: 'cursor' },
    { action: 'mcp.resources.read', tool: 'skill://kati/SKILL.md', agentId: KATI, client: 'cursor' },
    { action: 'mcp.tools.call', tool: 'kb_search', agentId: KATI, client: 'cursor' },
    { action: 'enterprise.tool.ok', tool: 'platform.project_memory.write', agentId: KATI, client: 'cursor' },
  ])

  // 3. Keresés definíció nélkül → definitionBeforeSearch hamis.
  await session('search-first', [
    { action: 'mcp.tools.call', tool: 'kb_search', agentId: KATI, client: 'cursor' },
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'cursor' },
    { action: 'mcp.resources.read', tool: 'skill://kati/SKILL.md', agentId: KATI, client: 'cursor' },
    { action: 'enterprise.tool.ok', tool: 'platform.work_file.write', agentId: KATI, client: 'cursor' },
  ])

  // 4. Belépő skill nélkül → entrySkillRead hamis.
  await session('no-skill', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'codex' },
    { action: 'mcp.tools.call', tool: 'kb_search', agentId: KATI, client: 'codex' },
    { action: 'enterprise.tool.ok', tool: 'platform.work_file.write', agentId: KATI, client: 'codex' },
  ])

  // 5. Írás nélkül zár → logWritten/memoryWritten hamis.
  await session('no-write', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'claude' },
    { action: 'mcp.resources.read', tool: 'skill://kati/SKILL.md', agentId: KATI, client: 'claude' },
    { action: 'mcp.tools.call', tool: 'kb_search', agentId: KATI, client: 'claude' },
  ])

  // 6. "Jegyezd meg" kérés → memória-írás.
  await session('remember', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'cursor' },
    { action: 'mcp.resources.read', tool: 'skill://kati/SKILL.md', agentId: KATI, client: 'cursor' },
    { action: 'enterprise.tool.ok', tool: 'platform.project_memory.write', agentId: KATI, client: 'cursor' },
  ])

  // 7. Átadás Gábornak: a checkout és az írás már az ő agentId-jén.
  await session('handoff', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'claude' },
    { action: 'mcp.tools.call', tool: 'platform.agent.checkout', agentId: GABOR, client: 'claude' },
    { action: 'mcp.resources.read', tool: 'skill://gabor/SKILL.md', agentId: GABOR, client: 'claude' },
    { action: 'enterprise.tool.ok', tool: 'platform.work_file.append', agentId: GABOR, client: 'claude' },
  ])

  // 8. Jogosulatlan eszköz → tool_not_allowed számolva.
  await session('denied', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'other' },
    { action: 'mcp.tools.call.deny', tool: 'platform.agent.publish', code: 'tool_not_allowed', agentId: KATI, client: 'other' },
  ])

  // 9. Elavult definíció + tiltott végpont → agent_stale + endpoint_not_allowed.
  await session('stale', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'goose' },
    { action: 'enterprise.tool.denied', tool: 'gmail_send', code: 'agent_stale', agentId: KATI, client: 'goose' },
    { action: 'enterprise.tool.denied', tool: 'http_api_request', code: 'endpoint_not_allowed', agentId: KATI, client: 'goose' },
  ])

  // Zaj: nem-MCP audit-sor ne legyen 10. munkamenet.
  audit.rows.push({
    action: 'user.role.change',
    inputRef: null,
    outputRef: null,
    policyDecision: 'allowed',
    metadata: { sessionId: `${run}-noise`, clientName: 'claude' },
    createdAt: new Date(seq + 1),
    actorId: null,
    tenantId: TENANT,
  })

  const report = await getMcpParityReport(audit, { tenantId: TENANT, since, limit: 5000 })
  const byId = new Map(report.sessionsDetail.map((s) => [s.sessionId, s]))

  await check('findMany action-szűrővel hív (ne keveredjen a 5000-es sapka)', () => {
    const actions = audit.lastFilter?.action
    assert.ok(Array.isArray(actions) && actions.includes('mcp.tools.call'))
    assert.ok(Array.isArray(actions) && !actions.includes('user.role.change'))
  })

  await check('9 forgatókönyv = 9 munkamenet, a zaj kiesik', () => {
    assert.equal(report.sessions, 9)
    assert.equal(byId.has(`${run}-noise`), false)
  })

  await check('1. blog-ok: minden jelző zöld', () => {
    const m = byId.get(`${run}-blog-ok`)!
    assert.equal(m.definitionBeforeSearch, true)
    assert.equal(m.memoryBeforeSearch, true)
    assert.equal(m.entrySkillRead, true)
    assert.equal(m.logWritten, true)
  })

  await check('2. fact-memory: memória-írás napló nélkül is jónak számít', () => {
    const m = byId.get(`${run}-fact-memory`)!
    assert.equal(m.memoryWritten, true)
    assert.equal(m.logWritten, false)
  })

  await check('3. search-first: definíció későn → hamis', () => {
    assert.equal(byId.get(`${run}-search-first`)!.definitionBeforeSearch, false)
  })

  await check('4. no-skill: skill-jelző hamis, a többi zöld marad', () => {
    const m = byId.get(`${run}-no-skill`)!
    assert.equal(m.entrySkillRead, false)
    assert.equal(m.definitionBeforeSearch, true)
  })

  await check('5. no-write: sem napló, sem memória', () => {
    const m = byId.get(`${run}-no-write`)!
    assert.equal(m.logWritten, false)
    assert.equal(m.memoryWritten, false)
  })

  await check('6. remember: memória írva', () => {
    assert.equal(byId.get(`${run}-remember`)!.memoryWritten, true)
  })

  await check('7. handoff: a munkamenet Gáborhoz kötődik (többségi szavazat)', () => {
    assert.equal(byId.get(`${run}-handoff`)!.agentId, GABOR)
  })

  await check('8. denied: tool_not_allowed = 1', () => {
    assert.equal(byId.get(`${run}-denied`)!.toolNotAllowed, 1)
  })

  await check('9. stale: agent_stale + endpoint_not_allowed = 1-1', () => {
    const m = byId.get(`${run}-stale`)!
    assert.equal(m.agentStale, 1)
    assert.equal(m.endpointNotAllowed, 1)
  })

  await check('admin-aggregáció: cellák + trend az élő adatokból', () => {
    assert.ok(report.cells.length >= 5, `várható ≥5 cella, kapott: ${report.cells.length}`)
    const claudeSessions = report.cells
      .filter((c) => c.clientName === 'claude')
      .reduce((n, c) => n + c.sessions, 0)
    assert.ok(claudeSessions >= 3, `claude munkamenet ≥3, kapott: ${claudeSessions}`)
    assert.ok(report.trend.length >= 1)
    assert.ok(
      report.trend.every((t) => t.pctGood === null || (t.pctGood >= 0 && t.pctGood <= 100)),
    )
  })

  await check('a friss eseményeket választja, és jelzi a mintahatárt és a hiányzó sessiont', async () => {
    const sample = memAudit()
    const now = Date.now()
    for (let i = 0; i < 4; i++) {
      sample.rows.push({
        action: 'mcp.tools.call', inputRef: 'kb_search', outputRef: null,
        policyDecision: 'allowed',
        metadata: i === 2 ? {} : { sessionId: `sample-${i}`, clientName: 'codex' },
        createdAt: new Date(now + i), actorId: 'one', tenantId: TENANT,
      })
    }
    const recent = await getMcpParityReport(sample, { tenantId: TENANT, limit: 2 })
    assert.equal(sample.lastFilter?.order, 'desc')
    assert.equal(sample.lastFilter?.limit, 3)
    assert.equal(recent.limited, true)
    assert.equal(recent.unattributedEvents, 1)
    assert.deepEqual(recent.sessionsDetail.map((s) => s.sessionId), ['sample-3'])
  })

  console.log(failures === 0 ? '\nMinden eval-forgatókönyv zöld.' : `\n${failures} eval bukott.`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
