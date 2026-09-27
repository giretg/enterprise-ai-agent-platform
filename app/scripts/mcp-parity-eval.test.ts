/**
 * MCP-paritás eval-készlet (#666) — ÉLŐ DB-s integrációs.
 * Futtatás: npm run test:mcp-parity-eval  (Neon teszt-branch kell: DATABASE_URL_TEST)
 *
 * 9 Kati-forgatókönyv (szintetikus fixture) valós audit-sorokon át:
 * blog-draft Csilla-kapuval, céges tény memóriával, átadás Gábornak,
 * "jegyezd meg" kérés + 3 hibaosztály. A riport-láncot (audit → riport →
 * admin-aggregáció) éles Postgresen vizsgáztatja, ezért kell az élő DB.
 * Az audit append-only: takarítani nem kell, a futás egyedi sessionId
 * prefixet használ és `since` szűr.
 */
import { config } from 'dotenv'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

config({ path: resolve(process.cwd(), '.env.local') })

const testDbUrl = process.env.DATABASE_URL_TEST?.trim()
const testDirectUrl = process.env.DIRECT_URL_TEST?.trim()
if (!testDbUrl || !testDirectUrl) {
  console.error('Hiányzik DATABASE_URL_TEST / DIRECT_URL_TEST (.env.local) — kihagyva.')
  process.exit(1)
}
process.env.DATABASE_URL = testDbUrl
process.env.DIRECT_URL = testDirectUrl

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

type Row = {
  action: string
  tool: string | null
  code?: string
  agentId?: string
  client: string
}

async function main() {
  const { prisma } = await import('../src/lib/db')
  const { PostgresAuditRepository } = await import(
    '../src/repositories/postgres/audit-repository'
  )
  const { getMcpParityReport } = await import(
    '../src/domain/mcp-parity/mcp-parity-service'
  )
  const { computeSessionMetrics, groupMcpSessions } = await import('../src/lib/mcp-parity')

  const tenant = await prisma.tenant.findFirst({ select: { id: true } })
  assert.ok(tenant?.id, 'a teszt-DB-ben nincs tenant — futtasd: npm run db:seed:test')
  const tenantId: string = tenant.id
  const audit = new PostgresAuditRepository()
  const run = `eval-${Date.now().toString(36)}`
  const since = new Date()

  async function session(name: string, rows: Row[]) {
    const sessionId = `${run}-${name}`
    for (const r of rows) {
      await audit.append({
        actorType: 'human',
        action: r.action,
        targetType: 'mcp',
        inputRef: r.tool,
        policyDecision: r.action.includes('deny') || r.action.includes('denied') ? 'denied' : 'allowed',
        metadata: {
          ...(r.tool ? { toolName: r.tool } : {}),
          ...(r.code ? { code: r.code } : {}),
          ...(r.agentId ? { agentId: r.agentId } : {}),
          clientName: r.client,
          sessionId,
        },
        tenantId,
      })
    }
    return sessionId
  }

  console.log('=== mcp-parity eval (élő DB): 9 Kati-forgatókönyv ===')

  // 1. Blog-draft Csilla-kapuval: mintaszerű sorrend → minden zöld.
  await session('blog-ok', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'claude' },
    { action: 'mcp.tools.call', tool: 'platform.project_memory.read', agentId: KATI, client: 'claude' },
    { action: 'mcp.tools.call', tool: 'platform.skills.read', agentId: KATI, client: 'claude' },
    { action: 'mcp.tools.call', tool: 'kb_search', agentId: KATI, client: 'claude' },
    { action: 'mcp.tools.call', tool: 'platform.work_file.write', agentId: KATI, client: 'claude' },
  ])

  // 2. Céges tényre vonatkozó kérdés memóriával: definíció+memória, keresés nélkül is ír.
  await session('fact-memory', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'cursor' },
    { action: 'mcp.tools.call', tool: 'platform.project_memory.read', agentId: KATI, client: 'cursor' },
    { action: 'mcp.tools.call', tool: 'platform.skills.read', agentId: KATI, client: 'cursor' },
    { action: 'mcp.tools.call', tool: 'kb_search', agentId: KATI, client: 'cursor' },
    { action: 'project.project_memory.write', tool: null, agentId: KATI, client: 'cursor' },
  ])

  // 3. Keresés definíció nélkül → definitionBeforeSearch hamis.
  await session('search-first', [
    { action: 'mcp.tools.call', tool: 'kb_search', agentId: KATI, client: 'cursor' },
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'cursor' },
    { action: 'mcp.tools.call', tool: 'platform.skills.read', agentId: KATI, client: 'cursor' },
    { action: 'mcp.tools.call', tool: 'platform.work_file.write', agentId: KATI, client: 'cursor' },
  ])

  // 4. Belépő skill nélkül → entrySkillRead hamis.
  await session('no-skill', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'codex' },
    { action: 'mcp.tools.call', tool: 'kb_search', agentId: KATI, client: 'codex' },
    { action: 'mcp.tools.call', tool: 'platform.work_file.write', agentId: KATI, client: 'codex' },
  ])

  // 5. Írás nélkül zár → logWritten/memoryWritten hamis.
  await session('no-write', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'claude' },
    { action: 'mcp.tools.call', tool: 'platform.skills.read', agentId: KATI, client: 'claude' },
    { action: 'mcp.tools.call', tool: 'kb_search', agentId: KATI, client: 'claude' },
  ])

  // 6. "Jegyezd meg" kérés → memória-írás.
  await session('remember', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'cursor' },
    { action: 'mcp.tools.call', tool: 'platform.skills.read', agentId: KATI, client: 'cursor' },
    { action: 'mcp.tools.call', tool: 'platform.project_memory.write', agentId: KATI, client: 'cursor' },
  ])

  // 7. Átadás Gábornak: a checkout és az írás már az ő agentId-jén.
  await session('handoff', [
    { action: 'mcp.tools.call', tool: 'platform.agent.get_definition', agentId: KATI, client: 'claude' },
    { action: 'mcp.tools.call', tool: 'platform.agent.checkout', agentId: GABOR, client: 'claude' },
    { action: 'mcp.tools.call', tool: 'platform.skills.read', agentId: GABOR, client: 'claude' },
    { action: 'mcp.tools.call', tool: 'platform.work_file.append', agentId: GABOR, client: 'claude' },
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

  const report = await getMcpParityReport(audit, { tenantId, since, limit: 5000 })
  const byId = new Map(report.sessionsDetail.map((s) => [s.sessionId, s]))

  await check('9 forgatókönyv = 9 munkamenet az élő riportban', () => {
    assert.equal(report.sessions, 9)
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
    const claude = report.cells.find((c) => c.clientName === 'claude')
    assert.ok(claude && claude.sessions >= 3)
    assert.ok(report.trend.length >= 1)
    assert.ok(
      report.trend.every((t) => t.pctGood === null || (t.pctGood >= 0 && t.pctGood <= 100)),
    )
  })

  await check('az eval nem lát bele más futások munkameneteibe (since-szűrés)', async () => {
    const rows = await audit.findMany({ tenantId, since, limit: 5000 })
    const groups = groupMcpSessions(
      rows.map((r) => ({
        action: r.action,
        inputRef: r.inputRef,
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
      })),
    )
    assert.ok(groups.length >= 9)
    void computeSessionMetrics
  })

  await prisma.$disconnect()
  console.log(failures === 0 ? '\nMinden eval-forgatókönyv zöld.' : `\n${failures} eval bukott.`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
