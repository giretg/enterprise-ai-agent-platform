/**
 * S2 — valódi ChatGPT OAuth mediáció (Codex „Sign in with ChatGPT" háttér).
 *
 * Tiszta híd-réteg: a hívó adja a (szerveroldalon tartott) OAuth tokeneket, mi
 * a ChatGPT/Codex Responses backendet hívjuk és visszaadjuk a választ + token-
 * használatot. Ez a modul **nem** olvas fájlt és nem birtokol titkot — a token
 * a `scripts/chatgpt-oauth-provider.ts` sidecarban él, ami ezt használja.
 *
 * A kontraktus élő próbával validálva (2026-06-16): a `gpt-5.5` / `gpt-5.4`
 * modellek ChatGPT-fiókkal 200-at adnak; a Codex-utótagú modellek (`*-codex`)
 * ChatGPT-fiókkal nem támogatottak.
 */
import { randomUUID } from 'node:crypto'
import type { GatewayMessage, GatewayToolCall, ToolDefinition } from './model-gateway'

/** A Codex CLI hivatalos OAuth kliens-azonosítója (refresh flow-hoz). */
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'

/** A seed sentinel-modellt (és üres értéket) valódi ChatGPT-modellre mappeljük. */
export function resolveModel(requested: string | undefined): string {
  const fallback = process.env.CHATGPT_OAUTH_MODEL?.trim() || 'gpt-5.5'
  if (!requested || requested === 'chatgpt-oauth-default') return fallback
  return requested
}

export type ReasoningEffort = 'low' | 'medium' | 'high'

/**
 * Ortogonális modelType (luna/terra/sol) → ChatGPT reasoning effort.
 * Hiányzó / ismeretlen érték: a régi alapértelmezés (`low`), hogy a meglévő
 * agentek viselkedése ne változzon.
 */
export function resolveReasoningEffort(
  modelType: string | undefined,
): ReasoningEffort {
  if (modelType === 'luna') return 'low'
  if (modelType === 'terra') return 'medium'
  if (modelType === 'sol') return 'high'
  return 'low'
}

type ResponsesInputMessageContent = { type: 'input_text'; text: string }
type ResponsesAssistantMessageContent =
  | { type: 'output_text'; text: string }
  | { type: 'refusal'; refusal: string }

type ResponsesInputMessageItem = {
  type: 'message'
  role: 'user' | 'developer'
  content: ResponsesInputMessageContent[]
}
type ResponsesAssistantMessageItem = {
  type: 'message'
  role: 'assistant'
  content: ResponsesAssistantMessageContent[]
}
type ResponsesMessageItem = ResponsesInputMessageItem | ResponsesAssistantMessageItem
type ResponsesFunctionCallItem = {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}
type ResponsesFunctionCallOutputItem = {
  type: 'function_call_output'
  call_id: string
  output: string
}
type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem

/**
 * A ChatGPT OAuth Responses API a tool nevekben csak `[a-zA-Z0-9_-]` mintát fogad.
 * A belső platform-tooling pontozott neveket is használ (`sandbox_app.create`),
 * ezért outbound normalizálunk, inbound pedig visszamappeljük az eredetire.
 */
function sanitizeResponseToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * A Gateway üzenet-listáját Responses API alakra hozza: a `system` üzenetek a
 * top-level `instructions`-be mennek, a többi `input` itemmé. A natív tool use
 * üzeneteket dedikált item-típusokra fordítja:
 * - `assistant.toolCalls` → `function_call` itemek,
 * - `tool` eredmény → `function_call_output` item.
 */
export function toResponsesRequest(messages: GatewayMessage[]): {
  instructions: string
  input: ResponsesInputItem[]
} {
  const instructions = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')

  const input: ResponsesInputItem[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content })
      continue
    }
    if (m.role === 'assistant') {
      if (m.content?.trim()) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: m.content }],
        })
      }
      for (const call of m.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: sanitizeResponseToolName(call.name),
          arguments: JSON.stringify(call.input ?? {}),
        })
      }
      continue
    }
    // user
    input.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: m.content }],
    })
  }

  // Ha minden üzenet system volt, az utolsót felhasználói inputként is átadjuk,
  // hogy a modell biztosan kapjon választ-igénylő turn-t.
  if (input.length === 0 && messages.length > 0) {
    const last = messages[messages.length - 1]
    input.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: last.role === 'system' ? last.content : '' }],
    })
  }
  return { instructions, input }
}

