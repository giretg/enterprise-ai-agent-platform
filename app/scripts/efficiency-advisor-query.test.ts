/**
 * EFF-09 — futás-összegyűjtő lekérdezés (korlátos, tenant-szűrt).
 * Futtatás: npm run test:efficiency-advisor-query
 *
 * DB nélkül: tiszta helper unit + forrásszerződés (groupBy/take, nincs
 * unbounded findMany a 30 napos ablakra).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EFFICIENCY_ADVISOR_MAX_MODEL_ROWS,
  EFFICIENCY_ADVISOR_MAX_RUNS,
  EFFICIENCY_ADVISOR_MAX_TOOL_ROWS,
  EFFICIENCY_ADVISOR_WINDOW_DAYS,
  assembleEfficiencyRuns,
  buildSelectedRunsOrFilter,
  efficiencyRunKeyOf,
  selectRecentRunCandidates,
  type EfficiencyRunCandidate,
} from '../src/domain/agent/efficiency-advisor-query'
import { evaluateEfficiencyAdvisor } from '../src/domain/agent/efficiency-advisor'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

console.log('=== EFF-09 futás-összegyűjtő (efficiency-advisor-query) ===')

check('ablak-konstansok: 30 nap / 20 futás / sor-korlátok', () => {
  assert.equal(EFFICIENCY_ADVISOR_WINDOW_DAYS, 30)
  assert.equal(EFFICIENCY_ADVISOR_MAX_RUNS, 20)
  assert.equal(EFFICIENCY_ADVISOR_MAX_MODEL_ROWS, 2_000)
  assert.equal(EFFICIENCY_ADVISOR_MAX_TOOL_ROWS, 4_000)
})

check('runKey: turn > ticket > conversation', () => {
  assert.deepEqual(
    efficiencyRunKeyOf({ agentTurnId: 't1', ticketId: 'k1', conversationId: 'c1' }),
    { kind: 'turn', id: 't1' },
  )
  assert.deepEqual(
    efficiencyRunKeyOf({ agentTurnId: null, ticketId: 'k1', conversationId: 'c1' }),
    { kind: 'ticket', id: 'k1' },
  )
  assert.deepEqual(
    efficiencyRunKeyOf({ agentTurnId: null, ticketId: null, conversationId: 'c1' }),
    { kind: 'conversation', id: 'c1' },
  )
  assert.equal(
    efficiencyRunKeyOf({ agentTurnId: null, ticketId: null, conversationId: null }),
    null,
  )
})

check('selectRecentRunCandidates: legutóbbi N, dedupe, grain-mix', () => {
  const base = Date.parse('2026-08-01T00:00:00Z')
  const candidates: EfficiencyRunCandidate[] = [
    { kind: 'turn', id: 'turn-old', latest: new Date(base) },
    { kind: 'ticket', id: 'ticket-1', latest: new Date(base + 5_000) },
    { kind: 'conversation', id: 'conv-1', latest: new Date(base + 8_000) },
    { kind: 'turn', id: 'turn-new', latest: new Date(base + 10_000) },
    { kind: 'turn', id: 'turn-old', latest: new Date(base + 1_000) }, // újabb ugyanarra
  ]
  const selected = selectRecentRunCandidates(candidates, 3)
  assert.equal(selected.length, 3)
  assert.deepEqual(
    selected.map((s) => `${s.kind}:${s.id}`),
    ['turn:turn-new', 'conversation:conv-1', 'ticket:ticket-1'],
  )
})

check('selectRecentRunCandidates: üres bemenet → üres', () => {
  assert.deepEqual(selectRecentRunCandidates([], 20), [])
})

check('buildSelectedRunsOrFilter: indexelt OR ágak grain szerint', () => {
  const or = buildSelectedRunsOrFilter([
    { kind: 'turn', id: 't1' },
    { kind: 'turn', id: 't2' },
    { kind: 'ticket', id: 'k1' },
    { kind: 'conversation', id: 'c1' },
  ])
  assert.equal(or.length, 3)
  assert.deepEqual(or[0], { agentTurnId: { in: ['t1', 't2'] } })
  assert.deepEqual(or[1], { ticketId: { in: ['k1'] }, agentTurnId: null })
  assert.deepEqual(or[2], {
    conversationId: { in: ['c1'] },
    agentTurnId: null,
    ticketId: null,
  })
})

check('assembleEfficiencyRuns: detektor-bemenet + coarse conversation grain', () => {
  const selected: EfficiencyRunCandidate[] = [
    { kind: 'turn', id: 'turn-1', latest: new Date('2026-08-10T12:00:00Z') },
    { kind: 'conversation', id: 'conv-1', latest: new Date('2026-08-09T12:00:00Z') },
  ]
  const runs = assembleEfficiencyRuns({
    selected,
    modelRows: [
      {
        agentTurnId: 'turn-1',
        ticketId: null,
        conversationId: 'c-x',
        promptTokens: 100,
        completionTokens: 20,
        cachedPromptTokens: 10,
        costEstimate: 0.01,
        createdAt: new Date('2026-08-10T11:59:00Z'),
        model: 'gpt-5.4',
      },
      {
        agentTurnId: 'turn-1',
        ticketId: null,
        conversationId: 'c-x',
        promptTokens: 200,
        completionTokens: 30,
        cachedPromptTokens: null,
        costEstimate: 0.02,
        createdAt: new Date('2026-08-10T12:00:00Z'),
        model: 'gpt-5.4',
      },
      {
        agentTurnId: null,
        ticketId: null,
        conversationId: 'conv-1',
        promptTokens: 50,
        completionTokens: 10,
        cachedPromptTokens: 0,
        costEstimate: 0.005,
        createdAt: new Date('2026-08-09T12:00:00Z'),
        model: 'gpt-5.4',
      },
    ],
    toolRows: [
      {
        agentTurnId: 'turn-1',
        ticketId: null,
        conversationId: 'c-x',
        toolName: 'file_read',
        argsMeta: { path: 'a.json' },
        resultMeta: { result_chars: 100 },
      },
      {
        agentTurnId: null,
        ticketId: null,
        conversationId: 'conv-1',
        toolName: 'kb_search',
        argsMeta: { query: 'x' },
        resultMeta: { result_chars: 40 },
      },
    ],
  })

  assert.equal(runs.length, 2)
  assert.equal(runs[0]!.kind, 'turn')
  assert.equal(runs[0]!.modelCalls.length, 2)
  assert.equal(runs[0]!.modelCalls[0]!.promptTokens, 100)
  assert.equal(runs[0]!.toolCalls.length, 1)
  assert.equal(runs[1]!.kind, 'conversation')
  assert.equal(runs[1]!.toolCalls[0]!.toolName, 'kb_search')

  const card = evaluateEfficiencyAdvisor(runs)
  assert.equal(card.coarseOnly, true)
  assert.equal(card.status, 'insufficient_data')
})

check('assemble + ticket grain külön a conversation-től', () => {
  const runs = assembleEfficiencyRuns({
    selected: [
      { kind: 'ticket', id: 'ticket-1', latest: new Date('2026-08-10T12:00:00Z') },
    ],
    modelRows: [
      {
        agentTurnId: null,
        ticketId: 'ticket-1',
        conversationId: null,
        promptTokens: 80,
        completionTokens: 10,
        cachedPromptTokens: 0,
        costEstimate: 0.01,
        createdAt: new Date('2026-08-10T12:00:00Z'),
        model: 'gpt-5.4',
      },
    ],
    toolRows: [],
  })
  assert.equal(runs[0]!.kind, 'ticket')
  assert.equal(evaluateEfficiencyAdvisor(runs).coarseOnly, false)
})

// --- Forrásszerződés: EFF-09 DoD a query modulban -----------------------------

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

const querySrc = read('src/domain/agent/efficiency-advisor-query.ts')

check('forrás: collectEfficiencyRuns export (detektor bemenet)', () => {
  assert.match(querySrc, /export async function collectEfficiencyRuns/)
  assert.match(querySrc, /export type EfficiencyRunsQueryResult/)
  assert.match(querySrc, /coarseGranularity/)
})

check('forrás: DB-oldali groupBy + orderBy + take a futás-listára', () => {
  assert.match(querySrc, /prisma\.modelCall\.groupBy/)
  assert.match(querySrc, /by:\s*\['agentTurnId'\]/)
  assert.match(querySrc, /by:\s*\['ticketId'\]/)
  assert.match(querySrc, /by:\s*\['conversationId'\]/)
  assert.match(querySrc, /orderBy:\s*\{\s*_max:\s*\{\s*createdAt:\s*'desc'\s*\}\s*\}/)
  assert.match(querySrc, /take:\s*EFFICIENCY_ADVISOR_MAX_RUNS/)
})

check('forrás: részletes findMany csak kiválasztott futásokra + take', () => {
  assert.match(querySrc, /prisma\.modelCall\.findMany/)
  assert.match(querySrc, /prisma\.toolCall\.findMany/)
  assert.match(querySrc, /take:\s*EFFICIENCY_ADVISOR_MAX_MODEL_ROWS/)
  assert.match(querySrc, /take:\s*EFFICIENCY_ADVISOR_MAX_TOOL_ROWS/)
  assert.match(querySrc, /buildSelectedRunsOrFilter/)
  assert.match(querySrc, /OR:\s*orFilter/)
  // A futás-lista NEM memóriában group-ol egy ablaknyi findMany-ből
  assert.doesNotMatch(querySrc, /new Map<[\s\S]*modelCalls:\s*EfficiencyRun/)
})

check('forrás: tenant-szűrés isAgentReachableFromTenant', () => {
  assert.match(querySrc, /isAgentReachableFromTenant/)
})

check('forrás: agentTurnId nélküli ág conversation grain', () => {
  assert.match(querySrc, /agentTurnId:\s*null/)
  assert.match(querySrc, /kind:\s*'conversation'/)
})

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nAll EFF-09 query checks passed.')
