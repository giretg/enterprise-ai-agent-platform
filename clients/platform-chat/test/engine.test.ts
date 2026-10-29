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
  type EngineDeps,
} from '../src/engine.ts'
import { BUDGET_BLOCK_REASON, PlatformError, type LlmResult, type McpCallResult, type PlatformClient } from '../src/platform.ts'
import type { Conversation } from '../src/store.ts'
import { MemoryStore } from './memory-store.ts'

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

function harness(script: Script, opts: { now?: () => Date; maxSteps?: number } = {}) {
  const store = new MemoryStore()
  const queued: Array<{ turnId: string; seq: number }> = []
  const toolCalls: Array<{ name: string; args: Record<string, unknown>; approval?: unknown }> = []
  const llmMessages: unknown[][] = []
  const platform: PlatformClient = {
    continuationToken: async () => 'turn-token',
    listAgents: async () => [],
    getDefinition: async () => '{"definitionId":"def-1","briefing":"Drive-asszisztens"}',
    listTools: async () => [
      { name: 'google_drive.search', description: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'google_drive_create_folder', inputSchema: { type: 'object', properties: { name: {}, idempotencyKey: {} } } },
      { name: 'platform.agent.publish', inputSchema: { type: 'object' } },
    ],
    callTool: async (input) => {
      toolCalls.push({ name: input.name, args: input.args, approval: input.approval })
      const next = script.tool.shift()
      if (!next) throw new Error('unexpected tool call')
      if (next instanceof Error) throw next
      return next
    },
    streamCompletion: async (input) => {
      llmMessages.push(input.messages)
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
    ...(opts.now ? { now: opts.now } : {}),
  }
  /** A sor kiürítése: amit a motor besorolt, sorban lefuttatjuk (mint a Cloud Tasks). */
  async function drain(max = 50) {
    for (let i = 0; i < max && queued.length; i++) await runStep(deps, queued.shift()!)
  }
  async function conversation(): Promise<Conversation> {
    return store.createConversation({ tenantId: TENANT, tenantSlug: 'acme', userId: USER, agentId: AGENT, agentName: 'Drive' })
  }
  return { store, deps, queued, toolCalls, llmMessages, drain, conversation }
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

  if (failures) {
    console.log(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nplatform-chat engine: all passed')
}

void main()