export type ChatGptOAuthTokens = {
  accessToken: string
  accountId: string
}

export type ChatGptOAuthConcurrencyDiagnostic = {
  limit: number
  queueWaitMs: number
  queueDepthAtEnqueue: number
}

type ChatGptOAuthConcurrencyLease = {
  diagnostic: ChatGptOAuthConcurrencyDiagnostic
  release: () => void
}

type ChatGptOAuthConcurrencyWaiter = {
  queuedAt: number
  queueDepthAtEnqueue: number
  resolve: (lease: ChatGptOAuthConcurrencyLease) => void
}

type ChatGptOAuthConcurrencyLane = {
  active: number
  waiters: ChatGptOAuthConcurrencyWaiter[]
}

const concurrencyGlobal = globalThis as typeof globalThis & {
  __enterpriseAiChatGptOAuthConcurrencyLanes?: Map<string, ChatGptOAuthConcurrencyLane>
}

// `globalThis`-on tartjuk, hogy Next.js fejlesztői HMR és az eltérő szerver-
// bundle-ök se hozzanak létre külön sort ugyanabban a Node folyamatban.
const concurrencyLanes =
  concurrencyGlobal.__enterpriseAiChatGptOAuthConcurrencyLanes ??=
    new Map<string, ChatGptOAuthConcurrencyLane>()

export function chatGptOAuthMaxConcurrency(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.CHATGPT_OAUTH_MAX_CONCURRENCY?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : 1
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}

function leaseFor(params: {
  accountId: string
  lane: ChatGptOAuthConcurrencyLane
  limit: number
  queuedAt: number
  queueDepthAtEnqueue: number
}): ChatGptOAuthConcurrencyLease {
  let released = false
  return {
    diagnostic: {
      limit: params.limit,
      queueWaitMs: Date.now() - params.queuedAt,
      queueDepthAtEnqueue: params.queueDepthAtEnqueue,
    },
    release: () => {
      if (released) return
      released = true

      const next = params.lane.waiters.shift()
      if (next) {
        next.resolve(leaseFor({
          accountId: params.accountId,
          lane: params.lane,
          limit: params.limit,
          queuedAt: next.queuedAt,
          queueDepthAtEnqueue: next.queueDepthAtEnqueue,
        }))
        return
      }

      params.lane.active--
      if (params.lane.active === 0) concurrencyLanes.delete(params.accountId)
    },
  }
}

async function acquireChatGptOAuthConcurrency(
  accountId: string,
): Promise<ChatGptOAuthConcurrencyLease> {
  const limit = chatGptOAuthMaxConcurrency()
  const lane = concurrencyLanes.get(accountId) ?? { active: 0, waiters: [] }
  concurrencyLanes.set(accountId, lane)
  const queuedAt = Date.now()

  if (lane.active < limit) {
    lane.active++
    return leaseFor({ accountId, lane, limit, queuedAt, queueDepthAtEnqueue: 0 })
  }

  return new Promise<ChatGptOAuthConcurrencyLease>((resolve) => {
    const queueDepthAtEnqueue = lane.waiters.length + 1
    lane.waiters.push({ queuedAt, queueDepthAtEnqueue, resolve })
  })
}

export type BridgeResult = {
  content: string
  toolCalls?: GatewayToolCall[]
  usage: { promptTokens: number; completionTokens: number }
  model: string
  oauthConcurrency: ChatGptOAuthConcurrencyDiagnostic
}

/**
 * Diagnosztikai összefoglaló üres OAuth-válaszhoz. Szándékosan csak protokoll-
 * metaadatot tartalmaz: prompt, token és modell-szöveg nem kerülhet a logba.
 */
