/**
 * Közvetlen OpenAI provider: tenant-kulcs, Chat Completions ↔ Responses fordítás, gateway-út.
 * DB- és hálózat-mentes. Futtatás: npm run test:openai-provider
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chatToResponsesRequest,
  responsesJsonToChat,
  responsesSseToChatSse,
} from '../src/domain/model-gateway/openai-responses'
import {
  envProviderRegistry,
  handleChatCompletion,
  type ModelCallEvent,
  type ModelGatewayDeps,
} from '../src/domain/model-gateway/proxy'
import { createPublicModelCaller, defaultPublicModel } from '../src/domain/public-chat/model-client'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import { parseModelRefs, type ModelRef } from '../src/lib/model-policy'
import {
  loadOpenAiTenantKey,
  openAiSecretId,
  parseOpenAiApiKey,
  saveOpenAiTenantKey,
} from '../src/lib/openai-tenant-key'

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const KEY_A = 'sk-proj-tenantAkeyaaaaaaaaaaaaaaaaaa'
const USER = '11111111-1111-4111-8111-111111111111'
const AGENT = '33333333-3333-4333-8333-333333333333'
const SOL: ModelRef = { provider: 'openai', model: 'gpt-6.1-sol' }
const OR: ModelRef = { provider: 'openrouter', model: 'vendor/model-a' }

let failures = 0

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${(e as Error).message}`)
  }
}

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const encoder = new TextEncoder()
const sseEvent = (event: Json) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const sseBody = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
const sseResponse = (...events: Json[]) => new Response(sseBody(...events.map(sseEvent)), { status: 200 })

/** A kimenő SSE `data:` sorai: JSON-ként, a `[DONE]` szövegként. */
async function dataLines(res: Response | ReadableStream<Uint8Array>): Promise<Array<Json | string>> {
  const text = await new Response(res instanceof Response ? res.body : res).text()
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .map((d) => (d === '[DONE]' ? d : JSON.parse(d)))
}

const translate = (model: string, ...parts: string[]) =>
  dataLines(sseBody(...parts).pipeThrough(responsesSseToChatSse(model)))

const created = { type: 'response.created', response: { id: 'resp_1', model: 'gpt-6.1-sol', created_at: 1700 } }
const textDelta = (delta: string) => ({ type: 'response.output_text.delta', output_index: 0, delta })
const completed = (extra: Json = {}) => ({
  type: 'response.completed',
  response: {
    id: 'resp_1',
    model: 'gpt-6.1-sol',
    status: 'completed',
    usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100, input_tokens_details: { cached_tokens: 400 } },
    ...extra,
  },
})

function gatewaySetup(opts: { scripts: Array<Response | Error>; enabled?: ModelRef[]; primary?: ModelRef; maxTokens?: number }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Json }> = []
  const events: ModelCallEvent[] = []
  const scripts = [...opts.scripts]
  const deps: ModelGatewayDeps = {
    verify: async () =>
      ({
        ok: true,
        claims: { sub: USER, tenant: 'acme', agentId: AGENT, installId: 'inst', policyVersion: 'pv1', jti: 'j', iat: 0, exp: 9e9 },
        principal: { userId: USER, tenantId: TENANT_A, tenantSlug: 'acme', role: 'operator', assumed: false },
      }) as never,
    loadAgentModelConfig: async () => ({
      ...(opts.primary ?? SOL),
      fallbackModels: [],
      temperature: 0.7,
      maxTokens: opts.maxTokens ?? 4096,
    }),
    getTenantPolicy: async () => ({ enabled: opts.enabled ?? [SOL, OR] }),
    getGlobalFallbackChain: async () => [OR],
    getAllowedModels: async () => null,
    providers: envProviderRegistry(
      {},
      async () => 'sk-or-v1-routerkeyrouterkeyrouterkey',
      async () => null,
      async () => KEY_A,
    ),
    audit: { record: async (e) => void events.push(e) },
    maxAttempts: 3,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) })
      const next = scripts.shift()
      if (!next) throw new Error('nincs több szkriptelt válasz')
      if (next instanceof Error) throw next
      return next
    }) as never,
  }
  const call = (body: unknown) =>
    handleChatCompletion(
      deps,
      new Request('https://app.test/api/model-gateway/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer t' },
        body: JSON.stringify(body),
      }),
    )
  return { call, calls, events }
}

