/**
 * Model Gateway proxy (#769) — DB- és hálózat-mentes tesztek (stub deps + hamis provider-fetch).
 * Futtatás: npm run test:model-gateway-proxy
 */
import assert from 'node:assert/strict'
import {
  handleChatCompletion,
  type GatewayPipelineHooks,
  type ModelCallEvent,
  type ModelGatewayDeps,
} from '../src/domain/model-gateway/proxy'
import type { ModelRef } from '../src/lib/model-policy'
import { createGatewayAuditSink, MAX_CONTENT_BYTES } from '../src/domain/ai-audit/ai-audit-service'

const TENANT = '22222222-2222-4222-8222-222222222222'
const USER = '11111111-1111-4111-8111-111111111111'
const AGENT = '33333333-3333-4333-8333-333333333333'
const A: ModelRef = { provider: 'openrouter', model: 'vendor/model-a' }
const B: ModelRef = { provider: 'openrouter', model: 'vendor/model-b' }
const C: ModelRef = { provider: 'ollama', model: 'gemma' }
let failures = 0

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${(e as Error).message}`)
  }
}

type Scripted = Response | Error | (() => Response)
function setup(opts: {
  scripts?: Scripted[]
  agent?: { primary: ModelRef; fallbacks?: ModelRef[]; temperature?: number }
  enabled?: ModelRef[]
  allowedModels?: string[] | null
  hooks?: GatewayPipelineHooks
  global?: ModelRef[]
  verifyOk?: boolean
  audit?: ModelGatewayDeps['audit']
}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
  const events: ModelCallEvent[] = []
  const scripts = [...(opts.scripts ?? [])]
  const deps: ModelGatewayDeps = {
    verify: async () =>
      opts.verifyOk === false
        ? { ok: false, code: 'invalid_token' }
        : ({
            ok: true,
            claims: { sub: USER, tenant: 'acme', agentId: AGENT, installId: 'inst', policyVersion: 'pv1', jti: 'j', iat: 0, exp: 9e9 },
            principal: { userId: USER, tenantId: TENANT, tenantSlug: 'acme', role: 'operator', assumed: false },
          } as never),
    loadAgentModelConfig: async () =>
      opts.agent ? { ...opts.agent.primary, fallbackModels: opts.agent.fallbacks ?? [], temperature: opts.agent.temperature } : null,
    getTenantPolicy: async () => ({ enabled: opts.enabled ?? [A, B, C] }),
    getGlobalFallbackChain: async () => opts.global ?? [],
    getAllowedModels: async () => opts.allowedModels ?? null,
    providers: (p) => (p === 'openrouter' ? { baseUrl: 'https://or.test/v1', apiKey: 'sk-test' } : p === 'ollama' ? { baseUrl: 'http://ollama.test/v1' } : null),
    audit: opts.audit ?? { record: async (e) => void events.push(e) },
    hooks: opts.hooks,
    maxAttempts: 3,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) })
      const next = scripts.shift()
      if (!next) throw new Error('nincs több szkriptelt válasz')
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next() : next
    }) as never,
  }
  const call = (body: unknown, headers: Record<string, string> = {}) =>
    handleChatCompletion(
      deps,
      new Request('https://app.test/api/model-gateway/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'x-excellence-session': 'sess-1', 'x-excellence-turn': 'turn-9', ...headers },
        body: JSON.stringify(body),
      }),
    )
  return { call, calls, events, deps }
}

const completion = (content: string, extra: object = {}) =>
  new Response(
    JSON.stringify({ model: 'x', choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    { status: 200 },
  )
const upstreamError = (status: number, message = 'boom') => new Response(JSON.stringify({ error: { message } }), { status })
const enc = new TextEncoder()
const sse = (...lines: string[]) => new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close() } }), { status: 200 })
const sseChunk = (delta: object, extra: object = {}) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }], ...extra })}\n\n`
const ask = { model: 'vendor/model-a', messages: [{ role: 'user', content: 'szia' }] }
const flush = () => new Promise((r) => setTimeout(r, 5))

