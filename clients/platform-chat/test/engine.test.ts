/**
 * Forduló-motor (#1004 §5.2, §6.3, §6.5) — memóriabeli tár + hamis platform.
 * Futtatás: npx tsx test/engine.test.ts
 */
import assert from 'node:assert/strict'
import {
  isTurnFeatureActive,
  answerQuestion,
  APPROVAL_TTL_MS,
  cancelTurn,
  decideApproval,
  MESSAGES,
  planNext,
  runStep,
  resumeTurn,
  startTurn,
  toFunctionName,
  toolDefinitions,
  type EngineDeps,
} from '../src/engine.ts'
import { DEFAULT_MAX_STEPS, loadConfig } from '../src/config.ts'
import { summary, toolGroup } from '../src/tool-loading.ts'
import { normalizeAnswer, INTERACTION_TOOLS } from '../src/interaction-tools.ts'
import { BUDGET_BLOCK_REASON, PlatformError, type LlmResult, type McpCallResult, type PlatformClient, type TurnFeatureFlag } from '../src/platform.ts'
import type { Conversation } from '../src/store.ts'
import { MemoryStore } from './memory-store.ts'
import { normalizeWebUrl, urlDomain, urlsInText, userUrlHashes, webUrlHash } from '../src/web-urls.ts'

