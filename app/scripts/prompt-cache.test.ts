/**
 * Prompt-cache cache-határ tesztek (Prompt-Cache-Control-Breakpoints spec).
 *
 * Futtatás: npx tsx scripts/prompt-cache.test.ts
 *
 * A megfigyelt viselkedés kétrétegű, és mindkettőt kívülről nézzük:
 *  1. az assembler kimenetén: a stabil zóna utolsó üzenete cache-határ,
 *  2. a providerhez ténylegesen kimenő HTTP body-n: ott (és csak ott) van
 *     `cache_control`, ahol a provider támogatja és a politika engedi.
 */

import assert from 'node:assert/strict'
import { assembleGatewayMessages, type PromptSegments } from '../src/domain/agent/prompt-assembler'
import {
  CachedPrefixSurrogateInvariantError,
  MAX_CACHE_BREAKPOINTS,
  extractPromptCacheUsage,
  findSurrogatesInCachedPrefix,
  promptCachePolicyFromEnv,
  resolveCacheBreakpoints,
} from '../src/domain/gateway/prompt-cache'
import {
  createDefaultProviders,
  ModelGateway,
  type GatewayMessage,
  type ModelProvider,
} from '../src/domain/gateway/model-gateway'
import { registry } from '../src/lib/observability'
import type { AuditRepository, ModelCallRepository } from '../src/repositories/interfaces'
import type { AuditLog, ModelCall } from '@prisma/client'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  OK  ${name}`))
    .catch((e: unknown) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

/** ~1300 token, hogy a default minimum-prefix kapun átmenjen. */
const LONG_STABLE_BLOCK = 'agent system prompt. '.repeat(280)

function fixture(variable: string): PromptSegments {
  return {
    stablePreamble: [
      { role: 'system', content: LONG_STABLE_BLOCK },
      { role: 'system', content: 'org roster' },
    ],
    stablePostamble: [{ role: 'system', content: 'memória capture-policy' }],
    variableContext: [{ role: 'system', content: `Project memory context: ${variable}` }],
    history: [{ role: 'user', content: 'kérdés' }],
    toolTail: [{ role: 'tool', toolCallId: 'call-1', toolName: 'kb_search', content: 'eredmény' }],
  }
}

type CapturedRequest = { url: string; body: Record<string, unknown> }

/** A provider-hívást elkapja és a kért JSON választ adja vissza. */
async function captureProviderRequest(
  run: (provider: ModelProvider) => Promise<unknown>,
  options: { providerName?: string; responseBody?: unknown } = {},
): Promise<CapturedRequest> {
  const originalFetch = globalThis.fetch
  let captured: CapturedRequest | undefined
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url: String(url), body: JSON.parse(String(init.body)) }
    return new Response(
      JSON.stringify(
        options.responseBody ?? {
          choices: [{ message: { content: 'kész' } }],
          usage: { prompt_tokens: 100, completion_tokens: 5 },
          model: 'anthropic/claude-x',
        },
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  try {
    const provider = createDefaultProviders().get(options.providerName ?? 'openrouter')
    assert.ok(provider, `${options.providerName ?? 'openrouter'} provider regisztrálva`)
    await run(provider)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.ok(captured, 'a provider elküldte a kérést')
  return captured
}

function messagesOf(request: CapturedRequest): Array<{ role: string; content: unknown }> {
  return request.body.messages as Array<{ role: string; content: unknown }>
}

function cacheControlIndexes(request: CapturedRequest): number[] {
  return messagesOf(request)
    .map((m, i) => (Array.isArray(m.content) && m.content.some((p) => 'cache_control' in p) ? i : -1))
    .filter((i) => i >= 0)
}

async function main() {
  console.log('=== Prompt-cache cache-határ tesztek ===')

  process.env.OPENROUTER_API_KEY = 'test-key'
  delete process.env.GATEWAY_PROMPT_CACHE
  delete process.env.GATEWAY_PROMPT_CACHE_MIN_TOKENS
  delete process.env.GATEWAY_PROMPT_CACHE_TTL

  await check('assembler: a stabil zóna UTOLSÓ üzenete a cache-határ, a változó zóna nem', () => {
    const messages = assembleGatewayMessages(fixture('A'))
    const marked = messages
      .map((m, i) => (m.cacheBoundary ? i : -1))
      .filter((i) => i >= 0)
    // 0: agent prompt, 1: roster, 2: capture-policy (stablePostamble vége) → itt a határ
    assert.deepEqual(marked, [2], 'pontosan egy határ, a stabil zóna végén')
    assert.equal(messages[2]!.content, 'memória capture-policy', 'a tartalom nem változik')
  })

  await check('assembler: a jelölés nem mutálja a hívó szegmenseit', () => {
    const segments = fixture('A')
    assembleGatewayMessages(segments)
    assert.ok(
      segments.stablePostamble!.every((m) => m.cacheBoundary === undefined),
      'a bemeneti tömb üzenetei jelöletlenek maradnak',
    )
  })

  await check('assembler: előre jelölt bemenetből is pontosan egy, utolsó határ készül', () => {
    const segments = fixture('A')
    segments.stablePreamble[0] = {
      ...segments.stablePreamble[0]!,
      cacheBoundary: true,
    }
    segments.variableContext![0] = {
      ...segments.variableContext![0]!,
      cacheBoundary: true,
    }
    segments.history![0] = {
      ...segments.history![0]!,
      cacheBoundary: true,
    }
    segments.toolTail![0] = {
      ...segments.toolTail![0]!,
      cacheBoundary: true,
    }
    const messages = assembleGatewayMessages(segments)
    const marked = messages
      .map((m, i) => (m.cacheBoundary ? i : -1))
      .filter((i) => i >= 0)
    assert.deepEqual(marked, [2], 'a korábbi jelölést az assembler eltávolítja')
  })

  await check('assembler: a változó adat nem mozdítja el a stabil prefixet és a határt', () => {
    const first = assembleGatewayMessages(fixture('A'))
    const second = assembleGatewayMessages(fixture('B'))
    assert.deepEqual(first.slice(0, 3), second.slice(0, 3), 'bájt-azonos stabil prefix, azonos határ')
    assert.deepEqual(first, assembleGatewayMessages(fixture('A')), 'determinisztikus kimenet')
  })

  await check('policy: rövid prefixre nincs jelölés (a provider úgysem cache-elne)', () => {
    const policy = promptCachePolicyFromEnv({})
    const short: GatewayMessage[] = [{ role: 'system', content: 'rövid', cacheBoundary: true }]
    assert.deepEqual(resolveCacheBreakpoints(short, policy), [])
  })

  await check('policy: kill switch (GATEWAY_PROMPT_CACHE=off) mindent kikapcsol', () => {
    const policy = promptCachePolicyFromEnv({ GATEWAY_PROMPT_CACHE: 'off' })
    assert.equal(policy.enabled, false)
    assert.deepEqual(
      resolveCacheBreakpoints(assembleGatewayMessages(fixture('A')), policy),
      [],
    )
  })

  await check('policy: legfeljebb 4 breakpoint, a leghosszabb prefixek maradnak', () => {
    const policy = promptCachePolicyFromEnv({ GATEWAY_PROMPT_CACHE_MIN_TOKENS: '0' })
    const messages: GatewayMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: 'system' as const,
      content: `blokk ${i}`,
      cacheBoundary: true,
    }))
    const breakpoints = resolveCacheBreakpoints(messages, policy)
    assert.equal(breakpoints.length, MAX_CACHE_BREAKPOINTS)
    assert.deepEqual(breakpoints, [2, 3, 4, 5])
  })

  await check('policy: tool-eredmény és üres tartalom nem lehet cache-határ', () => {
    const policy = promptCachePolicyFromEnv({ GATEWAY_PROMPT_CACHE_MIN_TOKENS: '0' })
    const messages: GatewayMessage[] = [
      { role: 'tool', toolCallId: 'c1', toolName: 'kb_search', content: 'x', cacheBoundary: true },
      { role: 'system', content: '   ', cacheBoundary: true },
      { role: 'system', content: 'valódi határ', cacheBoundary: true },
    ]
    assert.deepEqual(resolveCacheBreakpoints(messages, policy), [2])
  })

  await check('APG-15: a cache-elt prefix nem tartalmaz álnevet (assembler fixture)', () => {
    const policy = promptCachePolicyFromEnv({ GATEWAY_PROMPT_CACHE_MIN_TOKENS: '0' })
    const messages = assembleGatewayMessages(fixture('A'))
    const breakpoints = resolveCacheBreakpoints(messages, policy)
    assert.deepEqual(findSurrogatesInCachedPrefix(messages, breakpoints), [])
  })

  await check('APG-15: álnév a stabil zónában → invariant hibát dob', () => {
    const policy = promptCachePolicyFromEnv({ GATEWAY_PROMPT_CACHE_MIN_TOKENS: '0' })
    const messages = assembleGatewayMessages(fixture('A'))
    messages[1] = { role: 'system', content: 'org roster [[EMAIL_1]]' }
    assert.throws(
      () => resolveCacheBreakpoints(messages, policy),
      CachedPrefixSurrogateInvariantError,
    )
  })

  await check('APG-15: álnév a határ után (history) → prefix tiszta marad', () => {
    const policy = promptCachePolicyFromEnv({ GATEWAY_PROMPT_CACHE_MIN_TOKENS: '0' })
    const messages = assembleGatewayMessages(fixture('A'))
    const historyIndex = messages.length - 2
    messages[historyIndex] = { role: 'user', content: 'Írj a [[EMAIL_1]] címre' }
    const breakpoints = resolveCacheBreakpoints(messages, policy)
    assert.deepEqual(findSurrogatesInCachedPrefix(messages, breakpoints), [])
  })

  await check('APG-15: skill-szöveg [[COMPANY_1]] a változó zónában, prefix tiszta', () => {
    const policy = promptCachePolicyFromEnv({ GATEWAY_PROMPT_CACHE_MIN_TOKENS: '0' })
    const segments = fixture('A')
    segments.variableContext!.push({
      role: 'system',
      content: 'Skill példa: a [[COMPANY_1]] helyettesítő csak dokumentáció.',
    })
    const messages = assembleGatewayMessages(segments)
    const breakpoints = resolveCacheBreakpoints(messages, policy)
    assert.deepEqual(findSurrogatesInCachedPrefix(messages, breakpoints), [])
    assert.equal(messages.some((m) => m.content?.includes('[[COMPANY_1]]')), true)
  })

  await check('openrouter: a jelölt üzenet cache_control-lal megy ki, a többi sima szöveg', async () => {
    const messages = assembleGatewayMessages(fixture('A'))
    const request = await captureProviderRequest((provider) =>
      provider.chat({
        agentId: 'agent-1',
        messages,
        modelConfig: { provider: 'openrouter', model: 'anthropic/claude-x' },
      }),
    )

    assert.deepEqual(cacheControlIndexes(request), [2], 'egyetlen breakpoint a stabil zóna végén')
    const boundary = messagesOf(request)[2]!
    assert.deepEqual(boundary.content, [
      { type: 'text', text: 'memória capture-policy', cache_control: { type: 'ephemeral' } },
    ])
    assert.equal(
      messagesOf(request)[0]!.content,
      LONG_STABLE_BLOCK,
      'a nem jelölt üzenet bájtra változatlan marad',
    )
  })

  await check('openrouter: 1h TTL env-ből', async () => {
    process.env.GATEWAY_PROMPT_CACHE_TTL = '1h'
    try {
      const request = await captureProviderRequest((provider) =>
        provider.chat({
          agentId: 'agent-1',
          messages: assembleGatewayMessages(fixture('A')),
          modelConfig: { provider: 'openrouter', model: 'anthropic/claude-x' },
        }),
      )
      const parts = messagesOf(request)[2]!.content as Array<{ cache_control?: unknown }>
      assert.deepEqual(parts[0]!.cache_control, { type: 'ephemeral', ttl: '1h' })
    } finally {
      delete process.env.GATEWAY_PROMPT_CACHE_TTL
    }
  })

  await check('openrouter: kikapcsolt prompt-cache mellett nincs cache_control', async () => {
    process.env.GATEWAY_PROMPT_CACHE = 'off'
    try {
      const request = await captureProviderRequest((provider) =>
        provider.chat({
          agentId: 'agent-1',
          messages: assembleGatewayMessages(fixture('A')),
          modelConfig: { provider: 'openrouter', model: 'anthropic/claude-x' },
        }),
      )
      assert.deepEqual(cacheControlIndexes(request), [])
      assert.ok(
        messagesOf(request).every((m) => typeof m.content === 'string'),
        'minden üzenet sima szövegként megy',
      )
    } finally {
      delete process.env.GATEWAY_PROMPT_CACHE
    }
  })

  await check('ollama: explicit cache-API nélküli provider nem kap cache_control-t', async () => {
    const request = await captureProviderRequest(
      (provider) =>
        provider.chat({
          agentId: 'agent-1',
          messages: assembleGatewayMessages(fixture('A')),
          modelConfig: { provider: 'ollama', model: 'gemma-local' },
        }),
      { providerName: 'ollama' },
    )
    assert.deepEqual(cacheControlIndexes(request), [])
  })

  await check('streaming ág: a cache-határ ugyanúgy kimegy', async () => {
    const originalFetch = globalThis.fetch
    let body: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return new Response('data: {"choices":[{"delta":{"content":"szia"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
    try {
      const provider = createDefaultProviders().get('openrouter')!
      const chunks: string[] = []
      for await (const chunk of provider.chatStream!({
        agentId: 'agent-1',
        messages: assembleGatewayMessages(fixture('A')),
        modelConfig: { provider: 'openrouter', model: 'anthropic/claude-x' },
      })) {
        chunks.push(chunk)
      }
      assert.deepEqual(chunks, ['szia'])
    } finally {
      globalThis.fetch = originalFetch
    }
    const messages = (body!.messages as Array<{ content: unknown }>)
    assert.ok(Array.isArray(messages[2]!.content), 'a stream body-ban is ott a breakpoint')
  })

  await check('usage: OpenAI-kompatibilis cached_tokens kiolvasása', async () => {
    const request = await captureProviderRequest(
      async (provider) => {
        const result = await provider.chat({
          agentId: 'agent-1',
          messages: assembleGatewayMessages(fixture('A')),
          modelConfig: { provider: 'openrouter', model: 'anthropic/claude-x' },
        })
        assert.equal(result.usage?.cachedPromptTokens, 1300)
        assert.equal(result.usage?.cacheWritePromptTokens, undefined)
      },
      {
        responseBody: {
          choices: [{ message: { content: 'kész' } }],
          usage: {
            prompt_tokens: 1500,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 1300 },
          },
        },
      },
    )
    assert.ok(request.url.includes('/chat/completions'))
  })

  await check('usage: OpenRouter cache_write_tokens kiolvasása', () => {
    assert.deepEqual(
      extractPromptCacheUsage({
        prompt_tokens_details: {
          cached_tokens: 1300,
          cache_write_tokens: 240,
        },
      }),
      { cachedPromptTokens: 1300, cacheWritePromptTokens: 240 },
    )
  })

  await check('gateway: a cache-telemetria normál és streaming ágon auditba és metrikába kerül', async () => {
    const events: AuditLog[] = []
    const audit: AuditRepository = {
      async append(data) {
        const row = { id: crypto.randomUUID(), seq: BigInt(events.length + 1), ...data } as AuditLog
        events.push(row)
        return row
      },
      async findMany() { return events },
      async findAll() { return events },
      async getActionCounts() { return {} },
    }
    const modelCalls = {
      async create(data: unknown) { return data as ModelCall },
      async getCostSummary() { return { tokens: 0, cost: 0 } },
      async getUsageForAgentSince() { return { calls: 0, tokens: 0 } },
      async getUsageForTicket() { return { calls: 0, tokens: 0 } },
      async getUsageForAgent() { return { calls: 0, tokens: 0 } },
      async getUsageForTenant() { return { calls: 0, tokens: 0 } },
      async getUsageForTicketType() { return { calls: 0, tokens: 0 } },
      async getUsageByAgent() { return [] },
      async getGovernanceSummary() {
        return { calls: 0, tokens: 0, cost: 0, avgLatencyMs: 0, okCalls: 0, errorCalls: 0, rateLimitedCalls: 0 }
      },
      async getPerTicketBreakdown() { return [] },
    } as unknown as ModelCallRepository

    const provider: ModelProvider = {
      name: 'openrouter',
      async chat() {
        return {
          content: 'kész',
          usage: {
            promptTokens: 1500,
            completionTokens: 5,
            cachedPromptTokens: 1300,
            cacheWritePromptTokens: 200,
          },
          latencyMs: 1,
        }
      },
    }

    registry.resetAll()
    const gateway = new ModelGateway(audit, modelCalls, new Map([[provider.name, provider]]))
    await gateway.call({
      agentId: 'aaaaaaaa-bbbb-4000-8000-000000000009',
      messages: assembleGatewayMessages(fixture('A')),
      modelConfig: { provider: 'openrouter', model: 'anthropic/claude-x' },
    })

    const call = events.find((e) => e.action === 'model.call')
    const metadata = call?.metadata as Record<string, unknown> | undefined
    assert.equal(metadata?.cachedPromptTokens, 1300, 'audit: cache-olvasás')
    assert.equal(metadata?.cacheWritePromptTokens, 200, 'audit: cache-írás')

    const metrics = registry.render()
    assert.ok(
      metrics.includes('model_gateway_prompt_cache_tokens_total{kind="read",provider="openrouter"} 1300'),
      'metrika: olvasott prompt-tokenek',
    )
    assert.ok(
      metrics.includes('model_gateway_prompt_cache_tokens_total{kind="write",provider="openrouter"} 200'),
      'metrika: írt prompt-tokenek',
    )

    const originalFetch = globalThis.fetch
    const originalStdoutWrite = process.stdout.write
    let streamBody: Record<string, unknown> | undefined
    let streamLogOutput = ''
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      streamBody = JSON.parse(String(init.body))
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"stream kész"}}]}',
          '',
          'data: {"choices":[],"usage":{"prompt_tokens":1500,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":1200,"cache_write_tokens":300}}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch
    process.stdout.write = ((chunk: string | Uint8Array) => {
      streamLogOutput += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      const streamProvider = createDefaultProviders().get('openrouter')!
      const streamGateway = new ModelGateway(
        audit,
        modelCalls,
        new Map([[streamProvider.name, streamProvider]]),
      )
      const chunks: string[] = []
      for await (const chunk of streamGateway.callStream({
        agentId: 'aaaaaaaa-bbbb-4000-8000-000000000009',
        messages: assembleGatewayMessages(fixture('A')),
        modelConfig: { provider: 'openrouter', model: 'anthropic/claude-x' },
      })) {
        chunks.push(chunk)
      }
      assert.deepEqual(chunks, ['stream kész'])
    } finally {
      globalThis.fetch = originalFetch
      process.stdout.write = originalStdoutWrite
    }

    assert.deepEqual(
      streamBody?.stream_options,
      { include_usage: true },
      'a streaming kérés usage blokkot kér a providertől',
    )
    const streamCall = events.filter((event) => event.action === 'model.call').at(-1)
    const streamMetadata = streamCall?.metadata as Record<string, unknown> | undefined
    assert.equal(streamMetadata?.cachedPromptTokens, 1200, 'stream audit: cache-olvasás')
    assert.equal(streamMetadata?.cacheWritePromptTokens, 300, 'stream audit: cache-írás')
    const streamLog = streamLogOutput
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.event === 'model.call')
    assert.equal(streamLog?.cacheHit, true, 'stream napló: cacheHit')

    const streamMetrics = registry.render()
    assert.ok(
      streamMetrics.includes(
        'model_gateway_prompt_cache_tokens_total{kind="read",provider="openrouter"} 2500',
      ),
      'stream metrika: olvasott prompt-tokenek',
    )
    assert.ok(
      streamMetrics.includes(
        'model_gateway_prompt_cache_tokens_total{kind="write",provider="openrouter"} 500',
      ),
      'stream metrika: írt prompt-tokenek',
    )
    registry.resetAll()
  })

  await check('usage: Anthropic-natív cache mezők és a hiányzó/0 értékek kezelése', () => {
    assert.deepEqual(
      extractPromptCacheUsage({
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 1200,
      }),
      { cachedPromptTokens: 900, cacheWritePromptTokens: 1200 },
    )
    assert.deepEqual(extractPromptCacheUsage({ prompt_tokens: 10 }), {})
    assert.deepEqual(extractPromptCacheUsage(undefined), {})
    assert.deepEqual(extractPromptCacheUsage({ prompt_tokens_details: { cached_tokens: 0 } }), {})
  })

  console.log(failures === 0 ? '\nprompt cache tests passed' : `\n${failures} teszt bukott`)
  if (failures > 0) process.exitCode = 1
}

void main()