export type ChatGptOAuthEmptyResponseDiagnostic = {
  concurrency: ChatGptOAuthConcurrencyDiagnostic
  request: {
    /** A POST body UTF-8 mérete; nem maga a body. */
    serializedChars: number
    instructionChars: number
    inputItemCount: number
    byRole: Record<'system' | 'user' | 'assistant' | 'tool', { count: number; chars: number }>
    assistantToolCallCount: number
    toolDefinitions: { count: number; serializedChars: number }
    /** Csak az utolsó tool-eredmény méretét + nevét őrizzük meg. */
    lastTool: { name: string; chars: number; callIdPresent: boolean } | null
  }
  http: {
    status: number
    statusText: string
    mimeType: string | null
    requestId: string | null
  }
  sse: {
    eventTypeCounts: Record<string, number>
    parseErrorCount: number
    textDeltaCount: number
    textDeltaChars: number
    toolCallCount: number
    outputItemTypeCounts: Record<string, number>
    terminal: Record<string, string | number | boolean | null>
  }
}

function requestProfile(params: {
  messages: GatewayMessage[]
  instructions: string
  inputItemCount: number
  responseTools: unknown[]
  serializedBody: string
}): ChatGptOAuthEmptyResponseDiagnostic['request'] {
  const byRole: ChatGptOAuthEmptyResponseDiagnostic['request']['byRole'] = {
    system: { count: 0, chars: 0 },
    user: { count: 0, chars: 0 },
    assistant: { count: 0, chars: 0 },
    tool: { count: 0, chars: 0 },
  }
  let assistantToolCallCount = 0
  let lastTool: ChatGptOAuthEmptyResponseDiagnostic['request']['lastTool'] = null

  for (const message of params.messages) {
    const text = message.role === 'assistant' ? message.content ?? '' : message.content
    byRole[message.role].count++
    byRole[message.role].chars += text.length
    if (message.role === 'assistant') assistantToolCallCount += message.toolCalls?.length ?? 0
    if (message.role === 'tool') {
      lastTool = {
        name: message.toolName,
        chars: message.content.length,
        callIdPresent: Boolean(message.toolCallId),
      }
    }
  }

  return {
    serializedChars: Buffer.byteLength(params.serializedBody, 'utf8'),
    instructionChars: params.instructions.length,
    inputItemCount: params.inputItemCount,
    byRole,
    assistantToolCallCount,
    toolDefinitions: {
      count: params.responseTools.length,
      serializedChars: JSON.stringify(params.responseTools).length,
    },
    lastTool,
  }
}

/** Az upstream sikeres HTTP-válasza nem adott értelmezhető agent-kimenetet. */
export class ChatGptOAuthEmptyContentError extends Error {
  constructor(readonly diagnostic: ChatGptOAuthEmptyResponseDiagnostic) {
    super('ChatGPT OAuth backend returned empty content')
    this.name = 'ChatGptOAuthEmptyContentError'
  }
}

/**
 * A Responses backend explicit `response.failed` eseményt küldött. Ez nem
 * tartalmi hiba: a Gateway fallback/retry rétegének szolgáltatói kiesésként
 * kell kezelnie.
 */
export class ChatGptOAuthResponseFailedError extends Error {
  constructor(
    readonly diagnostic: ChatGptOAuthEmptyResponseDiagnostic,
    readonly code: string | null,
  ) {
    super(`ChatGPT OAuth provider failed: ${code ?? 'unknown_response_failure'}`)
    this.name = 'ChatGptOAuthResponseFailedError'
  }
}

export function chatGptOAuthDiagnostic(error: unknown): ChatGptOAuthEmptyResponseDiagnostic | undefined {
  if (
    error instanceof ChatGptOAuthEmptyContentError ||
    error instanceof ChatGptOAuthResponseFailedError
  ) {
    return error.diagnostic
  }
  return undefined
}

function incrementCounter(counters: Record<string, number>, raw: unknown): void {
  const key = typeof raw === 'string' && raw ? raw.slice(0, 120) : 'unknown'
  counters[key] = (counters[key] ?? 0) + 1
}

