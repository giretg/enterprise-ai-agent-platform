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

export type BridgeResult = {
  content: string
  toolCalls?: GatewayToolCall[]
  usage: { promptTokens: number; completionTokens: number }
  model: string
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
 * Streaming variáns: a ChatGPT Responses backend SSE streamjét olvassa
 * inkrementálisan és `response.output_text.delta` eseményenként yield-el.
 */
export async function* callChatGptOAuthStream(input: {
  tokens: ChatGptOAuthTokens
  messages: GatewayMessage[]
  model: string
  reasoningEffort?: 'low' | 'medium' | 'high'
}): AsyncGenerator<string, void, unknown> {
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
        if (evt.type === 'response.completed') return
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Egy modellhívás a ChatGPT Responses backenden át. SSE streamet olvas, a
 * `response.output_text.delta` darabokat összefűzi, a `response.completed`
 * eseményből veszi a token-használatot.
 */
export async function callChatGptOAuth(input: {
  tokens: ChatGptOAuthTokens
  messages: GatewayMessage[]
  model: string
  tools?: ToolDefinition[]
  reasoningEffort?: 'low' | 'medium' | 'high'
}): Promise<BridgeResult> {
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
      ...(responseTools.length
        ? {
            tools: responseTools,
            tool_choice: 'auto',
          }
        : {}),
    }),
  })

  if (!res.ok) {
    const body = (await res.text()).slice(0, 400)
    throw new Error(`ChatGPT OAuth backend failed: ${res.status} ${body}`)
  }

  const raw = await res.text()
  let content = ''
  let promptTokens = 0
  let completionTokens = 0
  const toolCalls: GatewayToolCall[] = []
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let evt: {
      type?: string
      delta?: string
      item?: { type?: string; name?: string; arguments?: string; call_id?: string; id?: string }
      response?: { usage?: { input_tokens?: number; output_tokens?: number } }
    }
    try {
      evt = JSON.parse(payload)
    } catch {
      continue
    }
    if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
      content += evt.delta
    }
    // A modell egy kész tool hívása: function_call output item.
    if (evt.type === 'response.output_item.done' && evt.item?.type === 'function_call') {
      const name = evt.item.name
      if (typeof name === 'string' && name) {
        const resolvedName = responseToolNameToOriginal.get(name) ?? name
        let parsed: Record<string, unknown> = {}
        if (typeof evt.item.arguments === 'string' && evt.item.arguments.trim()) {
          try {
            const obj = JSON.parse(evt.item.arguments)
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
              parsed = obj as Record<string, unknown>
            }
          } catch {
            // hibás argument JSON → üres input
          }
        }
        toolCalls.push({
          id: evt.item.call_id || evt.item.id || `call_${toolCalls.length}`,
          name: resolvedName,
          input: parsed,
        })
      }
    }
    if (evt.type === 'response.completed' && evt.response?.usage) {
      promptTokens = evt.response.usage.input_tokens ?? 0
      completionTokens = evt.response.usage.output_tokens ?? 0
    }
  }

  // Tool-only válasznál a content üres — csak akkor hiba, ha sem szöveg, sem
  // tool hívás nem jött vissza.
  if (!content.trim() && toolCalls.length === 0) {
    throw new Error('ChatGPT OAuth backend returned empty content')
  }

  return {
    content,
    ...(toolCalls.length ? { toolCalls } : {}),
    usage: { promptTokens, completionTokens },
    model,
  }
}