async function main() {
  await check('audit-tároló hibája: sem normál, sem stream kérés nem indul a providernél', async () => {
    const s = setup({ agent: { primary: A }, audit: createGatewayAuditSink({
      depthFor: async () => 'metadata',
      store: { insertMany: async () => { throw new Error('database unavailable') }, list: async () => [], deleteExpired: async () => 0 },
    }) })
    for (const stream of [false, true]) {
      const res = await s.call({ ...ask, stream })
      assert.equal(res.status, 503)
      assert.equal((await res.json()).error.code, 'audit_unavailable')
    }
    assert.equal(s.calls.length, 0)
  })

  await check('nullás beszúrás sem igazolja a tartós auditot', async () => {
    const s = setup({ agent: { primary: A }, audit: createGatewayAuditSink({
      depthFor: async () => 'metadata',
      store: { insertMany: async () => 0, list: async () => [], deleteExpired: async () => 0 },
    }) })
    assert.equal((await s.call(ask)).status, 503)
    assert.equal(s.calls.length, 0)
  })

  await check('provider csak a kezdő audit-írás tartós befejezése után indul', async () => {
    let release!: () => void
    const persisted = new Promise<void>((resolve) => { release = resolve })
    let records = 0
    const s = setup({ agent: { primary: A }, scripts: [completion('ok')], audit: {
      record: async () => { if (++records === 1) await persisted },
    } })
    const pending = s.call(ask)
    await flush()
    assert.equal(s.calls.length, 0)
    release()
    assert.equal((await pending).status, 200)
    assert.equal(s.calls.length, 1)
    assert.equal(records, 2)
  })

  await check('sikertelen eredmény-audit: normál válasz 503, stream hibával zárul', async () => {
    for (const stream of [false, true]) {
      let records = 0
      const s = setup({ agent: { primary: A }, scripts: [stream ? sse(sseChunk({ content: 'fél' }), 'data: [DONE]\n\n') : completion('ok')], audit: {
        record: async () => { if (++records === 2) throw new Error('database unavailable') },
      } })
      const res = await s.call({ ...ask, stream })
      if (stream) await assert.rejects(res.text())
      else assert.equal(res.status, 503)
      assert.equal(s.calls.length, 1)
      assert.equal(records, 2)
    }
  })

  await check('a stream [DONE] jelzése megvárja az eredmény-audit tartós írását', async () => {
    let release!: () => void
    const persisted = new Promise<void>((resolve) => { release = resolve })
    let records = 0
    const s = setup({ agent: { primary: A }, scripts: [sse(sseChunk({ content: 'ok' }), 'data: [DONE]\n\n')], audit: {
      record: async () => { if (++records === 2) await persisted },
    } })
    const res = await s.call({ ...ask, stream: true })
    let complete = false
    const output = res.text().then((text) => { complete = true; return text })
    await flush()
    assert.equal(complete, false)
    release()
    assert.match(await output, /data: \[DONE\]/)
    assert.equal(records, 2)
  })

  await check('kliens megszakításakor az audit eredménye aborted', async () => {
    const open = new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(sseChunk({ content: 'fél' }))) } }), { status: 200 })
    const s = setup({ agent: { primary: A }, scripts: [open] })
    const res = await s.call({ ...ask, stream: true })
    await res.body!.cancel()
    assert.equal(s.events.at(-1)!.outcome, 'aborted')
    assert.equal(s.events[0].outcome, 'started')
    assert.equal(s.events[0].callId, s.events.at(-1)!.callId)
  })

  await check('fetch közbeni kliens-megszakítás nem indít tartalék modellt', async () => {
    const s = setup({ agent: { primary: A, fallbacks: [B] } })
    let providerCalls = 0
    s.deps.fetchImpl = (async (_url: string, init: RequestInit) => {
      providerCalls++
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as never
    const controller = new AbortController()
    const pending = handleChatCompletion(s.deps, new Request('https://app.test/x', {
      method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify(ask), signal: controller.signal,
    }))
    await flush()
    controller.abort()
    assert.equal((await pending).status, 499)
    assert.equal(providerCalls, 1)
    assert.deepEqual(s.events.map((e) => e.outcome), ['started', 'aborted'])
  })

  await check('nagy promptot a kötelező audit-méretkapu megállít a provider előtt', async () => {
    const outcomes: string[] = []
    const s = setup({ agent: { primary: A }, audit: createGatewayAuditSink({
      depthFor: async () => 'prompt_and_response',
      store: { insertMany: async (rows) => { outcomes.push(String(rows[0].meta.outcome)); return 1 }, list: async () => [], deleteExpired: async () => 0 },
    }) })
    const res = await s.call({ ...ask, messages: [{ role: 'user', content: 'x'.repeat(MAX_CONTENT_BYTES) }] })
    assert.equal(res.status, 413)
    assert.equal((await res.json()).error.code, 'audit_content_too_large')
    assert.equal(s.calls.length, 0)
    assert.deepEqual(outcomes, ['blocked'])
  })

  await check('túlméretes tartalomnaplózott válasz hibával zár, a kezdő audit megmarad', async () => {
    const large = 'x'.repeat(MAX_CONTENT_BYTES)
    const saved: ModelCallEvent[] = []
    const sink = createGatewayAuditSink({
      depthFor: async () => 'prompt_and_response',
      store: { insertMany: async () => 1, list: async () => [], deleteExpired: async () => 0 },
    })
    const audit: ModelGatewayDeps['audit'] = { record: async (e) => { await sink.record(e); saved.push(e) } }
    const plain = setup({ agent: { primary: A }, scripts: [completion(large)], audit })
    assert.equal((await plain.call(ask)).status, 413)
    assert.deepEqual(saved.map((e) => e.outcome), ['started', 'error'])
    assert.equal(saved[1].blockReason, 'audit_content_too_large')
    saved.length = 0
    const stream = setup({ agent: { primary: A }, scripts: [sse(sseChunk({ content: 'fél' }), sseChunk({ content: large }))], audit })
    const res = await stream.call({ ...ask, stream: true })
    await assert.rejects(res.text())
    assert.deepEqual(saved.map((e) => e.outcome), ['started', 'error'])
  })

  await check('metaadat-mélységnél a 256 KiB-os tartalomplafon nem korlátozza a választ', async () => {
    const audit = createGatewayAuditSink({
      depthFor: async () => 'metadata',
      store: { insertMany: async () => 1, list: async () => [], deleteExpired: async () => 0 },
    })
    const s = setup({ agent: { primary: A }, scripts: [completion('x'.repeat(MAX_CONTENT_BYTES))], audit })
    assert.equal((await s.call(ask)).status, 200)
    assert.equal(s.calls.length, 1)
  })

  await check('a 16 MiB-os provider-válaszplafon a beolvasás közben megállítja a választ', async () => {
    const huge = new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('x'.repeat(16 * 1024 * 1024 + 1))); c.close() } }), { status: 200 })
    const s = setup({ agent: { primary: A }, scripts: [huge] })
    assert.equal((await s.call(ask)).status, 502)
    assert.deepEqual(s.events.map((e) => e.outcome), ['started', 'error'])
  })

  await check('lejárt/hibás token → 401, provider nem hívódik', async () => {
    const s = setup({ verifyOk: false, agent: { primary: A } })
    const res = await s.call(ask)
    assert.equal(res.status, 401)
    assert.equal(s.calls.length, 0)
  })

  await check('hibás kérés (nincs messages) → 400', async () => {
    const s = setup({ agent: { primary: A } })
    assert.equal((await s.call({ model: 'x' })).status, 400)
  })

  await check('D12: engedett kért modell fut; a céges kulcs a gateway-é, nem a klienséé', async () => {
    const s = setup({ agent: { primary: A }, scripts: [completion('szép')] })
    const res = await s.call({ ...ask, model: 'openrouter/vendor/model-b' }, { 'x-excellence-agent-id': 'masik-agent' })
    assert.equal(res.status, 200)
    assert.equal(s.calls[0].body.model, 'vendor/model-b')
    assert.equal(s.calls[0].headers.authorization, 'Bearer sk-test')
    await flush()
    assert.equal(s.events.at(-1)!.model, 'openrouter/vendor/model-b')
    assert.equal(s.events.at(-1)!.substituted, false)
    assert.equal(s.events.at(-1)!.agentId, AGENT) // a tokenből, nem headerből (D1)
    assert.equal(s.events.at(-1)!.sessionId, 'sess-1')
    assert.equal(s.events.at(-1)!.turnId, 'turn-9')
    assert.deepEqual(s.events.at(-1)!.usage, { promptTokens: 7, completionTokens: 3 })
  })

  await check('D12: nem engedett (user-szűkítés) modellnél az agent modellje fut, a helyettesítés naplózva', async () => {
    const s = setup({ agent: { primary: A }, allowedModels: ['openrouter/vendor/model-a'], scripts: [completion('ok')] })
    await s.call({ ...ask, model: 'vendor/model-b' })
    assert.equal(s.calls[0].body.model, 'vendor/model-a')
    await flush()
    assert.equal(s.events.at(-1)!.substituted, true)
    assert.equal(s.events.at(-1)!.requestedModel, 'vendor/model-b')
  })

  await check('D12: a tenant listáján nem szereplő modell sem fut', async () => {
    const s = setup({ agent: { primary: A }, enabled: [A], scripts: [completion('ok')] })
    await s.call({ ...ask, model: 'evil/unlisted' })
    assert.equal(s.calls[0].body.model, 'vendor/model-a')
  })

  await check('tool-hívások oda-vissza: tools, tool üzenetek, párhuzamos hívás érintetlen; policy-megkerülő mezők kiesnek', async () => {
    const toolCalls = [
      { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
      { id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } },
    ]
    const s = setup({ agent: { primary: A }, scripts: [completion('', { tool_calls: toolCalls })] })
    const messages = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: null, tool_calls: [toolCalls[0]] },
      { role: 'tool', tool_call_id: 'c1', content: 'eredmény' },
    ]
    const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }]
    const res = await s.call({ ...ask, messages, tools, tool_choice: 'auto', parallel_tool_calls: true, models: ['evil/x'], provider: { order: ['x'] }, route: 'fallback' })
    assert.deepEqual(s.calls[0].body.messages, messages)
    assert.deepEqual(s.calls[0].body.tools, tools)
    assert.equal(s.calls[0].body.parallel_tool_calls, true)
    for (const k of ['models', 'provider', 'route']) assert.equal(k in s.calls[0].body, false, k)
    const out = await res.json()
    assert.deepEqual(out.choices[0].message.tool_calls, toolCalls)
    await flush()
    assert.equal(s.events.at(-1)!.response?.toolCalls.length, 2)
  })

  await check('streamelés: SSE bájt-azonosan átmegy, a tool_calls delta és a usage az auditba gyűlik', async () => {
    const lines = [
      ': OPENROUTER PROCESSING\n\n',
      sseChunk({ role: 'assistant', content: 'Sz' }),
      sseChunk({ content: 'ia', tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a"' } }] }),
      sseChunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
      sseChunk({}, { usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      'data: [DONE]\n\n',
    ]
    const s = setup({ agent: { primary: A }, scripts: [sse(...lines)] })
    const res = await s.call({ ...ask, stream: true })
    assert.match(res.headers.get('content-type')!, /text\/event-stream/)
    assert.equal(await res.text(), lines.join(''))
    assert.deepEqual(s.calls[0].body.stream_options, { include_usage: true })
    await flush()
    const e = s.events.at(-1)!
    assert.equal(e.outcome, 'ok')
    assert.equal(e.response?.content, 'Szia')
    assert.deepEqual(e.response?.toolCalls, [{ id: 'c1', name: 'f', arguments: '{"a":1}' }])
    assert.deepEqual(e.usage, { promptTokens: 5, completionTokens: 2 })
    assert.equal(e.providerResponse, lines.join(''))
  })

  await check('nem-stream válasz minden choice/reasoning mezője a tartalom-auditba kerül', async () => {
    const raw = { choices: [
      { message: { content: 'első', reasoning: 'magyarázat' }, finish_reason: 'stop' },
      { message: { content: 'második' }, finish_reason: 'stop' },
    ] }
    const s = setup({ agent: { primary: A }, scripts: [new Response(JSON.stringify(raw), { status: 200 })] })
    assert.equal((await s.call(ask)).status, 200)
    assert.deepEqual(s.events.at(-1)!.providerResponse, raw)
  })

  await check('[DONE] nélküli stream hálózati hibának számít, nem sikeres válasznak', async () => {
    const s = setup({ agent: { primary: A }, scripts: [sse(sseChunk({ content: 'fél' }))] })
    const res = await s.call({ ...ask, stream: true })
    await assert.rejects(res.text(), /before \[DONE\]/)
    assert.deepEqual(s.events.map((e) => e.outcome), ['started', 'error'])
  })

  await check('tartalék: provider-hiba (503) az első token előtt → következő jelölt, a váltás auditálva', async () => {
    const s = setup({ agent: { primary: A, fallbacks: [B] }, scripts: [upstreamError(503), completion('tartalék')] })
    const res = await s.call(ask)
    assert.equal((await res.json()).choices[0].message.content, 'tartalék')
    assert.equal(s.calls[1].body.model, 'vendor/model-b')
    await flush()
    assert.deepEqual(s.events.at(-1)!.failedCandidates, [{ model: 'openrouter/vendor/model-a', errorClass: 'provider_unavailable' }])
    assert.equal(s.events.at(-1)!.model, 'openrouter/vendor/model-b')
  })

  await check('tartalék: nem bekötött provider kimarad, a következő válaszol', async () => {
    const s = setup({ agent: { primary: { provider: 'gemini', model: 'g' }, fallbacks: [B] }, enabled: [{ provider: 'gemini', model: 'g' }, B], scripts: [completion('b')] })
    assert.equal((await s.call({ messages: ask.messages })).status, 200)
    assert.equal(s.calls.length, 1)
    assert.equal(s.calls[0].body.model, 'vendor/model-b')
  })

  await check('tartalék streamnél: 200 + hibás első adat-sor (OpenRouter {error}) még váltható', async () => {
    const s = setup({
      agent: { primary: A, fallbacks: [B] },
      scripts: [sse('data: {"error":{"code":503,"message":"upstream"}}\n\n'), sse(sseChunk({ content: 'jó' }), 'data: [DONE]\n\n')],
    })
    const res = await s.call({ ...ask, stream: true })
    assert.match(await res.text(), /jó/)
    assert.equal(s.calls.length, 2)
  })

  await check('az első token UTÁN nincs váltás: a stream megszakad, nincs második hívás', async () => {
    let n = 0
    const broken = new Response(
      new ReadableStream({
        pull(c) {
          if (n++ === 0) c.enqueue(enc.encode(sseChunk({ content: 'fél' })))
          else c.error(new Error('socket hang up'))
        },
      }),
      { status: 200 },
    )
    const s = setup({ agent: { primary: A, fallbacks: [B] }, scripts: [broken, completion('nem szabad')] })
    const res = await s.call({ ...ask, stream: true })
    await assert.rejects(res.text())
    assert.equal(s.calls.length, 1)
    await flush()
    assert.equal(s.events.at(-1)!.outcome, 'error')
  })

  await check('nem váltó hiba (400 túl hosszú kontextus) → változatlanul vissza, nincs tartalék', async () => {
    const s = setup({ agent: { primary: A, fallbacks: [B] }, scripts: [upstreamError(400, 'maximum context length')] })
    const res = await s.call(ask)
    assert.equal(res.status, 400)
    assert.match(await res.text(), /maximum context/)
    assert.equal(s.calls.length, 1)
    assert.match(String(s.events.at(-1)!.providerResponse), /maximum context/)
  })

  await check('lánc kimerül: 502, rate limit: 429', async () => {
    const a = setup({ agent: { primary: A, fallbacks: [B] }, scripts: [upstreamError(503), upstreamError(502)] })
    assert.equal((await a.call(ask)).status, 502)
    const b = setup({ agent: { primary: A }, scripts: [upstreamError(429)] })
    assert.equal((await b.call(ask)).status, 429)
  })

  await check('blokk (szűrő) → HTTP 200 asszisztens-üzenet, nincs provider-hívás; stream-formátum is', async () => {
    const hooks: GatewayPipelineHooks = { filterRequest: async () => ({ block: 'Ezt nem küldhetem el: bankkártyaszám van benne.', reason: 'pan' }) }
    const s = setup({ agent: { primary: A }, hooks })
    const res = await s.call(ask)
    assert.equal(res.status, 200)
    const out = await res.json()
    assert.equal(out.choices[0].message.role, 'assistant')
    assert.match(out.choices[0].message.content, /bankkártyaszám/)
    const st = await s.call({ ...ask, stream: true })
    assert.equal(st.status, 200)
    const text = await st.text()
    assert.match(text, /bankkártyaszám/)
    assert.ok(text.trim().endsWith('data: [DONE]'))
    assert.equal(s.calls.length, 0)
    await flush()
    assert.equal(s.events.at(-1)!.outcome, 'blocked')
    assert.equal(s.events.at(-1)!.blockReason, 'pan')
  })

  await check('Managed/Open kapu: gate blokkol → 200 üzenet', async () => {
    const s = setup({ agent: { primary: A }, hooks: { gate: async () => ({ block: 'Nyílt módban nincs céges modell.', reason: 'open_mode' }) } })
    const out = await (await s.call(ask)).json()
    assert.match(out.choices[0].message.content, /Nyílt/)
    assert.equal(s.calls.length, 0)
  })

  await check('nincs engedett modell → 200 hétköznapi üzenet (nem 4xx)', async () => {
    const s = setup({ agent: { primary: A }, enabled: [] })
    const res = await s.call(ask)
    assert.equal(res.status, 200)
    assert.match((await res.json()).choices[0].message.content, /nincs engedélyezett modell/)
  })

  await check('a szűrő átírhatja a kérést; a válasz-visszaállító a kimeneten fut (stream és nem-stream)', async () => {
    const hooks: GatewayPipelineHooks = {
      filterRequest: async (_c, body) => ({ body: { ...body, messages: [{ role: 'user', content: '[TOKEN_1]' }] } }),
      transformResponse: () =>
        new TransformStream({ transform: (chunk, c) => c.enqueue(enc.encode(new TextDecoder().decode(chunk).replaceAll('[TOKEN_1]', 'Kiss János'))) }),
    }
    const s = setup({ agent: { primary: A }, hooks, scripts: [completion('Szia [TOKEN_1]'), sse(sseChunk({ content: '[TOKEN_1]' }), 'data: [DONE]\n\n')] })
    const plain = await s.call(ask)
    assert.deepEqual(s.calls[0].body.messages, [{ role: 'user', content: '[TOKEN_1]' }])
    assert.match((await plain.json()).choices[0].message.content, /Kiss János/)
    assert.match(await (await s.call({ ...ask, stream: true })).text(), /Kiss János/)
  })

  await check('agent temperature/max_tokens alapérték, a kliensé erősebb', async () => {
    const s = setup({ agent: { primary: A, temperature: 0.2 }, scripts: [completion('a'), completion('b')] })
    await s.call(ask)
    await s.call({ ...ask, temperature: 0.9 })
    assert.equal(s.calls[0].body.temperature, 0.2)
    assert.equal(s.calls[1].body.temperature, 0.9)
  })

  if (failures) {
    console.error(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nminden teszt ok')
}

void main()
