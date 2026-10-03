/**
 * Model Gateway proxy (#746 V1-3, D11/D12/D15) — OpenAI `chat_completions`, állapotmentes:
 * egy kérés be, egy válasz ki. Nem harness: a tool-üzenetek, a `tools`/`tool_calls` és az SSE
 * érintetlenül mennek át, csak a modell (D12), a hitelesítés és a tartalék-lánc (#768) a miénk.
 *
 * Blokk (D15) = HTTP 200 + szintetikus asszisztens-üzenet; a 4xx a Hermesben újrapróbálkozást vált ki.
 * Provider-kiesés a lánc végén 5xx/429 (a Hermes ilyenkor jogosan próbálkozik újra), a kérés hibája
 * (pl. túl hosszú kontextus, 400) változatlanul visszamegy, hogy a Hermes tömöríthessen.
 */
import { randomUUID } from 'node:crypto'
import { logger } from '@/lib/observability'
import { parseAgentModelConfig, resolveAgentPrimary } from '@/lib/agent-model-config'
import { modelRefKey, sameModel, type ModelPolicy, type ModelRef } from '@/lib/model-policy'
import {
  buildEffectiveFallbackChain,
  classifyProviderError,
  fallbackMaxAttemptsFromEnv,
  isFallbackEligible,
  type FallbackErrorClass,
} from '@/domain/model-gateway/fallback-chain'
import type { GatewayTokenFailure, GatewayTokenClaims } from '@/domain/model-gateway-token/gateway-token'
import type { McpPrincipal } from '@/auth/mcp-principal'

export const SESSION_HEADER = 'x-excellence-session'
export const TURN_HEADER = 'x-excellence-turn'
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024
const PROVIDER_CONNECT_TIMEOUT_MS = 120_000

/**
 * Amit a kliens küldhet. Allowlist, mert az OpenRouter-specifikus `models`/`route`/`provider`/`plugins`
 * megkerülné a modell-policyt és a tartalék-láncot.
 */
const FORWARDED_PARAMS = [
  'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'top_k', 'min_p',
  'max_tokens', 'max_completion_tokens', 'stop', 'seed', 'frequency_penalty', 'presence_penalty',
  'repetition_penalty', 'response_format', 'reasoning', 'reasoning_effort', 'include_reasoning',
] as const

export type ProviderEndpoint = { baseUrl: string; apiKey?: string; headers?: Record<string, string> }
/** null = a provider ezen a hoston nincs bekötve. */
export type ProviderRegistry = (provider: string) => ProviderEndpoint | null