/** Csak a hiba okához szükséges, nem érzékeny terminális mezőket emeli ki. */
function terminalSseFields(event: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const response = event.response
  const error = event.error
  const incomplete = response && typeof response === 'object'
    ? (response as Record<string, unknown>).incomplete_details
    : undefined
  const responseError = response && typeof response === 'object'
    ? (response as Record<string, unknown>).error
    : undefined

  const read = (source: unknown, key: string): string | number | boolean | null => {
    if (!source || typeof source !== 'object') return null
    const value = (source as Record<string, unknown>)[key]
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null
  }

  return {
    eventType: typeof event.type === 'string' ? event.type : null,
    responseStatus: read(response, 'status'),
    incompleteReason: read(incomplete, 'reason'),
    errorCode: read(error, 'code') ?? read(responseError, 'code'),
    errorType: read(error, 'type') ?? read(responseError, 'type'),
  }
}

/** A JWT `exp` (másodperc) kiolvasása lejárat-ellenőrzéshez. */
export function accessTokenExpiry(accessToken: string): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

/** Lejárt-e (vagy `skewSeconds`-en belül lejár-e) az access token. */
export function isAccessTokenExpired(accessToken: string, skewSeconds = 60): boolean {
  const exp = accessTokenExpiry(accessToken)
  if (exp === null) return false
  return exp * 1000 - Date.now() < skewSeconds * 1000
}

/** Új access/refresh token a refresh_token-nel (Codex OAuth kliens). */
export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string
  refreshToken: string
  idToken?: string
}> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'openid profile email',
    }),
  })
  if (!res.ok) {
    throw new Error(`OAuth token refresh failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  }
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string }
  if (!data.access_token) throw new Error('OAuth token refresh returned no access_token')
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    idToken: data.id_token,
  }
}

/**
 * Stub választ szavak szerint streameli — a valódi provider nélküli
 * fejlesztői módban is látható a token-by-token megjelenés.
 */
export async function* stubChatStream(content: string): AsyncGenerator<string, void, unknown> {
  const words = content.split(' ')
  for (let i = 0; i < words.length; i++) {
    yield i === 0 ? words[i] : ` ${words[i]}`
    await new Promise<void>((r) => setTimeout(r, 30))
  }
}

/**
 * A ChatGPT Responses backend reasoning-summary delta eseménye. A `reasoning`
 * kérésre a backend a gondolkodás rövid összefoglalóját streameli — külön
 * eseménytípuson, NEM az `output_text` csatornán. A pontos típusnév verziónként
 * eltérhet (`response.reasoning_summary_text.delta` / `response.reasoning_text.delta`),
 * ezért a végződésre illesztünk. A nyers reasoning-tartalom (`response.reasoning.*`,
 * "encrypted" vagy nyers gondolatlánc) SZÁNDÉKOSAN kimarad — csak az összefoglaló megy tovább.
 */
function reasoningSummaryDelta(evt: { type?: string; delta?: string }): string | null {
  if (typeof evt.type !== 'string' || typeof evt.delta !== 'string' || !evt.delta) return null
  if (/reasoning_summary_text\.delta$/.test(evt.type) || /reasoning_summary\.delta$/.test(evt.type)) {
    return evt.delta
  }
  return null
}

/**
 * Streaming variáns: a ChatGPT Responses backend SSE streamjét olvassa
 * inkrementálisan és `response.output_text.delta` eseményenként yield-el. Ha
 * `onReasoningDelta` meg van adva, a reasoning-summary deltákat oldalcsatornán
 * továbbadja (a yield-elt szöveg csak a válasz-token marad).
 */
type ChatGptOAuthStreamInput = {
  tokens: ChatGptOAuthTokens
  messages: GatewayMessage[]
  model: string
  reasoningEffort?: ReasoningEffort
  onReasoningDelta?: (delta: string) => void
}

async function* callChatGptOAuthStreamUnlocked(
  input: ChatGptOAuthStreamInput,
): AsyncGenerator<string, void, unknown> {
  const model = resolveModel(input.model)
  const { instructions, input: responsesInput } = toResponsesRequest(input.messages)

  const res = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.tokens.accessToken}`,
      'chatgpt-account-id': input.tokens.accountId,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'openai-beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      session_id: randomUUID(),
    },
    body: JSON.stringify({
      model,
      instructions,
      input: responsesInput,
      stream: true,
      store: false,
      reasoning: { effort: input.reasoningEffort ?? 'low' },
    }),
  })

  if (!res.ok) {
    const body = (await res.text()).slice(0, 400)
    throw new Error(`ChatGPT OAuth backend failed: ${res.status} ${body}`)
  }

  if (!res.body) throw new Error('ChatGPT OAuth backend returned no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let evt: { type?: string; delta?: string }
        try {
          evt = JSON.parse(payload) as typeof evt
        } catch {
          continue
        }
        if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string' && evt.delta) {
          yield evt.delta
        }
        if (input.onReasoningDelta) {
          const reasoning = reasoningSummaryDelta(evt)
          if (reasoning) input.onReasoningDelta(reasoning)
        }
        if (evt.type === 'response.completed') return
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function* callChatGptOAuthStream(
  input: ChatGptOAuthStreamInput,
): AsyncGenerator<string, void, unknown> {
  const lease = await acquireChatGptOAuthConcurrency(input.tokens.accountId)
  try {
    yield* callChatGptOAuthStreamUnlocked(input)
  } finally {
    lease.release()
  }
}

