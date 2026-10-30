/**
 * Postgres-integráció (opcionális): a migrált `platform_chat` séma + a szűk worker-szerep.
 *   PLATFORM_CHAT_TEST_DATABASE_URL=postgres://platform_chat_worker:…@localhost/db npx tsx test/pg-store.it.ts
 * Ideiglenes, helyi adatbázison futtasd — SOHA ne élesen.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { decideApproval, runStep, startTurn, toFunctionName, type EngineDeps } from '../src/engine.ts'
import { createPgStore } from '../src/pg-store.ts'
import type { PlatformClient } from '../src/platform.ts'

const url = process.env.PLATFORM_CHAT_TEST_DATABASE_URL
if (!url) {
  console.log('PLATFORM_CHAT_TEST_DATABASE_URL not set — skipped')
  process.exit(0)
}
const TENANT = process.env.PLATFORM_CHAT_TEST_TENANT_ID ?? '22222222-2222-4222-8222-222222222222'
const USER = randomUUID() // futásonként új: a korábbi futások sorai nem zavarnak
const AGENT = '33333333-3333-4333-8333-333333333333'

const pool = new pg.Pool({ connectionString: url, max: 3 })
const store = createPgStore(pool)
const queued: Array<{ turnId: string; seq: number }> = []
let toolRound = 0
const platform: PlatformClient = {
  continuationToken: async () => 'turn-token',
  listAgents: async () => [],
  getDefinition: async () => '{"definitionId":"d"}',
  listTools: async () => [{ name: 'google_drive_create_folder', inputSchema: { type: 'object', properties: { idempotencyKey: {} } } }],
  callTool: async () =>
    toolRound++ === 0
      ? { kind: 'input_required', requestState: 's', inputKey: 'confirm_write', message: 'Drive mappa: Költségvetés' }
      : { kind: 'complete', text: '{"id":"f"}', isError: false },
  streamCompletion: async (input) => {
    const isFirst = !input.messages.some((m) => m.role === 'tool')
    if (isFirst) return { content: 'Létrehozom. ', toolCalls: [{ id: 'c1', name: toFunctionName('google_drive_create_folder'), arguments: '{"name":"Költségvetés"}' }], usage: null, blockReason: null }
    input.onDelta('Kész a költségvetési mappa.')
    return { content: 'Kész a költségvetési mappa.', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 }, blockReason: null }
  },
}
const deps: EngineDeps = {
  store,
  platform,
  queue: { enqueue: async (t) => void queued.push(t) },
  limits: { maxSteps: 25, maxTurnSeconds: 2400, maxAttemptsPerStep: 3, historyMessages: 30, toolResultChars: 1000 },
  platformOrigin: 'https://app.example.com',
  coreTools: ['google_drive_create_folder'],
}
const drain = async () => {
  while (queued.length) await runStep(deps, queued.shift()!)
}

try {
  // A szűk szerep nem olvassa a platform adatait.
  await assert.rejects(pool.query('SELECT * FROM public.tenants'), /permission denied/)

  const c = await store.createConversation({ tenantId: TENANT, tenantSlug: 'acme', userId: USER, agentId: AGENT, agentName: 'Drive' })
  const r = await startTurn(deps, { conversation: c, chatToken: 'chat', content: 'Készíts mappát a költségvetésnek', attachments: [] })
  assert.ok(r.ok)
  assert.equal((await store.createTurn({ conversationId: c.id, tenantId: TENANT, userId: USER, agentId: AGENT })), null) // egy aktív forduló
  await drain()
  assert.equal((await store.getTurn(r.turn.id))?.status, 'awaiting_approval')
  assert.equal(await decideApproval(deps, { turnId: r.turn.id, userId: USER, decision: 'approve' }), 'ok')
  await drain()
  const turn = await store.getTurn(r.turn.id)
  assert.equal(turn?.status, 'succeeded')
  assert.equal(turn?.continuationToken, null)
  const messages = await store.listMessages(c.id)
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant'])
  assert.match(messages[1].content, /Kész a költségvetési mappa/)
  // #1022 ragadós betöltés: a következő forduló az előző kontextusát látja, a sajátját nem
  assert.deepEqual((await store.lastTurnContext(c.id, randomUUID()))?.loaded, ['google_drive_create_folder'])
  assert.equal(await store.lastTurnContext(c.id, r.turn.id), null)

  const events = await store.eventsAfter(r.turn.id, 0)
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1)) // monoton, hézag nélkül
  assert.equal(events.at(-1)?.type, 'done')
  assert.equal((await store.eventsAfter(r.turn.id, events.length - 1)).length, 1) // Last-Event-ID folytatás

  // D13: keresés a tartalomban (előtag, kis/nagybetű független), cím szerint, átnevezés
  assert.equal((await store.listConversations({ tenantId: TENANT, userId: USER, query: 'költségv', limit: 10 })).length, 1)
  assert.equal((await store.listConversations({ tenantId: TENANT, userId: USER, query: 'nincsilyen', limit: 10 })).length, 0)
  await store.renameConversation(c.id, 'Pénzügyek 2027', true)
  assert.equal((await store.listConversations({ tenantId: TENANT, userId: USER, query: 'pénzügyek', limit: 10 })).length, 1)
  assert.equal((await store.getConversation(c.id))?.titleSetByUser, true)

  await store.deleteConversation(c.id)
  assert.equal(await store.getTurn(r.turn.id), null) // kaszkád
  console.log('platform-chat pg-store integration: all passed')
} finally {
  await pool.end()
}