async function main() {
  // --- Kulcs ---
  await check('a kulcs a connector-key-openai-<tenantId> titokba kerül', () => {
    assert.equal(openAiSecretId(TENANT_A), `openai-${TENANT_A}`)
  })

  await check('formátum: OpenAI-kulcsok elfogadva, idegen kulcs és szemét elutasítva', () => {
    assert.equal(parseOpenAiApiKey(`  ${KEY_A} `), KEY_A)
    assert.ok(parseOpenAiApiKey('sk-svcacct-abcdefghijklmnopqrstuvwxyz'))
    assert.ok(parseOpenAiApiKey('sk-abcdefghijklmnopqrstuvwxyz012345'))
    for (const bad of [
      'sk-or-v1-abcdefghijklmnopqrstuvwxyz',
      'sk-ant-abcdefghijklmnopqrstuvwxyz',
      'sk-admin-abcdefghijklmnopqrstuvwxyz',
      'AIzaSyabcdefghijklmnopqrstuvwxyz',
      'sk-rovid',
      `sk-${'a'.repeat(600)}`,
      'sk-van benne szokoz aaaaaaaaaaaaaaaaaaaaaa',
      '',
      null,
    ]) {
      assert.throws(() => parseOpenAiApiKey(bad), /invalid_openai_key/, String(bad))
    }
  })

  await check('tenantonként külön titok; nincs kulcs → null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openai-key-'))
    const previousDir = process.env.CONNECTOR_SECRET_DIR
    const previousPrefix = process.env.CONNECTOR_SECRET_PREFIX
    process.env.CONNECTOR_SECRET_DIR = dir
    delete process.env.CONNECTOR_SECRET_PREFIX
    try {
      await saveOpenAiTenantKey(TENANT_A, KEY_A)
      assert.equal(await loadOpenAiTenantKey(TENANT_A), KEY_A)
      assert.equal(await loadOpenAiTenantKey(TENANT_B), null)
    } finally {
      if (previousDir === undefined) delete process.env.CONNECTOR_SECRET_DIR
      else process.env.CONNECTOR_SECRET_DIR = previousDir
      if (previousPrefix !== undefined) process.env.CONNECTOR_SECRET_PREFIX = previousPrefix
      await rm(dir, { recursive: true, force: true })
    }
  })

  await check('a kulcsmentés auditeseménye regisztrált', () => {
    assertAuditActionRegistered('model.openai_key.set')
  })

  await check('registry: tenant-kulcs + Responses; a platform env-kulcsa nem pótolja', async () => {
    const withKey = envProviderRegistry({}, async () => null, async () => null, async () => KEY_A)
    assert.deepEqual(await withKey('openai', TENANT_A), {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: KEY_A,
      wireApi: 'responses',
    })
    const noKey = envProviderRegistry({ OPENAI_API_KEY: 'sk-platformplatformplatformplatform' }, async () => null, async () => null, async () => null)
    assert.equal(await noKey('openai', TENANT_A), null)
  })

  await check('az openai modell átmegy a policy-parse-on (a régi OAuth-id-k nem)', () => {
    assert.deepEqual(parseModelRefs([SOL, { provider: 'chatgpt-oauth', model: 'gpt-5.5' }]), [SOL])
  })

  // --- Kérés-fordítás ---
  await check('üzenetek: system→developer, kép, eszközhívás és eredmény', () => {
    const out = chatToResponsesRequest({
      model: 'gpt-6.1-sol',
      stream: true,
      messages: [
        { role: 'system', content: 'Légy tömör.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Mi ez?', cache_control: { type: 'ephemeral' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA', detail: 'low' } },
          ],
        },
        {
          role: 'assistant',
          content: 'Megnézem.',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'kb_search', arguments: '{"q":"x"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'találat' },
      ],
    })
    assert.deepEqual(out.input, [
      { role: 'developer', content: 'Légy tömör.' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Mi ez?' },
          { type: 'input_image', image_url: 'data:image/png;base64,AA', detail: 'low' },
        ],
      },
      { role: 'assistant', content: 'Megnézem.' },
      { type: 'function_call', call_id: 'call_1', name: 'kb_search', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'találat' },
    ])
    assert.equal(out.store, false)
    assert.equal(out.stream, true)
    assert.equal('messages' in out, false)
  })

  await check('más providertől örökölt hosszú call-id mindkét oldalon ugyanúgy rövidül', () => {
    const long = `function-call-${'x'.repeat(80)}-end`
    const input = chatToResponsesRequest({
      model: 'm',
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: long, function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: long, content: 'ok' },
      ],
    }).input as Json[]
    assert.equal(input.length, 2)
    assert.equal(input[0].call_id.length, 64)
    assert.equal(input[0].call_id, input[1].call_id)
  })

  await check('eszközök: lapos alak, nem szigorú alapból, tool_choice átfordítva', () => {
    const out = chatToResponsesRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { type: 'function', function: { name: 'a', description: 'd', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'b', parameters: {}, strict: true } },
      ],
      tool_choice: { type: 'function', function: { name: 'a' } },
      parallel_tool_calls: false,
    })
    assert.deepEqual(out.tools, [
      { type: 'function', name: 'a', description: 'd', parameters: { type: 'object' }, strict: false },
      { type: 'function', name: 'b', description: undefined, parameters: {}, strict: true },
    ])
    assert.deepEqual(out.tool_choice, { type: 'function', name: 'a' })
    assert.equal(out.parallel_tool_calls, false)
  })

  await check('tool_choice eszközök nélkül nem megy ki (400 lenne)', () => {
    const out = chatToResponsesRequest({ model: 'm', messages: [], tool_choice: 'auto' })
    assert.equal('tool_choice' in out, false)
  })

  await check('gondolkodó modellnél temperature/top_p kimarad; effort none-nál megmarad', () => {
    const base = { messages: [{ role: 'user', content: 'x' }], temperature: 0.7, top_p: 0.9 }
    const thinking = chatToResponsesRequest({ ...base, model: 'gpt-6.1-sol' })
    assert.equal('temperature' in thinking, false)
    assert.equal('top_p' in thinking, false)
    const none = chatToResponsesRequest({ ...base, model: 'gpt-6-luna', reasoning_effort: 'none' })
    assert.equal(none.temperature, 0.7)
    assert.equal(none.top_p, 0.9)
    assert.deepEqual(none.reasoning, { effort: 'none' })
  })

  await check('effort: minimal→low, none Astra/Sol-on→low, OpenRouter-alakú reasoning is', () => {
    const effort = (model: string, extra: Json) =>
      (chatToResponsesRequest({ model, messages: [], ...extra }).reasoning as Json | undefined)?.effort
    assert.equal(effort('gpt-6.1-terra', { reasoning_effort: 'minimal' }), 'low')
    assert.equal(effort('gpt-6-astra', { reasoning_effort: 'none' }), 'low')
    assert.equal(effort('gpt-6.1-sol', { reasoning_effort: 'none' }), 'low')
    assert.equal(effort('gpt-6.1-terra', { reasoning_effort: 'none' }), 'none')
    assert.equal(effort('gpt-6.1-sol', { reasoning: { effort: 'high', exclude: true } }), 'high')
    assert.equal(effort('gpt-6.1-sol', {}), undefined)
  })

  await check('tokenkeret: gondolkodási tartalék, alsó és felső korlát', () => {
    const max = (extra: Json) => chatToResponsesRequest({ model: 'm', messages: [], ...extra }).max_output_tokens
    assert.equal(max({ max_tokens: 4096 }), 29_096)
    assert.equal(max({ max_completion_tokens: 1000, max_tokens: 9 }), 26_000)
    assert.equal(max({ max_tokens: 1, reasoning_effort: 'none' }), 16)
    assert.equal(max({ max_tokens: 500_000 }), 128_000)
    assert.equal(max({}), undefined)
  })

  await check('response_format → text.format, kliensoldali mezők nem szivárognak ki', () => {
    const schema = { type: 'json_schema', json_schema: { name: 'n', schema: { type: 'object' }, strict: true } }
    const out = chatToResponsesRequest({
      model: 'm',
      messages: [],
      response_format: schema,
      stream_options: { include_usage: true },
      usage: { include: true },
      stop: ['x'],
      seed: 1,
    })
    assert.deepEqual(out.text, { format: { type: 'json_schema', name: 'n', schema: { type: 'object' }, strict: true } })
    for (const key of ['stream_options', 'usage', 'stop', 'seed', 'response_format', 'max_tokens']) {
      assert.equal(key in out, false, key)
    }
    assert.deepEqual(chatToResponsesRequest({ model: 'm', messages: [], response_format: { type: 'json_object' } }).text, {
      format: { type: 'json_object' },
    })
  })

  // --- Nem-stream válasz ---
  await check('JSON-válasz: szöveg, eszközhívás, usage és költség', () => {
    const out = responsesJsonToChat(
      {
        id: 'resp_1',
        model: 'gpt-6.1-sol',
        created_at: 1700,
        status: 'completed',
        output: [
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'titok' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Szia' }] },
          { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"a":1}' },
        ],
        usage: {
          input_tokens: 1000,
          output_tokens: 100,
          total_tokens: 1100,
          input_tokens_details: { cached_tokens: 400 },
          output_tokens_details: { reasoning_tokens: 60 },
        },
      },
      'gpt-6.1-sol',
    ) as Json
    assert.equal(out.object, 'chat.completion')
    assert.equal(out.choices[0].message.content, 'Szia')
    assert.deepEqual(out.choices[0].message.tool_calls, [
      { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
    ])
    assert.equal(out.choices[0].finish_reason, 'tool_calls')
    assert.equal(out.usage.prompt_tokens, 1000)
    assert.equal(out.usage.completion_tokens, 100)
    assert.equal(out.usage.prompt_tokens_details.cached_tokens, 400)
    assert.equal(out.usage.completion_tokens_details.reasoning_tokens, 60)
    // 600 × $2 + 400 × $0,10 + 100 × $10, millió tokenenként
    assert.ok(Math.abs(out.usage.cost - 0.00224) < 1e-9, String(out.usage.cost))
    assert.equal(JSON.stringify(out).includes('titok'), false)
  })

  await check('JSON-válasz: elutasítás látszik, csonkolás length, hiba {error}, ismeretlen modell költség nélkül', () => {
    const refusal = responsesJsonToChat(
      { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Ebben nem segíthetek.' }] }] },
      'm',
    ) as Json
    assert.equal(refusal.choices[0].message.content, 'Ebben nem segíthetek.')
    const cut = responsesJsonToChat(
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
      'm',
    ) as Json
    assert.equal(cut.choices[0].finish_reason, 'length')
    assert.equal(cut.choices[0].message.content, null)
    const filtered = responsesJsonToChat({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'm') as Json
    assert.equal(filtered.choices[0].finish_reason, 'content_filter')
    assert.deepEqual(responsesJsonToChat({ status: 'failed', error: { code: 'server_error', message: 'x' } }, 'm'), {
      error: { code: 'server_error', message: 'x' },
    })
    const unknown = responsesJsonToChat({ status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 5 } }, 'gpt-9') as Json
    assert.equal('cost' in unknown.usage, false)
  })

  // --- Stream ---
  await check('SSE: a response.created nem indít kimenetet; szöveg, záró chunk, usage, [DONE]', async () => {
    const lines = await translate('gpt-6.1-sol', sseEvent(created), sseEvent(textDelta('Sz')), sseEvent(textDelta('ia')), sseEvent(completed()))
    const [first, second, finish, usage, done] = lines as Json[]
    assert.equal(lines.length, 5)
    assert.deepEqual(first.choices[0].delta, { role: 'assistant', content: 'Sz' })
    assert.equal(first.id, 'resp_1')
    assert.equal(first.object, 'chat.completion.chunk')
    assert.deepEqual(second.choices[0].delta, { content: 'ia' })
    assert.equal(finish.choices[0].finish_reason, 'stop')
    assert.deepEqual(usage.choices, [])
    assert.equal(usage.usage.prompt_tokens, 1000)
    assert.equal(typeof usage.usage.cost, 'number')
    assert.equal(done, '[DONE]')
  })

  await check('SSE: párhuzamos eszközhívások sorszáma 0-tól folyamatos, az üzenet utáni output_index-szel is', async () => {
    const lines = (await translate(
      'm',
      sseEvent(created),
      sseEvent({ type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', id: 'rs' } }),
      sseEvent({ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'c1', name: 'a' } }),
      sseEvent({ type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"x"' }),
      sseEvent({ type: 'response.function_call_arguments.delta', output_index: 2, delta: ':1}' }),
      sseEvent({ type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"x":1}' }),
      sseEvent({ type: 'response.output_item.added', output_index: 3, item: { type: 'function_call', call_id: 'c2', name: 'b' } }),
      sseEvent({ type: 'response.function_call_arguments.done', output_index: 3, arguments: '{"y":2}' }),
      sseEvent(completed()),
    )) as Json[]
    const calls = lines.filter((l) => l.choices?.[0]?.delta?.tool_calls).map((l) => l.choices[0].delta.tool_calls[0])
    assert.deepEqual(calls, [
      { index: 0, id: 'c1', type: 'function', function: { name: 'a', arguments: '' } },
      { index: 0, function: { arguments: '{"x"' } },
      { index: 0, function: { arguments: ':1}' } },
      { index: 1, id: 'c2', type: 'function', function: { name: 'b', arguments: '' } },
      { index: 1, function: { arguments: '{"y":2}' } },
    ])
    assert.equal(lines.find((l) => l.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls')
  })

  await check('SSE: hálózati darabolás nem számít (többbájtos karakter, sor közepe)', async () => {
    const whole = encoder.encode(sseEvent(created) + sseEvent(textDelta('árvíztűrő')) + sseEvent(completed()))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < whole.length; i += 7) controller.enqueue(whole.slice(i, i + 7))
        controller.close()
      },
    })
    const lines = (await dataLines(body.pipeThrough(responsesSseToChatSse('m')))) as Json[]
    assert.equal(lines[0].choices[0].delta.content, 'árvíztűrő')
    assert.equal(lines.at(-1), '[DONE]')
  })

  await check('SSE: csonkolás length, hiba {error}-chunk, lezárás nélküli stream is hiba', async () => {
    const cut = (await translate('m', sseEvent(textDelta('x')), sseEvent({
      type: 'response.incomplete',
      response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    }))) as Json[]
    assert.equal(cut[1].choices[0].finish_reason, 'length')
    const failed = (await translate('m', sseEvent(created), sseEvent({
      type: 'response.failed',
      response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'lassíts' } },
    }))) as Json[]
    assert.deepEqual(failed[0], { error: { code: 'rate_limit_exceeded', message: 'lassíts' } })
    const errorEvent = (await translate('m', sseEvent({ type: 'error', code: 'server_error', message: 'hiba' }))) as Json[]
    assert.deepEqual(errorEvent[0], { error: { code: 'server_error', message: 'hiba' } })
    const open = (await translate('m', sseEvent(textDelta('félbe')))) as Json[]
    assert.equal(open[1].error?.code, 'stream_incomplete')
  })

  // --- Gateway ---
  await check('gateway stream: /responses + Bearer kulcs, a kliens chat-SSE-t kap, az audit látja a választ', async () => {
    const s = gatewaySetup({ scripts: [sseResponse(created, textDelta('Szia'), completed())] })
    const res = await s.call({ messages: [{ role: 'user', content: 'x' }], stream: true })
    const lines = (await dataLines(res)) as Json[]
    assert.equal(res.status, 200)
    assert.equal(s.calls[0].url, 'https://api.openai.com/v1/responses')
    assert.equal(s.calls[0].headers.authorization, `Bearer ${KEY_A}`)
    const sent = s.calls[0].body
    assert.equal(sent.model, 'gpt-6.1-sol')
    assert.equal(sent.store, false)
    assert.equal(sent.max_output_tokens, 29_096)
    for (const key of ['temperature', 'max_tokens', 'stream_options', 'messages']) assert.equal(key in sent, false, key)
    assert.equal(lines[0].choices[0].delta.content, 'Szia')
    await new Promise((r) => setImmediate(r))
    const event = s.events[0]
    assert.equal(event.outcome, 'ok')
    assert.equal(event.model, 'openai/gpt-6.1-sol')
    assert.equal(event.response?.content, 'Szia')
    assert.equal(event.usage?.promptTokens, 1000)
    assert.equal(typeof event.usage?.costUsd, 'number')
  })

  await check('gateway nem-stream: chat.completion JSON megy vissza', async () => {
    const s = gatewaySetup({
      scripts: [
        new Response(
          JSON.stringify({ id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Kész' }] }] }),
          { status: 200 },
        ),
      ],
    })
    const res = await s.call({ messages: [{ role: 'user', content: 'x' }] })
    const body = (await res.json()) as Json
    assert.equal(body.choices[0].message.content, 'Kész')
    assert.equal(s.events[0].response?.content, 'Kész')
  })

  await check('gateway: az első kimenet előtti response.failed még tartalék modellre vált', async () => {
    const failed = sseResponse(created, { type: 'response.failed', response: { error: { code: 'server_error', message: 'leállás' } } })
    const fallback = new Response(sseBody('data: {"choices":[{"index":0,"delta":{"content":"tartalék"}}]}\n\ndata: [DONE]\n\n'), { status: 200 })
    const s = gatewaySetup({ scripts: [failed, fallback] })
    const lines = (await dataLines(await s.call({ messages: [{ role: 'user', content: 'x' }], stream: true }))) as Json[]
    assert.equal(s.calls.length, 2)
    assert.equal(s.calls[1].url, 'https://openrouter.ai/api/v1/chat/completions')
    assert.equal(lines[0].choices[0].delta.content, 'tartalék')
  })

  await check('gateway: elfogyott OpenAI-keret 402-ként megy tovább, nem vált tartalékra', async () => {
    const quota = new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }), { status: 429 })
    const s = gatewaySetup({ scripts: [quota] })
    const res = await s.call({ messages: [{ role: 'user', content: 'x' }] })
    assert.equal(s.calls.length, 1)
    assert.equal(res.status, 402)
    assert.equal(((await res.json()) as Json).error.code, 'insufficient_quota')
  })

  await check('gateway: a valódi 429 (rate limit) marad 429-es hibaosztály, és tartalékra vált', async () => {
    const limited = new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'lassíts' } }), { status: 429 })
    const fallback = new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 })
    const s = gatewaySetup({ scripts: [limited, fallback] })
    const res = await s.call({ messages: [{ role: 'user', content: 'x' }] })
    assert.equal(res.status, 200)
    assert.equal(s.calls.length, 2)
    assert.equal(s.events[0].failedCandidates[0].status, 429)
  })

  await check('gateway: más provider továbbra is /chat/completions, változatlan testtel', async () => {
    const chat = new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 })
    const s = gatewaySetup({ scripts: [chat], primary: OR })
    const res = await s.call({ messages: [{ role: 'user', content: 'x' }], temperature: 0.1 })
    assert.equal(res.status, 200)
    assert.equal(s.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions')
    assert.equal(s.calls[0].body.temperature, 0.1)
    assert.ok(Array.isArray(s.calls[0].body.messages))
  })

  // --- Nyilvános chat ---
  await check('nyilvános chat: Responses-úton, eszközhívással; az olcsó alapmodell a Luna', async () => {
    assert.deepEqual(defaultPublicModel({ enabled: [SOL, { provider: 'openai', model: 'gpt-6-luna' }] }), {
      provider: 'openai',
      model: 'gpt-6-luna',
    })
    const urls: string[] = []
    const caller = createPublicModelCaller(
      {
        getTenantPolicy: async () => ({ enabled: [SOL] }),
        getGlobalFallbackChain: async () => [],
        providers: envProviderRegistry({}, async () => null, async () => null, async () => KEY_A),
        fetchImpl: (async (url: string) => {
          urls.push(url)
          return new Response(
            JSON.stringify({
              status: 'completed',
              output: [{ type: 'function_call', call_id: 'c1', name: 'keres', arguments: '{}' }],
              usage: { input_tokens: 1000, output_tokens: 0 },
            }),
            { status: 200 },
          )
        }) as never,
      },
      { tenantId: TENANT_A, config: {} as never },
    )
    const reply = await caller({ messages: [{ role: 'user', content: 'x' }], tools: [], toolChoice: 'auto' } as never)
    assert.equal(urls[0], 'https://api.openai.com/v1/responses')
    assert.equal(reply.toolCalls[0].function.name, 'keres')
    assert.ok(Math.abs(reply.costUsd - 0.002) < 1e-9)
  })

  if (failures) {
    console.error(`\n${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\nopenai-provider: minden teszt zöld')
}

void main()