/**
 * Egy modellhívás a ChatGPT Responses backenden át. SSE streamet olvas, a
 * `response.output_text.delta` darabokat összefűzi, a `response.completed`
 * eseményből veszi a token-használatot.
 */
type ChatGptOAuthCallInput = {
  tokens: ChatGptOAuthTokens
  messages: GatewayMessage[]
  model: string
  tools?: ToolDefinition[]
  reasoningEffort?: ReasoningEffort
  /**
   * Ha meg van adva, a reasoning-summary deltákat érkezéskor (a válasz-token/tool-hívás
   * ELŐTT) továbbadja — ez teszi lehetővé a "gondolkodás közben" streamelést a
   * nem-streamelő tool-loopban is (az egész SSE-t inkrementálisan olvassuk).
   */
  onReasoningDelta?: (delta: string) => void
}

async function callChatGptOAuthUnlocked(
  input: ChatGptOAuthCallInput,
  oauthConcurrency: ChatGptOAuthConcurrencyDiagnostic,
): Promise<BridgeResult> {
  const model = resolveModel(input.model)
  const { instructions, input: responsesInput } = toResponsesRequest(input.messages)
  const responseToolNameToOriginal = new Map<string, string>()
  const responseTools =
    input.tools?.map((t, index) => {
      const base = sanitizeResponseToolName(t.name)
      const isCollision = responseToolNameToOriginal.has(base)
      const safeName = isCollision ? `${base}_${index}` : base
      responseToolNameToOriginal.set(safeName, t.name)
      return {
        type: 'function' as const,
        name: safeName,
        description: t.description,
        parameters: t.inputSchema,
      }
    }) ?? []

  const requestBody = {
    model,
    instructions,
    input: responsesInput,
    stream: true,
    store: false,
    reasoning: { effort: input.reasoningEffort ?? 'low' },
    ...(responseTools.length
      ? {
          tools: responseTools,
          tool_choice: 'auto',
        }
      : {}),
  }
  const serializedRequestBody = JSON.stringify(requestBody)
  const profile = requestProfile({
    messages: input.messages,
    instructions,
    inputItemCount: responsesInput.length,
    responseTools,
    serializedBody: serializedRequestBody,
  })

  const res = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.tokens.accessToken}`,
      'chatgpt-account-id': input.tokens.accountId,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'openai-beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      session_id: randomUUID(),
    },
    body: serializedRequestBody,
  })

  if (!res.ok) {
    const body = (await res.text()).slice(0, 400)
    throw new Error(`ChatGPT OAuth backend failed: ${res.status} ${body}`)
  }

  if (!res.body) throw new Error('ChatGPT OAuth backend returned no body')

  let content = ''
  let promptTokens = 0
  let completionTokens = 0
  const toolCalls: GatewayToolCall[] = []
  const eventTypeCounts: Record<string, number> = {}
  const outputItemTypeCounts: Record<string, number> = {}
  let parseErrorCount = 0
  let textDeltaCount = 0
  let textDeltaChars = 0
  let terminal: Record<string, string | number | boolean | null> = {}

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(payload)
    } catch {
      parseErrorCount++
      return
    }
    incrementCounter(eventTypeCounts, evt.type)
    if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
      content += evt.delta
      textDeltaCount++
      textDeltaChars += evt.delta.length
    }
    // Reasoning-summary delta: érkezéskor, a válasz-token/tool-hívás előtt megy ki.
    if (input.onReasoningDelta) {
      const reasoning = reasoningSummaryDelta(evt)
      if (reasoning) input.onReasoningDelta(reasoning)
    }
    // A modell egy kész tool hívása: function_call output item.
    const item = evt.item && typeof evt.item === 'object' ? evt.item as Record<string, unknown> : undefined
    if (evt.type === 'response.output_item.done' && item) {
      incrementCounter(outputItemTypeCounts, item.type)
    }
    if (evt.type === 'response.output_item.done' && item?.type === 'function_call') {
      const name = item.name
      if (typeof name === 'string' && name) {
        const resolvedName = responseToolNameToOriginal.get(name) ?? name
        let parsed: Record<string, unknown> = {}
        if (typeof item.arguments === 'string' && item.arguments.trim()) {
          try {
            const obj = JSON.parse(item.arguments)
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
              parsed = obj as Record<string, unknown>
            }
          } catch {
            // hibás argument JSON → üres input
          }
        }
        toolCalls.push({
          id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : `call_${toolCalls.length}`,
          name: resolvedName,
          input: parsed,
        })
      }
    }
    if (evt.type === 'response.completed' || evt.type === 'response.failed' || evt.type === 'response.incomplete') {
      terminal = terminalSseFields(evt)
    }
    const response = evt.response && typeof evt.response === 'object' ? evt.response as Record<string, unknown> : undefined
    const usage = response?.usage && typeof response.usage === 'object' ? response.usage as Record<string, unknown> : undefined
    if (evt.type === 'response.completed' && usage) {
      promptTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
      completionTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
    }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    }
  } finally {
    reader.releaseLock()
  }
  if (buffer) handleLine(buffer)

  const diagnostic = (): ChatGptOAuthEmptyResponseDiagnostic => ({
    concurrency: oauthConcurrency,
    request: profile,
    http: {
      status: res.status,
      statusText: res.statusText,
      mimeType: res.headers.get('content-type'),
      requestId: res.headers.get('x-request-id') ?? res.headers.get('request-id'),
    },
    sse: {
      eventTypeCounts,
      parseErrorCount,
      textDeltaCount,
      textDeltaChars,
      toolCallCount: toolCalls.length,
      outputItemTypeCounts,
      terminal,
    },
  })

  if (terminal.eventType === 'response.failed') {
    const code = typeof terminal.errorCode === 'string' ? terminal.errorCode : null
    throw new ChatGptOAuthResponseFailedError(diagnostic(), code)
  }

  // Tool-only válasznál a content üres — csak akkor hiba, ha sem szöveg, sem
  // tool hívás nem jött vissza.
  if (!content.trim() && toolCalls.length === 0) {
    throw new ChatGptOAuthEmptyContentError(diagnostic())
  }

  return {
    content,
    ...(toolCalls.length ? { toolCalls } : {}),
    usage: { promptTokens, completionTokens },
    model,
    oauthConcurrency,
  }
}

export async function callChatGptOAuth(
  input: ChatGptOAuthCallInput,
): Promise<BridgeResult> {
  const lease = await acquireChatGptOAuthConcurrency(input.tokens.accountId)
  try {
    return await callChatGptOAuthUnlocked(input, lease.diagnostic)
  } finally {
    lease.release()
  }
}