const TENANT = '22222222-2222-4222-8222-222222222222'
const USER = '11111111-1111-4111-8111-111111111111'
const AGENT = '33333333-3333-4333-8333-333333333333'
let failures = 0

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack : e}`)
  }
}

type Script = { llm: Array<Partial<LlmResult> | Error>; tool: Array<McpCallResult | Error> }

type ToolSpec = { name: string; description?: string; inputSchema?: Record<string, unknown> }
const DRIVE_TOOLS: ToolSpec[] = [
  { name: 'google_drive.search', description: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  { name: 'google_drive_create_folder', inputSchema: { type: 'object', properties: { name: {}, idempotencyKey: {} } } },
  { name: 'platform.agent.publish', inputSchema: { type: 'object' } },
]

/** Alapból a Drive-eszközök a magban vannak (a #1022 előtti viselkedés); a halasztott betöltés tesztjei felülírják. */
function harness(script: Script, opts: { now?: () => Date; maxSteps?: number; tools?: ToolSpec[]; coreTools?: string[]; definition?: string } = {}) {
  const store = new MemoryStore()
  const queued: Array<{ turnId: string; seq: number }> = []
  const toolCalls: Array<{ name: string; args: Record<string, unknown>; approval?: unknown; userUrlHashes?: string[] }> = []
  const llmMessages: unknown[][] = []
  const llmTools: unknown[][] = []
  const platform: PlatformClient = {
    continuationToken: async () => ({ token: 'turn-token', featureFlags: [] }),
    activeFeatureFlags: async () => [],
    listAgents: async () => [],
    getDefinition: async () => opts.definition ?? '{"definitionId":"def-1","briefing":"Drive-asszisztens"}',
    listTools: async () => opts.tools ?? DRIVE_TOOLS,
    callTool: async (input) => {
      toolCalls.push({ name: input.name, args: input.args, approval: input.approval, userUrlHashes: input.userUrlHashes })
      const next = script.tool.shift()
      if (!next) throw new Error('unexpected tool call')
      if (next instanceof Error) throw next
      return next
    },
    streamCompletion: async (input) => {
      llmMessages.push(input.messages)
      llmTools.push(input.tools)
      const next = script.llm.shift()
      if (!next) throw new Error('unexpected llm call')
      if (next instanceof Error) throw next
      if (next.content) input.onDelta(next.content)
      return { content: '', toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.01 }, blockReason: null, ...next }
    },
  }
  const deps: EngineDeps = {
    store,
    platform,
    queue: { enqueue: async (t) => void queued.push(t) },
    limits: { maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS, maxTurnSeconds: 2400, maxAttemptsPerStep: 3, historyMessages: 30, toolResultChars: 1000 },
    platformOrigin: 'https://app.example.com',
    coreTools: opts.coreTools ?? ['google_drive.search', 'google_drive_create_folder'],
    ...(opts.now ? { now: opts.now } : {}),
  }
  /** A sor kiürítése: amit a motor besorolt, sorban lefuttatjuk (mint a Cloud Tasks). */
  async function drain(max = 50) {
    for (let i = 0; i < max && queued.length; i++) await runStep(deps, queued.shift()!)
  }
  async function conversation(): Promise<Conversation> {
    return store.createConversation({ tenantId: TENANT, tenantSlug: 'acme', userId: USER, agentId: AGENT, agentName: 'Drive' })
  }
  return { store, deps, queued, toolCalls, llmMessages, llmTools, drain, conversation }
}

const say = (content: string): Partial<LlmResult> => ({ content })
const callTool = (name: string, args: Record<string, unknown>, id = 'c1'): Partial<LlmResult> => ({
  toolCalls: [{ id, name: toFunctionName(name), arguments: JSON.stringify(args) }],
})
const done = (text: string): McpCallResult => ({ kind: 'complete', text, isError: false })

async function main() {
  await check('top 20 riport: 25-nél több sikeres lépés után is elkészül az export', async () => {
    assert.equal(loadConfig({ PLATFORM_CHAT_TOKEN_SECRET: 's'.repeat(32), PLATFORM_ORIGIN: 'https://app.example', PLATFORM_CHAT_SELF_URL: 'https://worker.example', PLATFORM_CHAT_DATABASE_URL: 'unused', PLATFORM_CHAT_QUEUE: 'inline' }).limits.maxSteps, DEFAULT_MAX_STEPS)
    const batch = (count: number, prefix: string) => ({ toolCalls: Array.from({ length: count }, (_, i) => ({
      id: `${prefix}-${i}`, name: 'google_drive__search', arguments: JSON.stringify({ q: `${prefix}-${i}` }),
    })) })
    const h = harness({ llm: [batch(4, 'előkészítés'), batch(20, 'ügyfél'), callTool('google_drive_create_folder', { name: 'export' }), say('Kész a riport.')],
      tool: Array.from({ length: 25 }, () => done('{}')) })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Top 20 ügyfél riport', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded')
    assert.equal(h.toolCalls.length, 25)
    assert.equal((await h.store.listSteps(r.turn.id)).length, 29)
  })

  await check('szünet és folytatás: kész írás nem ismétlődik, sorhiba után ugyanott folytat', async () => {
    const h = harness({ llm: [callTool('google_drive_create_folder', { name: 'riport' }), say('Kész.')], tool: [done('{"id":"export"}')] }, { maxSteps: 2 })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'riport', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    const before = (await h.store.getTurn(r.turn.id))!
    assert.equal(before.status, 'paused')
    assert.equal(before.continuationToken, null)
    assert.equal(h.toolCalls.length, 1)
    assert.equal((await h.store.activeTurn(c.id))?.id, r.turn.id)
    assert.equal((await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'másik', attachments: [] })).ok, false)
    assert.equal(await runStep(h.deps, { turnId: r.turn.id, seq: 2 }), 'skip')
    let renewals = 0
    h.deps.platform.continuationToken = async () => { renewals++; return { token: 'fresh-token', featureFlags: [] } }
    const enqueue = h.deps.queue.enqueue
    h.deps.queue.enqueue = async () => { throw new Error('queue unavailable') }
    const input = { turnId: r.turn.id, userId: USER, tenantId: TENANT, chatToken: 'chat' }
    await assert.rejects(resumeTurn(h.deps, input), /queue unavailable/)
    h.deps.queue.enqueue = enqueue
    assert.equal(await resumeTurn(h.deps, input), 'ok')
    assert.equal(renewals, 1)
    assert.deepEqual((await h.store.getTurn(r.turn.id))?.tokenUsage, before.tokenUsage)
    await h.drain()
    const after = (await h.store.getTurn(r.turn.id))!
    assert.equal(after.status, 'succeeded')
    assert.equal(after.runLimits?.maxSteps, 4)
    assert.equal(after.createdAt.getTime(), before.createdAt.getTime())
    assert.equal(after.tokenUsage.costUsd, 0.02)
    assert.equal(h.toolCalls.length, 1)
    assert.equal(h.store.messages.filter((m) => m.role === 'user').length, 1)
    assert.equal(await resumeTurn(h.deps, input), 'not_waiting')
  })

  await check('időkeret: folytatás csak tulajdonossal és friss hozzáféréssel, az eltelt munkaidő megmarad', async () => {
    let now = new Date()
    const h = harness({ llm: [callTool('google_drive_create_folder', { name: 'riport' }), say('Kész.')], tool: [done('{}')] }, { now: () => now })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'riport', attachments: [] })
    assert.ok(r.ok)
    await runStep(h.deps, h.queued.shift()!)
    const created = (await h.store.getTurn(r.turn.id))!.createdAt
    now = new Date(created.getTime() + 2401_000)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.pause?.reason, 'time')
    const input = { turnId: r.turn.id, userId: USER, tenantId: TENANT, chatToken: 'chat' }
    assert.equal(await resumeTurn(h.deps, { ...input, userId: AGENT }), 'not_found')
    assert.equal(await resumeTurn(h.deps, { ...input, tenantId: AGENT }), 'not_found')
    h.deps.platform.continuationToken = async () => { throw new Error('revoked') }
    assert.equal(await resumeTurn(h.deps, input), 'no_access')
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'paused')
    h.deps.platform.continuationToken = async () => ({ token: 'renewed', featureFlags: [] })
    now = new Date(now.getTime() + 86_400_000)
    assert.equal(await resumeTurn(h.deps, input), 'ok')
    const resumed = (await h.store.getTurn(r.turn.id))!
    assert.equal(resumed.runLimits?.maxActiveSeconds, 4800)
    assert.equal(resumed.pausedSeconds, 86400)
    assert.equal(resumed.createdAt.getTime(), created.getTime())
    now = new Date(now.getTime() + 2400_000)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.pause?.reason, 'time') // az előző 40 perc is számít
    assert.equal(h.toolCalls.length, 0)
    assert.equal(await cancelTurn(h.deps, r.turn.id, USER), true)
    assert.equal((await h.store.activeTurn(c.id)), null)
  })

  await check('napi keret: a Folytatás nem kerüli meg a kaput, az elutasítás nem lesz modellválasz', async () => {
    const blocked = { content: 'Mai keret elfogyott.', blockReason: BUDGET_BLOCK_REASON }
    const h = harness({ llm: [callTool('google_drive_create_folder', { name: 'riport' }), blocked, blocked, say('Kész.')], tool: [done('{}')] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'riport', attachments: [] })
    assert.ok(r.ok)
    const input = { turnId: r.turn.id, userId: USER, tenantId: TENANT, chatToken: 'chat' }
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.pause?.reason, 'budget')
    await resumeTurn(h.deps, input)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'paused')
    await resumeTurn(h.deps, input)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded')
    assert.equal(h.toolCalls.length, 1)
    assert.ok(!JSON.stringify(h.llmMessages.at(-1)).includes('Mai keret elfogyott.'))
    assert.equal(h.store.messages.at(-1)?.content, 'Kész.')
    assert.equal((await h.store.getTurn(r.turn.id))?.tokenUsage.costUsd, 0.04)
  })

  await check('egyszerű forduló: user-üzenet → streamelt válasz → assistant üzenet, cím automatikusan', async () => {
    const h = harness({ llm: [say('Szia! Miben segíthetek?')], tool: [] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Szia, mit tudsz?', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'succeeded')
    assert.equal(turn?.continuationToken, null)
    assert.deepEqual(h.store.messages.map((m) => [m.role, m.content]), [['user', 'Szia, mit tudsz?'], ['assistant', 'Szia! Miben segíthetek?']])
    assert.equal(h.store.conversations.get(c.id)?.title, 'Szia, mit tudsz?')
    const types = h.store.events.map((e) => e.type)
    assert.ok(types.includes('delta') && types.at(-1) === 'done')
    // a definíció a system promptban, az agent-szerkesztő eszköz nincs a modell előtt
    const system = h.llmMessages[0][0] as { content: string }
    assert.match(system.content, /definitionId/)
    assert.equal((await h.store.getTurn(r.turn.id))?.context?.tools.some((t) => t.name === 'platform.agent.publish'), false)
  })

  await check('tool-lépés: a modell eszközt hív, az eredmény visszamegy, a pont-nevű eszköz visszafordul', async () => {
    const h = harness({ llm: [callTool('google_drive.search', { q: 'riport' }), say('Megtaláltam a riportot.')], tool: [done('[{"name":"Q3 riport"}]')] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Keresd meg a riportot', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    assert.equal(h.toolCalls[0].name, 'google_drive.search')
    const second = h.llmMessages[1] as Array<{ role: string; content?: string }>
    assert.equal(second.at(-1)?.role, 'tool')
    assert.match(String(second.at(-1)?.content), /Q3 riport/)
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded')
    assert.ok(h.store.events.some((e) => e.type === 'tool' && e.payload.name === 'google_drive.search'))
    // a visszajátszott assistant tool_call is a modell-oldali (pont nélküli) nevet viszi — különben 400 a szolgáltatótól
    const replayed = second.find((m) => m.role === 'assistant') as { tool_calls?: Array<{ function: { name: string } }> }
    assert.equal(replayed.tool_calls?.[0].function.name, 'google_drive__search')
  })

  await check('#1024 fájl-kártya: a document_export linkje az üzenetre és a done eseménybe kerül; Drive-gomb csak Drive-eszközzel', async () => {
    const url = 'https://app.example.com/api/control-plane/document-exports/e1'
    const file = { url, name: 'Riport.xlsx', mimeType: 'application/xlsx', size: 1234, expiresAt: '2026-11-07T10:00:00.000Z', exportId: 'e1' }
    const exportTool: ToolSpec = { name: 'document_export', inputSchema: { type: 'object', properties: { format: {} } } }
    for (const [tools, canSaveToDrive] of [
      [[exportTool, { name: 'google_drive_upload_file', inputSchema: { type: 'object' } }], true],
      [[exportTool], false],
    ] as const) {
      const h = harness(
        { llm: [callTool('document_export', { format: 'xlsx' }), say('Elkészült, innen töltheted le.'), say('Rendben.')], tool: [{ kind: 'complete', text: '{"exportId":"e1"}', isError: false, files: [file] }] },
        { tools: [...tools], coreTools: tools.map((t) => t.name) },
      )
      const c = await h.conversation()
      const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Készíts Excelt', attachments: [] })
      assert.ok(r.ok)
      await h.drain()
      const reply = h.store.messages.find((m) => m.role === 'assistant')
      assert.deepEqual(reply?.files, [{ ...file, canSaveToDrive }])
      const doneEvent = h.store.events.find((e) => e.type === 'done')
      assert.deepEqual(doneEvent?.payload.files, [{ ...file, canSaveToDrive }])
      // A következő fordulóban a modell látja az exportId-t (Drive-mentéshez).
      const next = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Mentsd el a Drive-ra', attachments: [] })
      assert.ok(next.ok)
      await h.drain()
      const history = h.llmMessages.at(-1) as Array<{ role: string; content?: string }>
      assert.match(String(history.find((m) => m.role === 'assistant')?.content), /Elkészült fájl: „Riport\.xlsx” — exportId: e1/)
    }
  })

  await check('#1021 web_fetch: a user saját linkjei hash-elve mennek, a modell linkjei nem; az állapot a domaint mutatja', async () => {
    const fetchTool: ToolSpec = { name: 'web_fetch', inputSchema: { type: 'object', properties: { url: {} } } }
    const h = harness(
      {
        llm: [
          say('Megnézem.'),
          callTool('web_fetch', { url: 'https://www.mnb.hu/arfolyamok' }),
          say('Az MNB oldala szerint…'),
        ],
        tool: [done('{"untrustedWebContent":"..."}')],
      },
      { tools: [fetchTool], coreTools: ['web_fetch'] },
    )
    const c = await h.conversation()
    const first = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Nézd meg: https://www.mnb.hu/arfolyamok.', attachments: [] })
    assert.ok(first.ok)
    await h.drain()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'És mi a mai középárfolyam?', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    assert.equal(h.toolCalls[0].name, 'web_fetch')
    assert.deepEqual(h.toolCalls[0].userUrlHashes, [webUrlHash('https://www.mnb.hu/arfolyamok')])
    const start = h.store.events.find((e) => e.type === 'tool' && e.payload.phase === 'start')
    assert.equal(start?.payload.detail, 'mnb.hu')
  })

  await check('#1021 link-normalizálás: egyezik a platformmal (http→https, fragment le, port/jelszó tilos), írásjel nem része', async () => {
    assert.equal(normalizeWebUrl('http://Example.com/a?b=1#x'), 'https://example.com/a?b=1')
    assert.equal(normalizeWebUrl('https://example.com:8443/'), null)
    assert.equal(normalizeWebUrl('https://user:pw@example.com/'), null)
    // A platform-oldali teszt (`app/scripts/web-fetch.test.ts`) ugyanezt a hash-t várja.
    assert.equal(webUrlHash(normalizeWebUrl('http://example.com/a?b=1#x')!), '6cb547ac73ee23b7a1582362e5f81431')
    assert.deepEqual(urlsInText('Lásd (https://a.hu/x), és [doc](https://b.hu/y). Wiki: https://en.wikipedia.org/wiki/Foo_(bar)!'), [
      'https://a.hu/x',
      'https://b.hu/y',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ])
    assert.deepEqual(userUrlHashes([{ role: 'assistant', content: 'https://evil.example/leak' }]), [])
    assert.equal(urlDomain('ftp://x'), null)
  })

  await check('újraküldés (worker elhal): a kész lépés nem fut újra, az író tool azonos idempotencia-kulcsot kap', async () => {
    const h = harness({
      llm: [callTool('google_drive_create_folder', { name: 'Q3' }), say('Kész a mappa.')],
      tool: [new Error('socket hang up'), done('{"id":"f1"}')],
    })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Hozz létre mappát', attachments: [] })
    assert.ok(r.ok)
    await runStep(h.deps, h.queued.shift()!) // llm (seq 0)
    const toolTask = h.queued.shift()!
    await assert.rejects(runStep(h.deps, toolTask)) // tool első próbálkozás elhal → Cloud Tasks újraküldi
    await runStep(h.deps, toolTask) // újrapróbálás
    await runStep(h.deps, { turnId: r.turn.id, seq: 0 }) // duplikált régi feladat → skip
    await h.drain()
    assert.equal(h.toolCalls.length, 2)
    assert.ok(h.toolCalls[0].args.idempotencyKey)
    assert.equal(h.toolCalls[0].args.idempotencyKey, h.toolCalls[1].args.idempotencyKey)
    assert.equal(h.llmMessages.length, 2) // az LLM-lépés nem futott újra
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded')
  })

  await check('jóváhagyás: input_required → awaiting_approval, nincs sorban lépés; Jóváhagyom → folytatódik', async () => {
    const h = harness({
      llm: [callTool('google_drive_create_folder', { name: 'Q3' }), say('Létrehoztam a mappát.')],
      tool: [{ kind: 'input_required', requestState: 'v1.state', inputKey: 'confirm_write', message: 'Drive mappa: Q3' }, done('{"id":"f1"}')],
    })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Mappát kérek', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    let turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'awaiting_approval')
    assert.equal(h.queued.length, 0)
    assert.equal(turn?.pendingApproval?.message, 'Drive mappa: Q3')
    assert.ok(h.store.events.some((e) => e.type === 'approval' && e.payload.phase === 'requested'))
    assert.equal(await decideApproval(h.deps, { turnId: r.turn.id, userId: USER, decision: 'approve' }), 'ok')
    await h.drain()
    turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'succeeded')
    assert.deepEqual(h.toolCalls[1].approval, { requestState: 'v1.state', inputKey: 'confirm_write', decision: 'approve' })
    assert.equal(h.toolCalls[0].args.idempotencyKey, h.toolCalls[1].args.idempotencyKey)
  })

  await check('jóváhagyás 15 perc után: a kérés a jóváhagyási listára kerül, a forduló zárószöveggel lezárul', async () => {
    let now = new Date('2026-10-29T10:00:00Z')
    const h = harness(
      { llm: [callTool('google_drive_create_folder', { name: 'Q3' })], tool: [{ kind: 'input_required', requestState: 's', inputKey: 'confirm_write', message: 'm' }] },
      { now: () => now },
    )
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    now = new Date(now.getTime() + APPROVAL_TTL_MS + 1000)
    assert.equal(await decideApproval(h.deps, { turnId: r.turn.id, userId: USER, decision: 'approve' }), 'expired')
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded')
    assert.match(h.store.messages.at(-1)!.content, /jóváhagyási listára/)
    assert.equal(h.toolCalls.length, 1) // a lejárt állapottal nem hívtuk újra
  })

  await check('egy beszélgetés, egy futó forduló: új üzenet futás közben → busy', async () => {
    const h = harness({ llm: [say('a')], tool: [] })
    const c = await h.conversation()
    assert.ok((await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: '1', attachments: [] })).ok)
    assert.deepEqual(await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: '2', attachments: [] }), { ok: false, code: 'busy' })
  })

  await check('Stop: a megszakított forduló következő lépése kilép', async () => {
    const h = harness({ llm: [callTool('google_drive.search', { q: 'x' })], tool: [done('[]')] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await runStep(h.deps, h.queued.shift()!)
    assert.ok(await cancelTurn(h.deps, r.turn.id, USER))
    await h.drain()
    assert.equal(h.toolCalls.length, 0)
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'cancelled')
    assert.equal(await cancelTurn(h.deps, r.turn.id, '99999999-9999-4999-8999-999999999999'), false)
  })

  await check('napi keret elfogyott: a forduló folytathatóan szünetel', async () => {
    const h = harness({ llm: [{ content: 'A cég mai keretét erre a beszélgetésre már felhasználtuk.', blockReason: BUDGET_BLOCK_REASON }], tool: [] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'paused')
    assert.match(String(turn?.pause?.message), /keretét/)
    assert.ok(h.store.events.some((e) => e.type === 'pause' && e.payload.reason === 'budget'))
  })

  await check('ismétlődő-hurok: azonos tool + argumentum 3× → leállás', async () => {
    const same = () => callTool('google_drive.search', { q: 'x' })
    const h = harness({ llm: [same(), same(), same()], tool: [done('[]'), done('[]')] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'failed')
    assert.equal(turn?.error, MESSAGES.loop)
    assert.equal(h.toolCalls.length, 2)
  })

  await check('belső vészfék: szünet; ismétlődő futási hiba: failed', async () => {
    const h = harness({ llm: [callTool('google_drive.search', { q: '1' })], tool: [done('[]')] }, { maxSteps: 2 })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.pause?.message, MESSAGES.tooManySteps)

    const h2 = harness({ llm: [new Error('502'), new Error('502'), new Error('502')], tool: [] })
    const c2 = await h2.conversation()
    const r2 = await startTurn(h2.deps, { conversation: c2, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r2.ok)
    const task = h2.queued.shift()!
    await assert.rejects(runStep(h2.deps, task))
    await assert.rejects(runStep(h2.deps, task))
    assert.equal(await runStep(h2.deps, task), 'done') // 3. hiba → failed, nem dob tovább
    assert.equal((await h2.store.getTurn(r2.turn.id))?.error, MESSAGES.failed)
  })

  await check('visszavont hozzáférés (403): azonnal failed, nincs újrapróbálás', async () => {
    const h = harness({ llm: [new PlatformError('denied', 403)], tool: [] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    assert.equal(await runStep(h.deps, h.queued.shift()!), 'done')
    assert.equal((await h.store.getTurn(r.turn.id))?.error, MESSAGES.noAccess)
  })

  await check('elfogyott modell-kredit (402): szünet, érthető üzenettel, nincs automatikus újrapróbálás', async () => {
    const h = harness({ llm: [new PlatformError('model gateway: 402 requires more credits', 402)], tool: [] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    assert.equal(await runStep(h.deps, h.queued.shift()!), 'done')
    assert.equal((await h.store.getTurn(r.turn.id))?.pause?.reason, 'credit')
    assert.equal(h.queued.length, 0)
  })

  await check('szolgáltatói kiesés: az LLM-lépés egyre később próbálkozik újra, és a kiesés után folytatódik', async () => {
    const down = () => new PlatformError('model gateway: 502 provider_unavailable', 502)
    const h = harness({ llm: [down(), new PlatformError('model gateway: 429 rate_limited', 429), down(), say('Rendben.')], tool: [] })
    const delays: Array<number | undefined> = []
    const enqueue = h.deps.queue.enqueue
    h.deps.queue.enqueue = async (t, options) => {
      delays.push(options?.delaySeconds)
      await enqueue(t, options)
    }
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    assert.deepEqual(delays.slice(1), [15, 30, 60])
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded')
    const events = await h.store.eventsAfter(r.turn.id, 0)
    assert.equal(events.filter((e) => e.type === 'status' && e.payload.phase === 'model_retry').length, 3)
  })

  await check('szolgáltatói kiesés: a negyedik hiba után a forduló érthető hibával lezárul', async () => {
    const down = () => new PlatformError('model gateway: 502 provider_unavailable', 502)
    const h = harness({ llm: [down(), down(), down(), down()], tool: [] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'failed')
    assert.equal(turn?.error, MESSAGES.failed)
    assert.equal(h.queued.length, 0)
    assert.equal((await h.store.listSteps(r.turn.id))[0].attempts, 4)
  })

  await check('nem kiesés jellegű hiba (500) nem kap késleltetett újrapróbálást', async () => {
    const h = harness({ llm: [new PlatformError('model gateway: 500', 500)], tool: [] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await assert.rejects(runStep(h.deps, h.queued.shift()!))
    assert.equal(h.queued.length, 0)
  })

  await check('csatolmány: a kinyert szöveg a user-üzenet mellé kerül', async () => {
    const h = harness({ llm: [say('3 sor van.')], tool: [] })
    const c = await h.conversation()
    const att = await h.store.addAttachment({ conversationId: c.id, storagePath: 'p', name: 'adat.csv', mime: 'text/csv', size: 20, extractedText: 'a;b\n1;2\n3;4' })
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Hány sor?', attachments: [att] })
    assert.ok(r.ok)
    await h.drain()
    const user = (h.llmMessages[0] as Array<{ role: string; content: unknown }>).find((m) => m.role === 'user')
    assert.match(String(user?.content), /adat\.csv[\s\S]*3;4/)
  })

  await check('#1023 helyi olvasás → gateway; Drive-átadás → jóváhagyás, bájtok nélkül a promptban', async () => {
    const upload = { name: 'google_drive_upload_file', inputSchema: { type: 'object', properties: { contentBase64: {}, idempotencyKey: {} } } }
    const script: Script = { llm: [], tool: [{ kind: 'input_required', requestState: 'state', inputKey: 'approval', message: 'Upload contract.txt?' }, done('uploaded')] }
    const h = harness(script, { tools: [upload], coreTools: [upload.name] })
    const c = await h.conversation()
    const bytes = Buffer.from('termination notice 62 days')
    h.deps.storage = { get: async () => bytes, put: async () => {}, remove: async () => {} }
    const att = await h.store.addAttachment({ conversationId: c.id, storagePath: 'p', name: 'contract.txt', mime: 'text/plain', size: bytes.length, extractedText: bytes.toString() })
    script.llm.push(callTool('attachment_read', { id: att.id }), callTool(upload.name, { contentBase64: `attachment://${att.id}` }), say('Kész.'))
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Olvasd el és töltsd fel', attachments: [att] })
    assert.ok(r.ok)
    await h.drain()
    assert.equal(h.toolCalls.length, 1) // az attachment_read nem MCP
    assert.equal(h.toolCalls[0].args.contentBase64, bytes.toString('base64'))
    assert.equal(h.toolCalls[0].args.name, att.name)
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'awaiting_approval')
    const gatewayInput = h.llmMessages[1] as Array<{ role: string; content: unknown }>
    assert.match(String(gatewayInput.find((m) => m.role === 'tool')?.content), /termination notice/)
    // A jelen forduló user-üzenete tool-lépés után is megtartja a kezdőrészletet.
    assert.match(String(gatewayInput.find((m) => m.role === 'user')?.content), /termination notice/)
    assert.ok(!JSON.stringify(h.llmMessages).includes(bytes.toString('base64')))
    assert.ok(JSON.stringify(h.llmTools[0]).includes('attachment_search'))
    assert.equal(await decideApproval(h.deps, { turnId: r.turn.id, userId: USER, decision: 'approve' }), 'ok')
    await h.drain()
    assert.equal(h.toolCalls[0].args.idempotencyKey, h.toolCalls[1].args.idempotencyKey)
    assert.deepEqual(h.toolCalls[0].args, h.toolCalls[1].args)
    assert.ok(!JSON.stringify(h.llmMessages).includes(bytes.toString('base64')))
  })

  await check('#1023 idegen csatolmány: helyi hiba, nincs MCP-hívás', async () => {
    const script: Script = { llm: [], tool: [] }
    const h = harness(script)
    const c = await h.conversation()
    const other = await h.conversation()
    const att = await h.store.addAttachment({ conversationId: other.id, storagePath: 'secret', name: 'secret.txt', mime: 'text/plain', size: 5, extractedText: 'SECRET' })
    h.deps.storage = { get: async () => { throw new Error('must not read') }, put: async () => {}, remove: async () => {} }
    script.llm.push(callTool('attachment_read', { id: att.id }), say('Ez a fájl itt nem érhető el.'))
    assert.ok((await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Olvasd el', attachments: [] })).ok)
    await h.drain()
    assert.equal(h.toolCalls.length, 0)
    assert.match(JSON.stringify(h.llmMessages[1]), /nem érhető el ebben a beszélgetésben/)
    assert.ok(!JSON.stringify(h.llmMessages).includes('SECRET'))
  })

  await check('#1023 képet nem fogadó modell: közérthető jelzés, továbbra is gatewayen át', async () => {
    const script: Script = { llm: [], tool: [] }
    const h = harness(script)
    const c = await h.conversation()
    h.deps.storage = { get: async () => Buffer.from('image'), put: async () => {}, remove: async () => {} }
    const att = await h.store.addAttachment({ conversationId: c.id, storagePath: 'p', name: 'scan.png', mime: 'image/png', size: 5, extractedText: null })
    script.llm.push(callTool('attachment_view', { id: att.id }), new PlatformError('model does not support image input', 400), say('A modell nem tud képet olvasni.'))
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Olvasd el a szkennelt oldalt', attachments: [att] })
    assert.ok(r.ok)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded')
    assert.equal(h.llmMessages.length, 3)
    assert.match(JSON.stringify(h.llmMessages.at(-1)), /nem tud képet fogadni/)
    assert.equal(h.toolCalls.length, 0)
  })

  await check('planNext: tool-hívások sorban, utána újra LLM', async () => {
    const llm = { turnId: 't', seq: 0, kind: 'llm' as const, inputHash: '', status: 'done' as const, attempts: 1, idempotencyKey: null,
      output: { content: '', toolCalls: [{ id: 'a', name: 'x', arguments: '{}' }, { id: 'b', name: 'y', arguments: '{}' }] } }
    assert.deepEqual(planNext([]), { kind: 'llm' })
    assert.equal((planNext([llm]) as { call: { id: string } }).call.id, 'a')
    const tool = { ...llm, seq: 1, kind: 'tool' as const, output: { callId: 'a', name: 'x', text: '', isError: false } }
    assert.equal((planNext([llm, tool]) as { call: { id: string } }).call.id, 'b')
    assert.deepEqual(planNext([llm, tool, { ...tool, seq: 2 }]), { kind: 'llm' })
  })

  // --- #1022: halasztott eszköz-betöltés ---
  // A #1025 kérdés-/munkaterv-eszközök minden fordulóban ott vannak; a #1022 tesztek a többit nézik.
  const names = (tools: unknown[]) => (tools as Array<{ function: { name: string } }>).map((t) => t.function.name).filter((n) => !INTERACTION_TOOLS.includes(n))
  const systemOf = (messages: unknown[]) => (messages[0] as { content: string }).content
  const deferred = { coreTools: ['kb_search'], tools: [{ name: 'kb_search', description: 'Keresés a tudástárban.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }, ...DRIVE_TOOLS] }

  await check('#1022 eszköz nélküli kérdés: csak a mag + tool_describe a tools[]-ben, a többi az indexben', async () => {
    const h = harness({ llm: [say('Szia!')], tool: [] }, deferred)
    const c = await h.conversation()
    assert.ok((await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Szia', attachments: [] })).ok)
    await h.drain()
    assert.deepEqual(names(h.llmTools[0]), ['kb_search', 'tool_describe'])
    const system = systemOf(h.llmMessages[0])
    assert.match(system, /eszköz-index/)
    assert.match(system, /Google Drive\n- google_drive__search — search\n- google_drive_create_folder/)
    assert.doesNotMatch(system, /- kb_search/) // a mag nincs az indexben
    assert.ok(system.indexOf('eszköz-index') < system.indexOf('A MUNKATÁRS DEFINÍCIÓJA')) // stabil rész a memória előtt
  })

  await check('#1022 ~80 eszköz: a forduló eleji prompt (séma + index) legalább 70%-kal kisebb', async () => {
    const prefixes = ['google_drive_', 'gmail_', 'kb_', 'warehouse_', 'http_api_', 'platform.work_file.', 'platform.mini_app.', 'sandbox_']
    const tools: ToolSpec[] = Array.from({ length: 80 }, (_, i) => ({
      name: `${prefixes[i % prefixes.length]}tool_${i}`,
      description: `Eszköz ${i}: rövid első mondat a feladatáról. ` + 'Részletes használati útmutató, korlátok, példák és figyelmeztetések. '.repeat(5),
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(['definitionId', 'query', 'fileId', 'limit', 'cursor', 'account'].map((p) => [p, { type: 'string', description: `A(z) ${p} paraméter leírása, formátuma és alapértéke.` }])),
        required: ['definitionId'],
      },
    }))
    const h = harness({ llm: [say('Szia!')], tool: [] }, { tools, coreTools: ['kb_tool_2'] })
    const c = await h.conversation()
    assert.ok((await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Szia', attachments: [] })).ok)
    await h.drain()
    const after = JSON.stringify(h.llmTools[0]).length + systemOf(h.llmMessages[0]).length
    const legacySystem = systemOf(h.llmMessages[0]).replace(/\n--- TOVÁBBI ESZKÖZÖK[\s\S]*?(?=\n\n--- A MUNKATÁRS)/, '')
    const before = JSON.stringify(toolDefinitions({ definition: '', tools })).length + legacySystem.length
    assert.ok(after <= before * 0.3, `előtte ${before}, utána ${after} karakter`)
  })

  await check('#1022 Drive-keresés: tool_describe → ugyanabban a fordulóban a saját nevén hívja, helyben fut', async () => {
    const h = harness({
      llm: [
        callTool('tool_describe', { names: ['google_drive__search'] }, 'd1'),
        callTool('google_drive.search', { q: 'árajánlat 2025' }, 'c2'),
        say('Megtaláltam a tavalyi árajánlatot.'),
      ],
      tool: [done('[{"name":"Árajánlat 2025"}]')],
    }, deferred)
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Keresd meg a Drive-on a tavalyi árajánlatot', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded')
    assert.deepEqual(h.toolCalls.map((t) => t.name), ['google_drive.search']) // a tool_describe nem MCP-hívás
    assert.ok(!names(h.llmTools[0]).includes('google_drive__search'))
    assert.deepEqual(names(h.llmTools[1]), ['google_drive__search', 'kb_search', 'tool_describe'])
    assert.match(String((h.llmMessages[1].at(-1) as { content: string }).content), /Betöltve: google_drive__search/)
    assert.equal(systemOf(h.llmMessages[0]), systemOf(h.llmMessages[2])) // az index fordulón belül változatlan
  })

  await check('#1022 író eszköz tool_describe után: jóváhagyás-kártya és idempotencia-kulcs változatlan', async () => {
    const h = harness({
      llm: [callTool('tool_describe', { names: ['google_drive_create_folder'] }, 'd1'), callTool('google_drive_create_folder', { name: 'Q3' }, 'c2'), say('Kész.')],
      tool: [{ kind: 'input_required', requestState: 'st', inputKey: 'confirm_write', message: 'Drive mappa: Q3' }, done('{"id":"f1"}')],
    }, deferred)
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Mappát kérek', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'awaiting_approval')
    assert.equal(await decideApproval(h.deps, { turnId: r.turn.id, userId: USER, decision: 'approve' }), 'ok')
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded')
    assert.ok(h.toolCalls[0].args.idempotencyKey)
    assert.equal(h.toolCalls[0].args.idempotencyKey, h.toolCalls[1].args.idempotencyKey)
    assert.deepEqual(h.toolCalls[1].approval, { requestState: 'st', inputKey: 'confirm_write', decision: 'approve' })
  })

  await check('#1022 be nem töltött eszköz hívása: automatikus betöltés + egyetlen újrapróba, hurok-leállás nélkül', async () => {
    const search = () => callTool('google_drive.search', { q: 'x' })
    const h = harness({ llm: [search(), search(), say('Kész.')], tool: [done('[]')] }, deferred)
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'succeeded')
    assert.equal(h.toolCalls.length, 1) // az első hívás nem ment ki az MCP-re
    assert.match(String((h.llmMessages[1].at(-1) as { content: string }).content), /most betöltöttem/)
    assert.ok(names(h.llmTools[1]).includes('google_drive__search'))
    assert.ok(turn?.context?.loaded?.includes('google_drive.search'))

    // az automatikus betöltés nem számít az ismétlődő-hurok őrbe: autoload + 2 azonos hívás még fut, a 3. azonos áll le
    const h2 = harness({ llm: [search(), search(), search(), search()], tool: [done('[]'), done('[]')] }, deferred)
    const c2 = await h2.conversation()
    const r2 = await startTurn(h2.deps, { conversation: c2, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r2.ok)
    await h2.drain()
    assert.equal(h2.toolCalls.length, 2)
    assert.equal((await h2.store.getTurn(r2.turn.id))?.error, MESSAGES.loop)
  })

  await check('#1022 ragadós betöltés: a következő fordulóban is betöltve, az index bájt-azonos', async () => {
    const h = harness({
      llm: [callTool('tool_describe', { names: ['google_drive.search'] }, 'd1'), say('Betöltöttem.'), say('Második válasz.')],
      tool: [],
    }, deferred)
    const c = await h.conversation()
    assert.ok((await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: '1', attachments: [] })).ok)
    await h.drain()
    assert.ok((await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: '2', attachments: [] })).ok)
    await h.drain()
    assert.deepEqual(names(h.llmTools[2]), ['google_drive__search', 'kb_search', 'tool_describe'])
    assert.equal(systemOf(h.llmMessages[0]), systemOf(h.llmMessages[2]))
  })

  await check('#1022 tool_describe ismeretlen névvel: hiba, semmi nem töltődik be; a definíció preloadTools-a mag', async () => {
    const h = harness({ llm: [callTool('tool_describe', { names: ['nincs_ilyen'] }, 'd1'), say('Nem találom.')], tool: [] },
      { ...deferred, definition: '{"definitionId":"def-1","snapshot":{"preloadTools":["google_drive_create_folder"]}}' })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    assert.deepEqual(names(h.llmTools[0]), ['google_drive_create_folder', 'kb_search', 'tool_describe'])
    assert.deepEqual(names(h.llmTools[1]), names(h.llmTools[0]))
    const last = h.llmMessages[1].at(-1) as { content: string }
    assert.match(last.content, /Nem elérhető eszköz: nincs_ilyen/)
  })

  await check('#1022 minden halasztott eszköz betöltve: a tool_describe a tools[]-ben marad (visszajátszás, index)', async () => {
    const h = harness({
      llm: [callTool('tool_describe', { names: ['google_drive.search'] }, 'd1'), say('Kész.')],
      tool: [],
    }, { coreTools: ['kb_search'], tools: [deferred.tools[0], DRIVE_TOOLS[0]] })
    const c = await h.conversation()
    assert.ok((await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })).ok)
    await h.drain()
    assert.deepEqual(names(h.llmTools[1]), ['google_drive__search', 'kb_search', 'tool_describe'])
    assert.equal(systemOf(h.llmMessages[0]), systemOf(h.llmMessages[1]))
  })

  await check('#1022 régi (loaded nélküli) kontextus: minden eszköz betöltött, nincs index és tool_describe', async () => {
    const context = { definition: '', tools: DRIVE_TOOLS }
    assert.deepEqual(names(toolDefinitions(context)), ['google_drive__search', 'google_drive_create_folder', 'platform__agent__publish'] /* kódpont: '.' < '_' */)
    assert.equal(toolGroup('gmail_send'), 'Gmail')
    assert.equal(toolGroup('platform.project_memory.read'), 'Memória és munkafájlok')
    assert.equal(toolGroup('valami'), 'Egyéb')
    assert.equal(summary('Első mondat. Második mondat.'), 'Első mondat.')
    assert.equal(summary('x'.repeat(300)).length, 120)
  })

  const PETER = {
    question: 'Melyik Péternek küldjem a beszámolót?',
    options: [{ label: 'Kovács Péter', description: 'kovacs.peter@acme.hu' }, { label: 'Nagy Péter', description: 'nagy.peter@acme.hu' }],
  }

  await check('levélből indult forduló: a Folytatás is háttérfutásként kér tokent (írás jóváhagyásra vár)', async () => {
    const h = harness({ llm: [callTool('google_drive_create_folder', { name: 'riport' }), say('Kész.')], tool: [done('{"id":"export"}')] }, { maxSteps: 2 })
    const minted: Array<{ background?: true }> = []
    h.deps.platform.continuationToken = async (input) => (minted.push(input), { token: 'fresh-token', featureFlags: [] })
    const mail = await h.store.createConversation({ tenantId: TENANT, tenantSlug: 'acme', userId: USER, agentId: AGENT, agentName: 'Drive', origin: 'inbound_mail' })
    const r = await startTurn(h.deps, { conversation: mail, chatToken: 'chat', content: 'levél', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'paused')
    assert.equal(await resumeTurn(h.deps, { turnId: r.turn.id, userId: USER, tenantId: TENANT, chatToken: 'chat' }), 'ok')
    assert.equal(minted.at(-1)?.background, true)
    const own = await h.conversation()
    const r2 = await startTurn(h.deps, { conversation: own, chatToken: 'chat', content: 'riport', attachments: [] })
    assert.ok(r2.ok)
    assert.equal(minted.at(-1)?.background, undefined)
  })

  await check('#1025 kérdés-kártya: awaiting_input, nincs futó feladat; 1 óra múlva kattintás → folytatódik, jóváhagyás-kártyáig', async () => {
    let clock = new Date('2026-11-01T10:00:00Z')
    const h = harness({
      llm: [
        { content: 'Két Pétert találtam.', toolCalls: [{ id: 'q1', name: 'ask_user', arguments: JSON.stringify(PETER) }] },
        callTool('google_drive_create_folder', { name: 'Kovács Péter' }, 'w1'),
      ],
      tool: [{ kind: 'input_required', requestState: 'rs', inputKey: 'ik', message: 'Mappa létrehozása: Kovács Péter' }],
    }, { now: () => clock })
    let minted = 0
    const mint = h.deps.platform.continuationToken
    h.deps.platform.continuationToken = async (input) => (minted++, mint(input))
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Küldd el a beszámolót Péternek', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    let turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'awaiting_input')
    assert.equal(h.queued.length, 0) // várakozás közben nincs feladat
    const asked = h.store.events.find((e) => e.type === 'question')
    assert.equal(asked?.payload.phase, 'requested')
    assert.deepEqual((asked?.payload.options as Array<{ label: string }>).map((o) => o.label), ['Kovács Péter', 'Nagy Péter'])

    clock = new Date(clock.getTime() + 60 * 60_000) // 1 óra (a forduló korlátja 40 perc)
    assert.equal(await answerQuestion(h.deps, { turnId: r.turn.id, userId: USER, chatToken: 'chat2', answer: { selected: ['Ismeretlen'] } }), 'invalid')
    assert.equal(await answerQuestion(h.deps, { turnId: r.turn.id, userId: 'masik', chatToken: 'chat2', answer: { selected: ['Kovács Péter'] } }), 'not_found')
    assert.equal(await answerQuestion(h.deps, { turnId: r.turn.id, userId: USER, chatToken: 'chat2', answer: { selected: ['Kovács Péter'] } }), 'ok')
    assert.equal(await answerQuestion(h.deps, { turnId: r.turn.id, userId: USER, chatToken: 'chat2', answer: { selected: ['Nagy Péter'] } }), 'not_waiting')
    assert.equal(minted, 2) // friss folytatási token a válasznál
    await h.drain()
    turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'awaiting_approval') // a szokásos jóváhagyás-kártya, nem max_time
    assert.equal(turn?.pausedSeconds, 3600)
    const toolResult = (h.llmMessages[1] as Array<{ role: string; content: string }>).at(-1)
    assert.equal(toolResult?.role, 'tool')
    assert.match(toolResult!.content, /„Kovács Péter”/)
    assert.deepEqual(h.store.messages.map((m) => [m.role, m.content]), [
      ['user', 'Küldd el a beszámolót Péternek'],
      ['assistant', 'Két Pétert találtam.'],
      ['user', 'Kovács Péter'],
    ])
    assert.equal(h.store.messages[1].question?.answer.selected[0], 'Kovács Péter')
    // a jelen forduló kérdés–válasz üzenetei nem duplázódnak a modell előzményében
    const second = h.llmMessages[1] as Array<{ role: string; content: string | null }>
    assert.equal(second.filter((m) => m.role === 'user').length, 1)
    assert.ok((h.llmTools[0] as Array<{ function: { name: string } }>).some((t) => t.function.name === 'ask_user'))
  })

  await check('#1025 szöveges válasz a kártya helyett: ugyanaz a forduló folytatódik, nem 409', async () => {
    const h = harness({
      llm: [{ toolCalls: [{ id: 'q1', name: 'ask_user', arguments: JSON.stringify({ ...PETER, allowOther: false }) }] }, say('Rendben, a Q3 beszámolót Nagy Péternek készítem elő.')],
      tool: [],
    })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Küldd el a beszámolót Péternek', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    const again = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'A Nagy Péternek, a Q3-ast', attachments: [] })
    assert.ok(again.ok)
    assert.equal(again.turn.id, r.turn.id)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded')
    assert.match((h.llmMessages[1] as Array<{ content: string }>).at(-1)!.content, /saját szöveggel.*Nagy Péternek, a Q3-ast/)
    assert.deepEqual(h.store.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant'])
    assert.equal(h.store.messages.at(-1)?.content, 'Rendben, a Q3 beszámolót Nagy Péternek készítem elő.')
  })

  await check('#1025 sorhiba után azonos válasz újraküldhető, üzenet és várakozási idő nem duplázódik', async () => {
    const h = harness({ llm: [callTool('ask_user', PETER), say('Kész.')], tool: [] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Péter', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    const enqueue = h.deps.queue.enqueue
    h.deps.queue.enqueue = async () => { throw new Error('queue unavailable') }
    const input = { turnId: r.turn.id, userId: USER, chatToken: 'chat', answer: { text: 'Nagy Péter' } }
    await assert.rejects(answerQuestion(h.deps, input), /queue unavailable/)
    const saved = await h.store.getTurn(r.turn.id)
    assert.equal(saved?.status, 'running')
    assert.equal(h.store.messages.length, 3)
    h.deps.queue.enqueue = enqueue
    // A szövegmezős út is ugyanazt a mentett választ folytatja.
    const retry = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Nagy Péter', attachments: [] })
    assert.ok(retry.ok)
    assert.equal(h.store.messages.length, 3)
    assert.equal((await h.store.getTurn(r.turn.id))?.pausedSeconds, saved?.pausedSeconds)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded')
    assert.equal(h.store.messages.length, 4)
  })

  await check('#1025 hosszú válasz végi utasítás megmarad; túlméret nem vágódik csendben', async () => {
    const question = { ...PETER, allowOther: true, multiSelect: false }
    const text = 'x'.repeat(3000) + ' NE KÜLDD EL'
    assert.equal(normalizeAnswer(question, { text })?.text, text)
    assert.equal(normalizeAnswer(question, { text: 'x'.repeat(32_001) }), null)
  })

  await check('#1025 következő forduló: a korábbi kérdés és a válasz a modell előzményében', async () => {
    const h = harness({ llm: [{ toolCalls: [{ id: 'q1', name: 'ask_user', arguments: JSON.stringify(PETER) }] }, say('Elkészítettem.'), say('ok')], tool: [] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Küldd el Péternek', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    assert.equal(await answerQuestion(h.deps, { turnId: r.turn.id, userId: USER, chatToken: 'chat', answer: { selected: ['Nagy Péter'], text: 'és másold Annát' } }), 'ok')
    await h.drain()
    assert.ok((await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Köszi', attachments: [] })).ok)
    await h.drain()
    const history = (h.llmMessages[2] as Array<{ role: string; content: string }>).slice(1).map((m) => [m.role, m.content])
    assert.deepEqual(history, [
      ['user', 'Küldd el Péternek'],
      ['assistant', '\n\n[Kérdés a felhasználónak: „Melyik Péternek küldjem a beszámolót?” — lehetőségek: Kovács Péter; Nagy Péter]'],
      ['user', 'Nagy Péter — és másold Annát'],
      ['assistant', 'Elkészítettem.'],
      ['user', 'Köszi'],
    ])
  })

  await check('#1025 fordulónként legfeljebb 3 kérdés: a 4. kérdés helyi hibát ad, nem parkol', async () => {
    const ask = (id: string) => ({ toolCalls: [{ id, name: 'ask_user', arguments: JSON.stringify({ ...PETER, question: `Kérdés ${id}` }) }] })
    const h = harness({ llm: [ask('a'), ask('b'), ask('c'), ask('d'), say('Feltételeztem: Kovács Péter.')], tool: [] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    for (let i = 0; i < 3; i++) {
      await h.drain()
      assert.equal((await h.store.getTurn(r.turn.id))?.status, 'awaiting_input')
      assert.equal(await answerQuestion(h.deps, { turnId: r.turn.id, userId: USER, chatToken: 'chat', answer: { selected: ['Kovács Péter'] } }), 'ok')
    }
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded')
    assert.match((h.llmMessages[4] as Array<{ content: string }>).at(-1)!.content, /már 3 kérdést/)
    assert.equal(h.store.events.filter((e) => e.type === 'question' && e.payload.phase === 'requested').length, 3)
  })

  await check('#1025 hibás kérdés (1 lehetőség): helyi hiba a modellnek, nincs parkolás', async () => {
    const h = harness({ llm: [{ toolCalls: [{ id: 'q', name: 'ask_user', arguments: JSON.stringify({ question: 'Biztos?', options: [{ label: 'Igen' }] }) }] }, say('Rendben.')], tool: [] })
    const c = await h.conversation()
    assert.ok((await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })).ok)
    await h.drain()
    assert.match((h.llmMessages[1] as Array<{ content: string }>).at(-1)!.content, /2–5 különböző lehetőséget/)
    assert.equal(h.store.events.some((e) => e.type === 'question'), false)
  })

  await check('#1025 munkaterv: plan események élőben, a záró üzeneten megmarad, nem fogyasztja a lépéskeretet', async () => {
    const plan = (doneCount: number) => ({
      steps: ['Levelek átnézése', 'Összesítés', 'Táblázat', 'Drive-feltöltés'].map((title, i) => ({ title, status: i < doneCount ? 'done' : i === doneCount ? 'in_progress' : 'pending' })),
    })
    const step = (n: number): Partial<LlmResult> => ({
      toolCalls: [
        { id: `p${n}`, name: 'update_plan', arguments: JSON.stringify(plan(n)) },
        { id: `s${n}`, name: toFunctionName('google_drive.search'), arguments: JSON.stringify({ q: `lépés ${n}` }) },
      ],
    })
    const h = harness({
      llm: [step(0), step(1), step(2), step(3), { toolCalls: [{ id: 'p4', name: 'update_plan', arguments: JSON.stringify(plan(4)) }] }, say('Kész a táblázat.')],
      tool: [done('a'), done('b'), done('c'), done('d')],
    }, { maxSteps: 12 })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'Nézd át a leveleket és készíts táblázatot', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded') // 15 lépés, ebből 5 munkaterv → 10 ≤ 12
    const plans = h.store.events.filter((e) => e.type === 'plan').map((e) => (e.payload.steps as Array<{ status: string }>).filter((s) => s.status === 'done').length)
    assert.deepEqual(plans, [0, 1, 2, 3, 4])
    const final = h.store.messages.at(-1)!
    assert.equal(final.plan?.every((s) => s.status === 'done'), true)
    assert.equal(h.store.events.at(-1)?.type, 'done')
    // újracsatlakozás: a Last-Event-ID utáni események közt az utolsó munkaterv helyes
    const lastPlan = h.store.events.filter((e) => e.type === 'plan').at(-1)!
    assert.deepEqual((await h.store.eventsAfter(r.turn.id, lastPlan.seq - 1))[0].payload, lastPlan.payload)
  })

  await check('#1025 hibás munkaterv és Stop várakozó kérdésnél', async () => {
    const h = harness({ llm: [{ toolCalls: [{ id: 'p', name: 'update_plan', arguments: '{"steps":[{"title":"x","status":"kész"}]}' }, { id: 'q', name: 'ask_user', arguments: JSON.stringify(PETER) }] }], tool: [] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    assert.equal(h.store.events.some((e) => e.type === 'plan'), false)
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'awaiting_input')
    assert.ok(await cancelTurn(h.deps, r.turn.id, USER))
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'cancelled')
    assert.equal(turn?.pendingInput, null)
    assert.equal(await answerQuestion(h.deps, { turnId: r.turn.id, userId: USER, chatToken: 'chat', answer: { selected: ['Kovács Péter'] } }), 'not_waiting')
  })

  const FLAG = 'chat.next_step'
  // Alapból a forduló már túl van a türelmi időn, ahol a flag hiánya még nem számít leállításnak.
  const flagged = (
    onStop: 'finish_run' | 'old_path',
    script: Script,
    active: () => TurnFeatureFlag[] | Promise<TurnFeatureFlag[]>,
    now: () => Date = () => new Date(Date.now() + 60_000),
  ) => {
    const h = harness(script, { now })
    h.deps.platform.continuationToken = async () => ({ token: 'turn-token', featureFlags: [{ key: FLAG, onStop }] })
    h.deps.platform.activeFeatureFlags = async () => active()
    return h
  }
  const twoSteps = (): Script => ({ llm: [callTool('google_drive.search', { q: 'x' }), say('Kész.')], tool: [done('találat')] })

  await check('#1126 flag nélkül a működés változatlan: nincs ellenőrző hívás, a kontextusban nincs flag', async () => {
    const h = harness(twoSteps())
    let checks = 0
    h.deps.platform.activeFeatureFlags = async () => (checks++, [])
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    assert.equal((await h.store.getTurn(r.turn.id))?.context, null)
    await h.drain()
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'succeeded')
    assert.equal(checks, 0)
    assert.equal(turn?.context?.featureFlags, undefined)
    assert.equal(isTurnFeatureActive(turn!.context, FLAG), false)
  })

  await check('#1126 a flag a forduló elején rögzül, a definíció és az eszközök mellett megmarad', async () => {
    const h = flagged('finish_run', twoSteps(), () => [{ key: FLAG, onStop: 'finish_run' }, { key: 'chat.later', onStop: 'old_path' }])
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'succeeded')
    assert.equal(h.toolCalls.length, 1)
    assert.ok(turn?.context?.definition.includes('Drive-asszisztens'))
    assert.equal(turn?.context?.flagsOnly, undefined)
    assert.equal(isTurnFeatureActive(turn!.context, FLAG), true)
    // Futás közben bekapcsolt flag nem vált működést félúton.
    assert.equal(isTurnFeatureActive(turn!.context, 'chat.later'), false)
  })

  await check('#1126 leállítás, finish_run: a következő lépésnél érthető üzenettel lezárul, nem hív tovább', async () => {
    let checks = 0
    const h = flagged('finish_run', twoSteps(), () => (++checks === 1 ? [{ key: FLAG, onStop: 'finish_run' }] : []))
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'succeeded')
    assert.equal(h.toolCalls.length, 0)
    assert.equal(h.llmMessages.length, 1)
    assert.ok(h.store.messages.at(-1)?.content.includes(MESSAGES.featureStopped))
    assert.equal(h.store.messages.at(-1)?.content.includes(FLAG), false)
    assert.equal(isTurnFeatureActive(turn!.context, FLAG), false)
  })

  await check('#1126 leállítás, old_path: a munka folytatódik, a flag a futás végéig Ki, újrakapcsolva sem jön vissza', async () => {
    const answers: Array<TurnFeatureFlag[]> = [[], [{ key: FLAG, onStop: 'old_path' }], [{ key: FLAG, onStop: 'old_path' }]]
    let checks = 0
    const h = flagged('old_path', twoSteps(), () => { checks++; return answers.shift() ?? [] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'succeeded')
    assert.equal(h.toolCalls.length, 1)
    assert.equal(h.store.messages.at(-1)?.content, 'Kész.')
    assert.deepEqual(turn?.context?.featureFlags?.stopped, [FLAG])
    assert.equal(isTurnFeatureActive(turn!.context, FLAG), false)
    assert.equal(checks, 1) // a leállított flaghez nincs több ellenőrző hívás
  })

  await check('#1126 a leállítás-ellenőrzés kiesésekor az utolsó ismert állapot marad, a munka megy tovább', async () => {
    const h = flagged('finish_run', twoSteps(), () => { throw new PlatformError('down', 503) })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'succeeded')
    assert.equal(h.store.messages.at(-1)?.content, 'Kész.')
    assert.equal(isTurnFeatureActive(turn!.context, FLAG), true)
  })

  await check('#1126 friss bekapcsolás: a türelmi időben a régi cache-ű példány üres válasza nem állítja le a futást', async () => {
    let elapsed = 0
    let checks = 0
    const h = flagged('finish_run', twoSteps(), () => (checks++, []), () => new Date(Date.now() + elapsed))
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    elapsed = 40_000
    assert.equal(await runStep(h.deps, { turnId: r.turn.id, seq: 0 }), 'done')
    assert.equal(checks, 0)
    assert.equal(isTurnFeatureActive((await h.store.getTurn(r.turn.id))!.context, FLAG), true)
    elapsed = 50_000
    assert.equal(await runStep(h.deps, { turnId: r.turn.id, seq: 1 }), 'done')
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(checks, 1)
    assert.equal(turn?.status, 'succeeded')
    assert.equal(h.toolCalls.length, 0)
    assert.ok(h.store.messages.at(-1)?.content.includes(MESSAGES.featureStopped))
  })

  await check('#1126 finish_run: ha a lezárás hibát dob, az újrapróbálás is lezár, nem fut tovább a munka', async () => {
    const h = flagged('finish_run', twoSteps(), () => [])
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    const addMessage = h.store.addMessage.bind(h.store)
    h.store.addMessage = async () => { throw new Error('db down') }
    await assert.rejects(runStep(h.deps, { turnId: r.turn.id, seq: 0 }))
    assert.deepEqual((await h.store.getTurn(r.turn.id))?.context?.featureFlags?.stopped, [FLAG])
    h.store.addMessage = addMessage
    assert.equal(await runStep(h.deps, { turnId: r.turn.id, seq: 0 }), 'done')
    assert.equal((await h.store.getTurn(r.turn.id))?.status, 'succeeded')
    assert.equal(h.llmMessages.length, 0)
    assert.equal(h.toolCalls.length, 0)
    assert.ok(h.store.messages.at(-1)?.content.includes(MESSAGES.featureStopped))
  })

  await check('#1126 a kérdésre adott válasz új tokent ad, de nem rögzít újra flaget', async () => {
    const h = flagged('old_path', { llm: [{ toolCalls: [{ id: 'q', name: 'ask_user', arguments: JSON.stringify(PETER) }] }, say('Kész.')], tool: [] }, () => [{ key: FLAG, onStop: 'old_path' }])
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    h.deps.platform.continuationToken = async () => ({ token: 'fresh', featureFlags: [{ key: 'chat.later', onStop: 'old_path' }] })
    assert.equal(await answerQuestion(h.deps, { turnId: r.turn.id, userId: USER, chatToken: 'chat', answer: { selected: ['Kovács Péter'] } }), 'ok')
    await h.drain()
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'succeeded')
    assert.deepEqual(turn?.context?.featureFlags?.pinned.map((flag) => flag.key), [FLAG])
  })

  await check('#1126 az el nem indult forduló flag-kontextusa nem írja felül az előző forduló betöltött eszközeit', async () => {
    const h = harness(twoSteps())
    const c = await h.conversation()
    const first = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(first.ok)
    await h.drain()
    h.deps.platform.continuationToken = async () => ({ token: 'turn-token', featureFlags: [{ key: FLAG, onStop: 'old_path' }] })
    const second = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'y', attachments: [] })
    assert.ok(second.ok)
    assert.ok(await cancelTurn(h.deps, second.turn.id, USER))
    h.queued.length = 0
    const previous = await h.store.lastTurnContext(c.id, 'none')
    assert.equal(previous?.flagsOnly, undefined)
    assert.ok(previous?.definition)
  })

  if (failures) {
    console.log(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nplatform-chat engine: all passed')
}

void main()
