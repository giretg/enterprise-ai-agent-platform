/**
 * Grok CLI OAuth mediáció — a ChatGPT/Codex OAuth híd mintája.
 *
 * A hivatalos Grok CLI (`grok login`) SuperGrok / X Premium+ session tokenjét
 * használjuk, nem xAI API-kulcsot. A token a ~/.grok/auth.json-ban él, lejáratkor
 * az auth.x.ai OIDC refresh-sel forog, és a CLI chat-proxyra megy
 * (előfizetéses kvóta, nem console.x.ai per-token számla).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GatewayMessage, GatewayToolCall, ToolDefinition } from './model-gateway'

export const GROK_CLI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const TOKEN_URL = 'https://auth.x.ai/oauth2/token'
const DEFAULT_CHAT_URL = 'https://cli-chat-proxy.grok.com/v1/chat/completions'
const DEFAULT_CLIENT_VERSION = '1.0.5'

export const DEFAULT_GROK_CLI_OAUTH_REQUEST_TIMEOUT_MS = 120_000

export function grokCliOAuthRequestTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.GROK_CLI_OAUTH_REQUEST_TIMEOUT_MS?.trim()
  const parsed = raw ? Number(raw) : DEFAULT_GROK_CLI_OAUTH_REQUEST_TIMEOUT_MS
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_GROK_CLI_OAUTH_REQUEST_TIMEOUT_MS
}

export class GrokCliOAuthBackendError extends Error {
  constructor(
    readonly kind: 'http' | 'network' | 'timeout',
    readonly status?: number,
    timeoutMs?: number,
  ) {
    super(
      kind === 'timeout'
        ? `Grok CLI OAuth backend request timed out after ${timeoutMs}ms`
        : kind === 'http'
          ? `Grok CLI OAuth backend failed: ${status}`
          : 'Grok CLI OAuth backend network request failed',
    )
    this.name = 'GrokCliOAuthBackendError'
  }
}

type TimedRequest = {
  response: Response
  timedOut: () => boolean
  close: () => void
}

async function startTimedRequest(url: string, init: RequestInit): Promise<TimedRequest> {
  const controller = new AbortController()
  const timeoutMs = grokCliOAuthRequestTimeoutMs()
  let didTimeOut = false
  const timer = setTimeout(() => {
    didTimeOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return {
      response,
      timedOut: () => didTimeOut,
      close: () => {
        clearTimeout(timer)
        controller.abort()
      },
    }
  } catch {
    clearTimeout(timer)
    throw new GrokCliOAuthBackendError(didTimeOut ? 'timeout' : 'network', undefined, timeoutMs)
  }
}

function backendReadError(request: TimedRequest, error: unknown): never {
  if (request.timedOut() || (error instanceof Error && error.name === 'AbortError')) {
    throw new GrokCliOAuthBackendError('timeout', undefined, grokCliOAuthRequestTimeoutMs())
  }
  throw error
}

function successfulResponse(request: TimedRequest): Response {
  if (!request.response.ok) {
    throw new GrokCliOAuthBackendError('http', request.response.status)
  }
  return request.response
}

export function resolveGrokCliModel(requested: string | undefined): string {
  const fallback = process.env.GROK_CLI_OAUTH_MODEL?.trim() || 'grok-4.6'
  if (!requested || requested === 'grok-cli-oauth-default') return fallback
  return requested
}

export type GrokReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export function resolveGrokReasoningEffort(modelType: string | undefined): GrokReasoningEffort {
  if (modelType === 'luna') return 'low'
  if (modelType === 'sol') return 'xhigh'
  return 'high'
}

export type GrokCliAuthEntry = {
  entryKey: string
  accessToken: string
  refreshToken: string
  clientId: string
  expiresAt?: string
  raw: Record<string, unknown>
}

type GrokAuthFile = Record<string, Record<string, unknown>>

export function grokAuthFilePath(env: Record<string, string | undefined> = process.env): string {
  return env.GROK_AUTH_FILE?.trim() || join(homedir(), '.grok', 'auth.json')
}

export function parseGrokAuthFile(raw: string): GrokCliAuthEntry {
  const parsed = JSON.parse(raw) as GrokAuthFile
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Grok CLI auth file is not an object')
  }
  const preferred = Object.entries(parsed).find(([key, value]) => {
    return key.includes('auth.x.ai') && typeof value?.key === 'string' && typeof value?.refresh_token === 'string'
  })
  const fallback = Object.entries(parsed).find(([, value]) => {
    return typeof value?.key === 'string' && typeof value?.refresh_token === 'string'
  })
  const selected = preferred ?? fallback
  if (!selected) throw new Error('Grok CLI auth file missing access token / refresh_token')
  const [entryKey, value] = selected
  const clientId =
    (typeof value.oidc_client_id === 'string' && value.oidc_client_id) ||
    entryKey.split('::')[1] ||
    GROK_CLI_OAUTH_CLIENT_ID
  return {
    entryKey,
    accessToken: value.key as string,
    refreshToken: value.refresh_token as string,
    clientId,
    expiresAt: typeof value.expires_at === 'string' ? value.expires_at : undefined,
    raw: value,
  }
}

export function isGrokAccessTokenExpired(entry: GrokCliAuthEntry, skewMs = 60_000): boolean {
  if (!entry.expiresAt) return false
  const expires = Date.parse(entry.expiresAt)
  if (!Number.isFinite(expires)) return false
  return expires - Date.now() < skewMs
}

export function createGrokCliTokenStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
): GrokCliAuthEntry | null {
  if (env.GROK_CLI_OAUTH_EMBEDDED !== 'true') return null
  const path = grokAuthFilePath(env)
  if (!existsSync(path)) return null
  return parseGrokAuthFile(readFileSync(path, 'utf8'))
}

function writeGrokAuthEntry(path: string, entry: GrokCliAuthEntry): void {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as GrokAuthFile
  parsed[entry.entryKey] = {
    ...entry.raw,
    key: entry.accessToken,
    refresh_token: entry.refreshToken,
    ...(entry.expiresAt ? { expires_at: entry.expiresAt } : {}),
  }
  writeFileSync(path, JSON.stringify(parsed, null, 2), { mode: 0o600 })
}

export async function refreshGrokCliAccessToken(entry: GrokCliAuthEntry): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt?: string
}> {
  const request = await startTimedRequest(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: entry.refreshToken,
      client_id: entry.clientId,
    }).toString(),
  })
  try {
    const response = successfulResponse(request)
    let data: { access_token?: string; refresh_token?: string; expires_in?: number; expires_at?: string }
    try {
      data = (await response.json()) as typeof data
    } catch (error) {
      backendReadError(request, error)
    }
    if (!data.access_token) throw new Error('Grok CLI OAuth refresh returned no access_token')
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? entry.refreshToken,
      expiresAt: typeof data.expires_in === 'number'
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : data.expires_at ?? entry.expiresAt,
    }
  } finally {
    request.close()
  }
}

export async function ensureFreshGrokCliTokens(): Promise<GrokCliAuthEntry> {
  const current = createGrokCliTokenStoreFromEnv()
  if (!current) {
    throw new Error(
      'Grok CLI OAuth is not configured (állítsd be GROK_CLI_OAUTH_EMBEDDED=true, és futtasd: grok login)',
    )
  }
  if (!isGrokAccessTokenExpired(current)) return current
  const refreshed = await refreshGrokCliAccessToken(current)
  const next: GrokCliAuthEntry = {
    ...current,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
    raw: {
      ...current.raw,
      key: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      ...(refreshed.expiresAt ? { expires_at: refreshed.expiresAt } : {}),
    },
  }
  writeGrokAuthEntry(grokAuthFilePath(), next)
  return next
}

export function detectGrokCliClientVersion(
  env: Record<string, string | undefined> = process.env,
): string {
  const pinned = env.GROK_CLI_CLIENT_VERSION?.trim()
  if (pinned) return pinned
  try {
    const out = execFileSync('grok', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
    const match = out.match(/(\d+\.\d+\.\d+)/)
    if (match) return match[1]
  } catch {
    // a CLI hiányozhat CI-ben / sidecar nélkül
  }
  return DEFAULT_CLIENT_VERSION
}

type OpenAiChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export function toGrokChatMessages(messages: GatewayMessage[]): OpenAiChatMessage[] {
  return messages.map((m): OpenAiChatMessage => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      }
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    }
    return { role: m.role, content: m.content }
  })
}

function grokRequestHeaders(accessToken: string, model: string, stream: boolean): Record<string, string> {
  const version = detectGrokCliClientVersion()
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-version': version,
    'x-grok-client-identifier': 'grok-shell',
    'x-grok-model-override': model,
    'user-agent': `grok-cli/${version}`,
    ...(stream ? { accept: 'text/event-stream' } : {}),
  }
}

export type GrokCliBridgeResult = {
  content: string
  toolCalls?: GatewayToolCall[]
  usage: { promptTokens: number; completionTokens: number }
  model: string
}

type GrokCallInput = {
  tokens: GrokCliAuthEntry
  messages: GatewayMessage[]
  model: string
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  reasoningEffort?: GrokReasoningEffort
  onReasoningDelta?: (delta: string) => void
}

function grokChatUrl(env: Record<string, string | undefined> = process.env): string {
  return env.GROK_CLI_OAUTH_CHAT_URL?.trim() || DEFAULT_CHAT_URL
}

function extractGrokToolCalls(rawCalls: unknown): GatewayToolCall[] {
  if (!Array.isArray(rawCalls)) return []
  const calls: GatewayToolCall[] = []
  for (const [index, call] of rawCalls.entries()) {
    if (!call || typeof call !== 'object') continue
    const fn = (call as { function?: { name?: string; arguments?: string }; id?: string }).function
    const name = fn?.name
    if (typeof name !== 'string' || !name) continue
    let input: Record<string, unknown> = {}
    if (typeof fn?.arguments === 'string' && fn.arguments.trim()) {
      try {
        const parsed = JSON.parse(fn.arguments) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>
        }
      } catch {
        // hibás argument JSON → üres input
      }
    }
    calls.push({
      id: typeof (call as { id?: string }).id === 'string'
        ? (call as { id: string }).id
        : `call_${index}`,
      name,
      input,
    })
  }
  return calls
}

export async function callGrokCliOAuth(input: GrokCallInput): Promise<GrokCliBridgeResult> {
  const model = resolveGrokCliModel(input.model)
  const body: Record<string, unknown> = {
    model,
    messages: toGrokChatMessages(input.messages),
    stream: false,
    ...(input.temperature != null ? { temperature: input.temperature } : {}),
    ...(input.maxTokens != null ? { max_tokens: input.maxTokens } : {}),
    ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
    ...(input.tools?.length
      ? {
          tools: input.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
          tool_choice: 'auto',
        }
      : {}),
  }

  const request = await startTimedRequest(grokChatUrl(), {
    method: 'POST',
    headers: grokRequestHeaders(input.tokens.accessToken, model, false),
    body: JSON.stringify(body),
  })
  try {
    const response = successfulResponse(request)
    let data: {
      choices?: Array<{
        message?: { content?: string | Array<{ text?: string }>; reasoning?: string; tool_calls?: unknown }
        text?: string
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
      model?: string
    }
    try {
      data = (await response.json()) as typeof data
    } catch (error) {
      backendReadError(request, error)
    }
    const message = data.choices?.[0]?.message
    let content = ''
    if (typeof message?.content === 'string') content = message.content
    else if (Array.isArray(message?.content)) {
      content = message.content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('')
    } else if (typeof data.choices?.[0]?.text === 'string') {
      content = data.choices[0].text
    }
    const toolCalls = extractGrokToolCalls(message?.tool_calls)
    if (
      input.onReasoningDelta &&
      typeof message?.reasoning === 'string' &&
      message.reasoning.trim() &&
      message.reasoning !== content
    ) {
      input.onReasoningDelta(message.reasoning)
    }
    if (!content.trim() && toolCalls.length === 0) {
      throw new Error('Grok CLI OAuth backend returned empty content')
    }
    return {
      content,
      ...(toolCalls.length ? { toolCalls } : {}),
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
      model: data.model ?? model,
    }
  } finally {
    request.close()
  }
}

export async function* callGrokCliOAuthStream(input: {
  tokens: GrokCliAuthEntry
  messages: GatewayMessage[]
  model: string
  reasoningEffort?: GrokReasoningEffort
  onReasoningDelta?: (delta: string) => void
}): AsyncGenerator<string, void, unknown> {
  const model = resolveGrokCliModel(input.model)
  const request = await startTimedRequest(grokChatUrl(), {
    method: 'POST',
    headers: grokRequestHeaders(input.tokens.accessToken, model, true),
    body: JSON.stringify({
      model,
      messages: toGrokChatMessages(input.messages),
      stream: true,
      ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
    }),
  })
  try {
    const response = successfulResponse(request)
    if (!response.body) throw new Error('Grok CLI OAuth backend returned no body')
    const reader = response.body.getReader()
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
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const payload = trimmed.slice(6)
          if (payload === '[DONE]') return
          let parsed: { choices?: Array<{ delta?: { content?: string; reasoning?: string } }> }
          try {
            parsed = JSON.parse(payload) as typeof parsed
          } catch {
            continue
          }
          const delta = parsed.choices?.[0]?.delta
          if (input.onReasoningDelta && typeof delta?.reasoning === 'string' && delta.reasoning) {
            input.onReasoningDelta(delta.reasoning)
          }
          if (typeof delta?.content === 'string' && delta.content) yield delta.content
        }
      }
    } finally {
      reader.releaseLock()
    }
  } catch (error) {
    backendReadError(request, error)
  } finally {
    request.close()
  }
}