/** v1: OpenAI-kompatibilis providerek (D11). A céges modell-kulcs egyetlen helye. */
export function envProviderRegistry(env: Record<string, string | undefined> = process.env): ProviderRegistry {
  return (provider) => {
    if (provider === 'openrouter') {
      const apiKey = env.OPENROUTER_API_KEY?.trim()
      if (!apiKey) return null
      return {
        baseUrl: (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
        apiKey,
        headers: {
          ...(env.OPENROUTER_HTTP_REFERER ? { 'HTTP-Referer': env.OPENROUTER_HTTP_REFERER } : {}),
          ...(env.OPENROUTER_APP_TITLE ? { 'X-OpenRouter-Title': env.OPENROUTER_APP_TITLE } : {}),
        },
      }
    }
    if (provider === 'ollama' && env.OLLAMA_BASE_URL) {
      return { baseUrl: env.OLLAMA_BASE_URL.replace(/\/+$/, ''), apiKey: env.OLLAMA_API_KEY }
    }
    return null
  }
}

export type GatewayCallContext = {
  tenantId: string
  tenantSlug: string
  userId: string
  agentId: string
  installId: string
  policyVersion: string
  sessionId: string | null
  /** A Guard fordulat-azonosítója: a gateway- és a Guard-események ezzel fűzhetők össze (V1-5). */
  turnId: string | null
  stream: boolean
}

export type ModelCallEvent = GatewayCallContext & {
  requestedModel: string | null
  /** A ténylegesen válaszoló modell (`provider/model`); blokknál null. */
  model: string | null
  /** A kért modell nem engedett (vagy nem azonosítható) → az agent modellje futott. */
  substituted: boolean
  /** A tartalék-váltás előtt sikertelen jelöltek. */
  failedCandidates: Array<{ model: string; errorClass: FallbackErrorClass }>
  outcome: 'ok' | 'blocked' | 'error' | 'aborted'
  blockReason?: string
  errorClass?: FallbackErrorClass
  /** A providernek ténylegesen elküldött kérés (szűrés után). Az audit-mélység dönt a tárolásról (V1-5). */
  request: unknown
  response: { content: string; toolCalls: unknown[]; finishReason: string | null } | null
  usage: { promptTokens?: number; completionTokens?: number } | null
  latencyMs: number
}

/** `AiInteractionEvent` (`kind: model_call`, `source: gateway`) implementálja: `domain/ai-audit` (V1-5). */
export interface ModelCallAuditSink {
  record(event: ModelCallEvent): Promise<void>
}

export type PipelineBlock = { block: string; reason: string }

/**
 * Szűrő-csővezeték helye (V1-4 tölti ki) és a Managed/Open kapu (V1-7). Alapból nincs: átengedés.
 * - `gate`: a hívás egyáltalán mehet-e céges modellre.
 * - `filterRequest`: a provider-hívás ELŐTT; módosíthatja a kérést vagy blokkolhat.
 * - `transformResponse`: a válasz-visszaállítás a kimeneten (stream és nem-stream body is ezen megy át).
 */
export type GatewayPipelineHooks = {
  gate?: (ctx: GatewayCallContext) => Promise<PipelineBlock | null>
  filterRequest?: (
    ctx: GatewayCallContext,
    body: Record<string, unknown>,
  ) => Promise<PipelineBlock | { body: Record<string, unknown> }>
  transformResponse?: (ctx: GatewayCallContext) => TransformStream<Uint8Array, Uint8Array>
}

export type ModelGatewayDeps = {
  verify: (
    authorizationHeader: string | null,
  ) => Promise<{ ok: true; claims: GatewayTokenClaims; principal: McpPrincipal } | GatewayTokenFailure>
  /** Nyers `Agent.modelConfig` JSON. */
  loadAgentModelConfig: (input: { tenantId: string; agentId: string }) => Promise<unknown>
  getTenantPolicy: (tenantId: string) => Promise<ModelPolicy>
  getGlobalFallbackChain: () => Promise<ModelRef[]>
  /** User effektív modell-szűkítése (V1-1 policy `models`); null = nincs szűkítés. */
  getAllowedModels: (input: { tenantId: string; userId: string; agentId: string }) => Promise<string[] | null>
  providers: ProviderRegistry
  audit: ModelCallAuditSink
  hooks?: GatewayPipelineHooks
  maxAttempts?: number
  fetchImpl?: typeof fetch
}

class ProviderHttpError extends Error {
  constructor(
    provider: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${provider} provider failed: ${status} ${body.slice(0, 200)}`)
    this.name = 'ProviderHttpError'
  }
}

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

const errorResponse = (status: number, code: string, message: string): Response =>
  json(status, { error: { message, type: code, code } })

const TOKEN_FAILURE: Record<GatewayTokenFailure['code'], [number, string]> = {
  unauthenticated: [401, 'A munkamenet lejárt vagy hiányzik — kérj új belépőt.'],
  invalid_token: [401, 'A munkamenet lejárt vagy hiányzik — kérj új belépőt.'],
  forbidden: [403, 'Ehhez az asszisztenshez már nincs hozzáférésed.'],
  agent_not_found: [403, 'Ehhez az asszisztenshez már nincs hozzáférésed.'],
  bad_request: [400, 'Hibás kérés.'],
  key_missing: [503, 'A modell-átjáró most nincs beállítva.'],
}

/** D15: a blokk hétköznapi nyelvű asszisztens-üzenet, HTTP 200 — stream és nem-stream kérésre is. */
export function syntheticCompletion(message: string, opts: { stream: boolean; model: string }): Response {
  const id = `chatcmpl-blocked-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const base = { id, created, model: opts.model }
  if (!opts.stream) {
    return json(200, {
      ...base,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: message }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  }
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  return new Response(
    chunk({ role: 'assistant', content: message }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } },
  )
}

/** Az OpenAI-válasz (nem-stream body vagy SSE-chunk) azon része, amit az audit és a hibafelismerés olvas. */
type OpenAiPayload = {
  model?: string
  error?: { code?: string | number; message?: string }
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  choices?: Array<{
    finish_reason?: string | null
    message?: { content?: unknown; tool_calls?: unknown[] }
    delta?: {
      content?: unknown
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
  }>
}

/** SSE-ből gyűjti az auditnak a választ (szöveg, tool-hívások, usage) — a bájtokat nem módosítja. */
class SseCollector {
  content = ''
  finishReason: string | null = null
  usage: ModelCallEvent['usage'] = null
  model: string | null = null
  private calls = new Map<number, { id?: string; name: string; arguments: string }>()
  private pending = ''
  private decoder = new TextDecoder()

  push(chunk: Uint8Array): void {
    this.pending += this.decoder.decode(chunk, { stream: true })
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    for (const line of lines) {
      const data = line.trim().startsWith('data:') ? line.trim().slice(5).trim() : ''
      if (!data || data === '[DONE]') continue
      try {
        this.add(JSON.parse(data))
      } catch {
        // csonka/idegen SSE-sor: az audit nem blokkolhatja a streamet
      }
    }
  }

  private add(parsed: OpenAiPayload): void {
    if (typeof parsed?.model === 'string') this.model = parsed.model
    if (parsed?.usage) this.usage = { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens }
    const choice = parsed?.choices?.[0]
    if (choice?.finish_reason) this.finishReason = choice.finish_reason
    const delta = choice?.delta
    if (typeof delta?.content === 'string') this.content += delta.content
    for (const tc of delta?.tool_calls ?? []) {
      const cur = this.calls.get(tc.index ?? 0) ?? { name: '', arguments: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name += tc.function.name
      if (tc.function?.arguments) cur.arguments += tc.function.arguments
      this.calls.set(tc.index ?? 0, cur)
    }
  }

  response(): NonNullable<ModelCallEvent['response']> {
    return { content: this.content, toolCalls: [...this.calls.values()], finishReason: this.finishReason }
  }
}

const matchesRequested = (ref: ModelRef, requested: string) => modelRefKey(ref) === requested || ref.model === requested

/** Az első `data:` sor megérkezéséig puffereli a streamet: addig a tartalék-váltás még szabad. */
async function peekFirstData(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  provider: string,
): Promise<Uint8Array[]> {
  const decoder = new TextDecoder()
  const buffered: Uint8Array[] = []
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`${provider} provider failed: empty stream`)
    buffered.push(value)
    text += decoder.decode(value, { stream: true })
    const first = /(?:^|\n)data:[ \t]*([^\n]*)/.exec(text)
    if (!first || !text.includes('\n', first.index + first[0].length - 1)) continue // a sor még csonka
    const data = first[1].trim()
    if (data === '[DONE]') throw new Error(`${provider} provider failed: empty stream`)
    let parsed: OpenAiPayload | null = null
    try {
      parsed = JSON.parse(data)
    } catch {
      // nem JSON: nem tudjuk hibának minősíteni, átengedjük
    }
    if (parsed?.error) {
      throw new Error(`${provider} provider failed: ${parsed.error.code ?? ''} ${parsed.error.message ?? ''}`)
    }
    return buffered
  }
}

export async function handleChatCompletion(deps: ModelGatewayDeps, request: Request): Promise<Response> {
  const started = Date.now()
  const auth = await deps.verify(request.headers.get('authorization'))
  if (!auth.ok) {
    const [status, message] = TOKEN_FAILURE[auth.code]
    return errorResponse(status, auth.code, message)
  }
  const { claims, principal } = auth

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_REQUEST_BYTES) return errorResponse(413, 'request_too_large', 'A kérés túl nagy.')
  const text = await request.text()
  if (text.length > MAX_REQUEST_BYTES) return errorResponse(413, 'request_too_large', 'A kérés túl nagy.')
  let body: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(text)
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    body = null
  }
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(400, 'invalid_request', 'A kérésben nincs üzenet.')
  }

  const stream = body.stream === true
  const ctx: GatewayCallContext = {
    tenantId: principal.tenantId,
    tenantSlug: principal.tenantSlug,
    userId: principal.userId,
    agentId: claims.agentId,
    installId: claims.installId,
    policyVersion: claims.policyVersion,
    sessionId: request.headers.get(SESSION_HEADER)?.slice(0, 200) ?? null,
    turnId: request.headers.get(TURN_HEADER)?.slice(0, 200) ?? null,
    stream,
  }
  const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null
  const record = (e: Partial<ModelCallEvent> & Pick<ModelCallEvent, 'outcome'>) =>
    deps.audit
      .record({
        ...ctx, requestedModel, model: null, substituted: false, failedCandidates: [], request: null,
        response: null, usage: null, latencyMs: Date.now() - started, ...e,
      })
      // ponytail: az audit-hiba nem állítja meg a hívást; fail-closed audit, ha a V1-7 megkerülés-észlelés megköveteli.
      .catch((err) => logger.error({ event: 'model_gateway.audit_failed', error: String(err) }, 'Model call audit failed'))
  const blocked = (reason: string, message: string) => {
    void record({ outcome: 'blocked', blockReason: reason })
    return syntheticCompletion(message, { stream, model: requestedModel ?? 'excellence' })
  }

  // --- Modellválasztás (D12) + tartalék-lánc (#768) ---
  const [rawConfig, tenantPolicy, globalChain, allowedModels] = await Promise.all([
    deps.loadAgentModelConfig({ tenantId: ctx.tenantId, agentId: ctx.agentId }),
    deps.getTenantPolicy(ctx.tenantId),
    deps.getGlobalFallbackChain(),
    deps.getAllowedModels({ tenantId: ctx.tenantId, userId: ctx.userId, agentId: ctx.agentId }),
  ])
  const userPolicy: ModelPolicy = allowedModels
    ? { enabled: tenantPolicy.enabled.filter((r) => allowedModels.some((m) => matchesRequested(r, m))) }
    : tenantPolicy
  const config = parseAgentModelConfig(rawConfig)
  const agentPrimary = resolveAgentPrimary(rawConfig, tenantPolicy)
  const asked = requestedModel ? userPolicy.enabled.find((r) => matchesRequested(r, requestedModel)) : undefined
  const chain = buildEffectiveFallbackChain({
    primary: asked ?? agentPrimary,
    agentFallbacks: [...(agentPrimary ? [agentPrimary] : []), ...(config?.fallbackModels ?? [])],
    globalFallbacks: globalChain,
    policy: userPolicy,
    maxAttempts: deps.maxAttempts ?? fallbackMaxAttemptsFromEnv(),
  })
  if (chain.length === 0) {
    return blocked(
      'no_allowed_model',
      'Ehhez az asszisztenshez most nincs engedélyezett modell. Kérd meg a rendszergazdát, hogy kapcsolja be a Beállítások → Engedett modellek alatt.',
    )
  }

  // --- Kapu (V1-7) és szűrő (V1-4): helyük előkészítve ---
  const gate = await deps.hooks?.gate?.(ctx)
  if (gate) return blocked(gate.reason, gate.block)
  let clientBody = body
  const filtered = await deps.hooks?.filterRequest?.(ctx, body)
  if (filtered && 'block' in filtered) return blocked(filtered.reason, filtered.block)
  if (filtered) clientBody = filtered.body

  const upstreamFor = (candidate: ModelRef): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const key of FORWARDED_PARAMS) if (clientBody[key] !== undefined) out[key] = clientBody[key]
    if (config && sameModel(candidate, config)) {
      out.temperature ??= config.temperature
      if (out.max_completion_tokens === undefined) out.max_tokens ??= config.maxTokens
    }
    return { ...out, model: candidate.model, stream, ...(stream ? { stream_options: { include_usage: true } } : {}) }
  }

  const failed: ModelCallEvent['failedCandidates'] = []
  let lastError: unknown = null
  for (const candidate of chain) {
    const upstream = upstreamFor(candidate)
    try {
      return await callProvider(deps, request, candidate, upstream, ctx, (outcome, collected) => {
        const substituted = !!requestedModel && !matchesRequested(candidate, requestedModel)
        void record({
          outcome,
          model: modelRefKey(candidate),
          substituted,
          failedCandidates: failed,
          request: upstream,
          response: collected.response,
          usage: collected.usage,
        })
      })
    } catch (error) {
      lastError = error
      const errorClass = classifyProviderError(error)
      failed.push({ model: modelRefKey(candidate), errorClass })
      // Első token előtt vagyunk (a callProvider csak sikeres elsőre tér vissza): csak provider-oldali hiba vált.
      if (!isFallbackEligible(errorClass)) break
    }
  }

  const errorClass = classifyProviderError(lastError)
  void record({ outcome: 'error', errorClass, failedCandidates: failed, request: null })
  if (lastError instanceof ProviderHttpError && !isFallbackEligible(errorClass)) {
    return new Response(lastError.body, {
      status: lastError.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return errorResponse(
    errorClass === 'rate_limited' ? 429 : 502,
    errorClass,
    'A modell-szolgáltató most nem érhető el. Próbáld újra egy perc múlva.',
  )
}

/**
 * Egy jelölt hívása. Kivétel = az első token előtti hiba (váltható); siker után a válasz már a kliensé,
 * a `finish` pontosan egyszer fut, amikor a válasz lezárult (vagy megszakadt).
 */
async function callProvider(
  deps: ModelGatewayDeps,
  request: Request,
  candidate: ModelRef,
  upstream: Record<string, unknown>,
  ctx: GatewayCallContext,
  onDone: (
    outcome: 'ok' | 'aborted' | 'error',
    collected: { response: ModelCallEvent['response']; usage: ModelCallEvent['usage'] },
  ) => void,
): Promise<Response> {
  const endpoint = deps.providers(candidate.provider)
  if (!endpoint) throw new Error(`${candidate.provider} provider is not configured`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROVIDER_CONNECT_TIMEOUT_MS)
  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
        ...endpoint.headers,
      },
      body: JSON.stringify(upstream),
      signal: AbortSignal.any([controller.signal, request.signal]),
    })
  } catch (error) {
    if (!request.signal.aborted && controller.signal.aborted) {
      throw new Error(`${candidate.provider} provider request timed out after ${PROVIDER_CONNECT_TIMEOUT_MS}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new ProviderHttpError(candidate.provider, res.status, await res.text())

  const transform = deps.hooks?.transformResponse?.(ctx)
  const out = (body: ReadableStream<Uint8Array> | string, contentType: string, extra: HeadersInit = {}) => {
    const source = transform && typeof body === 'string' ? new Response(body).body! : body
    return new Response(transform && typeof source !== 'string' ? source.pipeThrough(transform) : source, {
      status: 200,
      headers: { 'content-type': contentType, ...extra },
    })
  }

  if (!ctx.stream) {
    const text = await res.text()
    let data: OpenAiPayload
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`${candidate.provider} provider failed: invalid response`)
    }
    // Az OpenRouter időnként 200-zal ad `{error}` testet.
    if (data?.error || !Array.isArray(data?.choices)) {
      throw new Error(`${candidate.provider} provider failed: ${data?.error?.code ?? ''} ${data?.error?.message ?? 'no choices'}`)
    }
    const msg = data.choices[0]?.message
    onDone('ok', {
      response: { content: typeof msg?.content === 'string' ? msg.content : '', toolCalls: msg?.tool_calls ?? [], finishReason: data.choices[0]?.finish_reason ?? null },
      usage: data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens } : null,
    })
    return out(text, 'application/json')
  }

  if (!res.body) throw new Error(`${candidate.provider} provider failed: empty stream`)
  const reader = res.body.getReader()
  let buffered: Uint8Array[]
  try {
    buffered = await peekFirstData(reader, candidate.provider)
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  }

  const collector = new SseCollector()
  let finished = false
  const finish = (outcome: 'ok' | 'aborted' | 'error') => {
    if (finished) return
    finished = true
    onDone(outcome, { response: collector.response(), usage: collector.usage })
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of buffered) {
        collector.push(chunk)
        controller.enqueue(chunk)
      }
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          finish('ok')
        } else {
          collector.push(value)
          controller.enqueue(value)
        }
      } catch (error) {
        finish(request.signal.aborted ? 'aborted' : 'error')
        controller.error(error)
      }
    },
    cancel(reason) {
      finish('aborted')
      return reader.cancel(reason)
    },
  })
  return out(body, 'text/event-stream; charset=utf-8', { 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
}
