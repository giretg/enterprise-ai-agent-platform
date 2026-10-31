/**
 * Forduló-motor (#1004 §5.2, §6.3, §6.5) — memóriabeli tár + hamis platform.
 * Futtatás: npx tsx test/engine.test.ts
 */
import assert from 'node:assert/strict'
import {
  APPROVAL_TTL_MS,
  cancelTurn,
  decideApproval,
  MESSAGES,
  planNext,
  runStep,
  startTurn,
  toFunctionName,
  toolDefinitions,
  type EngineDeps,
} from '../src/engine.ts'
import { summary, toolGroup } from '../src/tool-loading.ts'
import { BUDGET_BLOCK_REASON, PlatformError, type LlmResult, type McpCallResult, type PlatformClient } from '../src/platform.ts'
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
    continuationToken: async () => 'turn-token',
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
    limits: { maxSteps: opts.maxSteps ?? 25, maxTurnSeconds: 2400, maxAttemptsPerStep: 3, historyMessages: 30, toolResultChars: 1000 },
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

  await check('napi keret elfogyott: a forduló közérthető szöveggel failed', async () => {
    const h = harness({ llm: [{ content: 'A cég mai keretét erre a beszélgetésre már felhasználtuk.', blockReason: BUDGET_BLOCK_REASON }], tool: [] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    const turn = await h.store.getTurn(r.turn.id)
    assert.equal(turn?.status, 'failed')
    assert.match(String(turn?.error), /keretét/)
    assert.ok(h.store.events.some((e) => e.type === 'error' && e.payload.code === 'budget'))
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

  await check('lépés-limit és maxAttempts: közérthető failed', async () => {
    const h = harness({ llm: [callTool('google_drive.search', { q: '1' })], tool: [done('[]')] }, { maxSteps: 2 })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    await h.drain()
    assert.equal((await h.store.getTurn(r.turn.id))?.error, MESSAGES.tooManySteps)

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

  await check('elfogyott modell-kredit (402): azonnal failed, érthető üzenettel, nincs újrapróbálás', async () => {
    const h = harness({ llm: [new PlatformError('model gateway: 402 requires more credits', 402)], tool: [] })
    const c = await h.conversation()
    const r = await startTurn(h.deps, { conversation: c, chatToken: 'chat', content: 'x', attachments: [] })
    assert.ok(r.ok)
    assert.equal(await runStep(h.deps, h.queued.shift()!), 'done')
    assert.equal((await h.store.getTurn(r.turn.id))?.error, MESSAGES.creditExhausted)
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
  const names = (tools: unknown[]) => (tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
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

  if (failures) {
    console.log(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nplatform-chat engine: all passed')
}

void main()
