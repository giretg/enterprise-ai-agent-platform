/**
 * Postgres-integráció (opcionális): a migrált `platform_chat` séma + a szűk worker-szerep.
 *   PLATFORM_CHAT_TEST_DATABASE_URL=postgres://platform_chat_worker:…@localhost/db npx tsx test/pg-store.it.ts
 * Ideiglenes, helyi adatbázison futtasd — SOHA ne élesen.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { answerQuestion, decideApproval, latestPlan, resumeTurn, runStep, startTurn, toFunctionName, type EngineDeps } from '../src/engine.ts'
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
  continuationToken: async () => ({ token: 'turn-token', featureFlags: [] }),
    activeFeatureFlags: async () => [],
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
  assert.equal(c.origin, 'user')
  assert.equal(c.instructions, null)
  // #1032: platform által indított bejövőlevél-beszélgetés (eredet + utasítás + cím).
  const inbound = await store.createConversation({ tenantId: TENANT, tenantSlug: 'acme', userId: USER, agentId: AGENT, agentName: 'Drive', origin: 'inbound_mail', instructions: 'Töltsd fel a számlát.', title: '✉ Számla' })
  assert.deepEqual([inbound.origin, inbound.instructions, inbound.title], ['inbound_mail', 'Töltsd fel a számlát.', '✉ Számla'])
  assert.equal((await store.getConversation(inbound.id))?.origin, 'inbound_mail')
  await store.deleteConversation(inbound.id)
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

  // #1025 kérdés-kártya + munkaterv: awaiting_input az egy-aktív-forduló indexben, oszlopok és eseménytípusok
  const script = [
    { content: '', toolCalls: [{ id: 'p', name: 'update_plan', arguments: '{"steps":[{"title":"Keresés","status":"in_progress"},{"title":"Levél","status":"pending"}]}' }, { id: 'q', name: 'ask_user', arguments: '{"question":"Melyik Péter?","options":[{"label":"Kovács"},{"label":"Nagy"}]}' }] },
    { content: 'Kész.', toolCalls: [] },
  ]
  const askDeps: EngineDeps = { ...deps, platform: { ...platform, streamCompletion: async () => ({ ...script.shift()!, usage: null, blockReason: null }) } }
  const r2 = await startTurn(askDeps, { conversation: c, chatToken: 'chat', content: 'Küldd Péternek', attachments: [] })
  assert.ok(r2.ok)
  while (queued.length) await runStep(askDeps, queued.shift()!)
  const parked = await store.getTurn(r2.turn.id)
  assert.equal(parked?.status, 'awaiting_input')
  assert.equal(parked?.pendingInput?.question, 'Melyik Péter?')
  assert.equal((await store.activeTurn(c.id))?.id, r2.turn.id)
  assert.equal(await store.createTurn({ conversationId: c.id, tenantId: TENANT, userId: USER, agentId: AGENT }), null)
  assert.equal(latestPlan(await store.listSteps(r2.turn.id))?.length, 2)
  // A második üzenet hibája az első üzenetet és az állapotváltást is visszagörgeti.
  const beforeAnswer = await store.listMessages(c.id)
  const message = { conversationId: c.id, turnId: r2.turn.id, role: 'user' as const, content: 'Nagy', attachments: [] }
  await assert.rejects(store.saveQuestionAnswer({
    turnId: r2.turn.id,
    pendingInput: { ...parked!.pendingInput!, answer: { selected: ['Nagy'] } },
    continuationToken: 'fresh', pausedSeconds: 100, display: 'Nagy',
    messages: [message, { ...message, conversationId: randomUUID() }],
  }), /foreign key/)
  assert.equal((await store.getTurn(r2.turn.id))?.status, 'awaiting_input')
  assert.equal((await store.getTurn(r2.turn.id))?.pendingInput?.answer, undefined)
  assert.deepEqual(await store.listMessages(c.id), beforeAnswer)
  assert.equal(await answerQuestion(askDeps, { turnId: r2.turn.id, userId: USER, chatToken: 'chat', answer: { selected: ['Nagy'] } }), 'ok')
  while (queued.length) await runStep(askDeps, queued.shift()!)
  assert.equal((await store.getTurn(r2.turn.id))?.status, 'succeeded')

  // #1126: az el nem indult forduló flag-kontextusa nem számít az előző forduló eszközállapotának.
  const contextBefore = await store.lastTurnContext(c.id, randomUUID())
  assert.ok(contextBefore?.definition)
  const seeded = await store.createTurn({ conversationId: c.id, tenantId: TENANT, userId: USER, agentId: AGENT })
  assert.ok(seeded)
  await store.updateTurn(seeded.id, { context: { definition: '', tools: [], flagsOnly: true, featureFlags: { pinned: [{ key: 'a.b', onStop: 'old_path' }], stopped: [] } } })
  assert.deepEqual(await store.lastTurnContext(c.id, randomUUID()), contextBefore)
  assert.deepEqual((await store.getTurn(seeded.id))?.context?.featureFlags?.pinned, [{ key: 'a.b', onStop: 'old_path' }])
  assert.ok(await store.transitionTurn(seeded.id, ['queued'], 'cancelled'))
  const after = await store.listMessages(c.id)
  assert.deepEqual(after.slice(-3).map((m) => [m.role, m.content]), [['assistant', ''], ['user', 'Nagy'], ['assistant', 'Kész.']])
  assert.equal(after.at(-3)?.question?.answer.selected[0], 'Nagy')
  assert.equal(after.at(-1)?.plan?.length, 2)
  assert.deepEqual((await store.eventsAfter(r2.turn.id, 0)).filter((e) => ['plan', 'question'].includes(e.type)).map((e) => e.type), ['plan', 'question', 'question'])

  // Valódi Postgres: a szünet benne marad az egy-aktív-forduló indexben, a kész lépés megmarad.
  const resumeDeps: EngineDeps = { ...deps, limits: { ...deps.limits, maxSteps: 1 } }
  const r3 = await startTurn(resumeDeps, { conversation: c, chatToken: 'chat', content: 'Új riport', attachments: [] })
  assert.ok(r3.ok)
  while (queued.length) await runStep(resumeDeps, queued.shift()!)
  assert.equal((await store.getTurn(r3.turn.id))?.status, 'paused')
  assert.equal((await store.getTurn(r3.turn.id))?.pause?.reason, 'steps')
  assert.equal((await store.activeTurn(c.id))?.id, r3.turn.id)
  assert.equal(await store.createTurn({ conversationId: c.id, tenantId: TENANT, userId: USER, agentId: AGENT }), null)
  assert.equal((await store.eventsAfter(r3.turn.id, 0)).at(-1)?.type, 'pause')
  assert.equal(await store.lastEventId(r3.turn.id), (await store.eventsAfter(r3.turn.id, 0)).at(-1)?.seq)
  const firstStep = (await store.listSteps(r3.turn.id))[0]
  await resumeTurn(resumeDeps, { turnId: r3.turn.id, userId: USER, tenantId: TENANT, chatToken: 'chat' })
  // Egy 1-lépéses új keret után újra szünet, számláló és első modellválasz változatlan.
  while (queued.length) await runStep(resumeDeps, queued.shift()!)
  assert.equal((await store.getTurn(r3.turn.id))?.runLimits?.maxSteps, 2)
  assert.deepEqual((await store.listSteps(r3.turn.id))[0], firstStep)
  assert.equal((await store.getTurn(r3.turn.id))?.status, 'paused')

  await store.deleteConversation(c.id)
  assert.equal(await store.getTurn(r.turn.id), null) // kaszkád
  console.log('platform-chat pg-store integration: all passed')
} finally {
  await pool.end()
}
