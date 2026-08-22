/**
 * Claude Code OAuth mediáció — a ChatGPT/Codex OAuth híd mintája.
 *
 * A Claude Code CLI (`claude auth login` / `claude setup-token`) előfizetéses
 * OAuth tokenjét használjuk, nem Anthropic API-kulcsot. A token szerveroldalon
 * marad: macOS Keychain, ~/.claude/.credentials.json, vagy CLAUDE_CODE_OAUTH_TOKEN.
 *
 * Az Anthropic Messages API OAuth-úton a Claude Code kliens-identitást várja
 * (első system-blokk + beta headerek). Ez a híd ugyanazt a kaput küldi, amit
 * a CLI is; a modellnek szóló utasítás a második system-blokkban van.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GatewayMessage, GatewayToolCall, ToolDefinition } from './model-gateway'

/** A Claude Code CLI nyilvános OAuth kliens-azonosítója (refresh flow). */
export const CLAUDE_CODE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

export const CLAUDE_CODE_IDENTITY_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude."

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const SECURITY_ENTRY_NOT_FOUND = 44

export const DEFAULT_CLAUDE_CODE_OAUTH_REQUEST_TIMEOUT_MS = 120_000

export function claudeCodeOAuthRequestTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.CLAUDE_CODE_OAUTH_REQUEST_TIMEOUT_MS?.trim()
  const parsed = raw ? Number(raw) : DEFAULT_CLAUDE_CODE_OAUTH_REQUEST_TIMEOUT_MS
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_CLAUDE_CODE_OAUTH_REQUEST_TIMEOUT_MS
}

export class ClaudeCodeOAuthBackendError extends Error {
  constructor(
    readonly kind: 'http' | 'network' | 'timeout',
    readonly status?: number,
    timeoutMs?: number,
  ) {
    super(
      kind === 'timeout'
        ? `Claude Code OAuth backend request timed out after ${timeoutMs}ms`
        : kind === 'http'
          ? `Claude Code OAuth backend failed: ${status}`
          : 'Claude Code OAuth backend network request failed',
    )
    this.name = 'ClaudeCodeOAuthBackendError'
  }
}

type TimedRequest = {
  response: Response
  timedOut: () => boolean
  close: () => void
}

async function startTimedRequest(url: string, init: RequestInit): Promise<TimedRequest> {
  const controller = new AbortController()
  const timeoutMs = claudeCodeOAuthRequestTimeoutMs()
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
    throw new ClaudeCodeOAuthBackendError(didTimeOut ? 'timeout' : 'network', undefined, timeoutMs)
  }
}

function backendReadError(request: TimedRequest, error: unknown): never {
  if (request.timedOut() || (error instanceof Error && error.name === 'AbortError')) {
    throw new ClaudeCodeOAuthBackendError('timeout', undefined, claudeCodeOAuthRequestTimeoutMs())
  }
  throw error
}

function successfulResponse(request: TimedRequest): Response {
  if (!request.response.ok) {
    throw new ClaudeCodeOAuthBackendError('http', request.response.status)
  }
  return request.response
}

export function resolveClaudeCodeModel(requested: string | undefined): string {
  const fallback = process.env.CLAUDE_CODE_OAUTH_MODEL?.trim() || 'claude-sonnet-4-6'
  if (!requested || requested === 'claude-code-oauth-default') return fallback
  return requested
}

export type ClaudeThinkingBudget = number | null

/** luna/terra/sol → Anthropic thinking budget. Luna: ki; terra/sol: engedélyezett, max_tokens alatt. */
export function resolveClaudeThinkingBudget(modelType: string | undefined): ClaudeThinkingBudget {
  if (modelType === 'terra') return 2_048
  if (modelType === 'sol') return 6_144
  return null
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

type AnthropicTextBlock = { type: 'text'; text: string }
type AnthropicToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
type AnthropicToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string }
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock
type AnthropicMessage = { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }

export type AnthropicRequestShape = {
  system: AnthropicTextBlock[]
  messages: AnthropicMessage[]
}

/**
 * Gateway üzenetek → Anthropic Messages. Az első system-blokk mindig a Claude Code
 * identitás (OAuth kapu); a platform system-promptjai utána jönnek.
 */
export function toAnthropicRequest(messages: GatewayMessage[]): AnthropicRequestShape {
  const system: AnthropicTextBlock[] = [{ type: 'text', text: CLAUDE_CODE_IDENTITY_PROMPT }]
  const extraSystem = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content.trim())
    .filter(Boolean)
  if (extraSystem.length) {
    system.push({ type: 'text', text: extraSystem.join('\n\n') })
  }

  const out: AnthropicMessage[] = []
  const pendingToolResults: AnthropicToolResultBlock[] = []

  const flushToolResults = () => {
    if (!pendingToolResults.length) return
    out.push({ role: 'user', content: pendingToolResults.splice(0) })
  }

  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
      })
      continue
    }
    flushToolResults()
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
      continue
    }
    const blocks: AnthropicContentBlock[] = []
    if (m.content?.trim()) blocks.push({ type: 'text', text: m.content })
    for (const call of m.toolCalls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: sanitizeToolName(call.name),
        input: call.input ?? {},
      })
    }
    if (blocks.length) out.push({ role: 'assistant', content: blocks })
  }
  flushToolResults()

  if (out.length === 0) {
    out.push({ role: 'user', content: extraSystem.at(-1) || 'Hello' })
  }
  return { system, messages: out }
}

export type ClaudeCodeOAuthTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  subscriptionType?: string
}

export type ClaudeCodeCredentialSource = 'env' | 'keychain' | 'file'

export type ClaudeCodeStoredCredential = ClaudeCodeOAuthTokens & {
  source: ClaudeCodeCredentialSource
  filePath?: string
}

type ClaudeAiOauthBlob = {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    subscriptionType?: string
  }
}

export function parseClaudeCodeCredentialJson(raw: string): ClaudeCodeOAuthTokens {
  const parsed = JSON.parse(raw) as ClaudeAiOauthBlob
  const inner = parsed.claudeAiOauth
  if (!inner || typeof inner.accessToken !== 'string' || !inner.accessToken) {
    throw new Error('Claude Code credential missing claudeAiOauth.accessToken')
  }
  return {
    accessToken: inner.accessToken,
    refreshToken: typeof inner.refreshToken === 'string' ? inner.refreshToken : undefined,
    expiresAt: typeof inner.expiresAt === 'number' ? inner.expiresAt : undefined,
    subscriptionType: typeof inner.subscriptionType === 'string' ? inner.subscriptionType : undefined,
  }
}

function toCredentialFileShape(tokens: ClaudeCodeOAuthTokens): ClaudeAiOauthBlob {
  return {
    claudeAiOauth: {
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.expiresAt != null ? { expiresAt: tokens.expiresAt } : {}),
      ...(tokens.subscriptionType ? { subscriptionType: tokens.subscriptionType } : {}),
    },
  }
}

function defaultCredentialsPath(): string {
  return process.env.CLAUDE_CODE_AUTH_FILE?.trim() || join(homedir(), '.claude', '.credentials.json')
}

function readFromMacosKeychain(): ClaudeCodeOAuthTokens | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 },
    )
    const trimmed = out.trim()
    if (!trimmed) return null
    return parseClaudeCodeCredentialJson(trimmed)
  } catch (error) {
    const status = (error as NodeJS.ErrnoException & { status?: number }).status
    if (status === SECURITY_ENTRY_NOT_FOUND) return null
    return null
  }
}

function writeToMacosKeychain(tokens: ClaudeCodeOAuthTokens): void {
  if (process.platform !== 'darwin') return
  const blob = JSON.stringify(toCredentialFileShape(tokens))
  execFileSync(
    'security',
    ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', process.env.USER || 'claude', '-w', blob],
    { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: 5_000 },
  )
}

export function isClaudeCodeCredentialExpired(tokens: ClaudeCodeOAuthTokens, skewMs = 60_000): boolean {
  if (tokens.expiresAt == null) return false
  return Date.now() + skewMs >= tokens.expiresAt
}

export function createClaudeCodeTokenStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
): ClaudeCodeStoredCredential | null {
  const setupToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  if (setupToken) {
    return { accessToken: setupToken, source: 'env' }
  }
  if (env.CLAUDE_CODE_OAUTH_EMBEDDED !== 'true') return null

  const keychain = readFromMacosKeychain()
  if (keychain) return { ...keychain, source: 'keychain' }

  const filePath = defaultCredentialsPath()
  if (!existsSync(filePath)) return null
  return { ...parseClaudeCodeCredentialJson(readFileSync(filePath, 'utf8')), source: 'file', filePath }
}

async function persistClaudeCodeTokens(current: ClaudeCodeStoredCredential, next: ClaudeCodeOAuthTokens): Promise<void> {
  if (current.source === 'env') return
  if (current.source === 'file' && current.filePath) {
    writeFileSync(current.filePath, JSON.stringify(toCredentialFileShape(next), null, 2), { mode: 0o600 })
    return
  }
  if (current.source === 'keychain') {
    try {
      writeToMacosKeychain(next)
    } catch {
      // A Keychain írás opcionális write-back; a friss token a folyamatban így is él.
    }
  }
}

export async function refreshClaudeCodeAccessToken(refreshToken: string): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt?: number
}> {
  const request = await startTimedRequest(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_CODE_OAUTH_CLIENT_ID,
    }),
  })
  try {
    const response = successfulResponse(request)
    let data: { access_token?: string; refresh_token?: string; expires_in?: number }
    try {
      data = (await response.json()) as typeof data
    } catch (error) {
      backendReadError(request, error)
    }
    if (!data.access_token) throw new Error('Claude Code OAuth refresh returned no access_token')
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: typeof data.expires_in === 'number'
        ? Date.now() + data.expires_in * 1000
        : undefined,
    }
  } finally {
    request.close()
  }
}

export async function ensureFreshClaudeCodeTokens(): Promise<ClaudeCodeOAuthTokens> {
  const current = createClaudeCodeTokenStoreFromEnv()
  if (!current) {
    throw new Error(
      'Claude Code OAuth is not configured (állítsd be CLAUDE_CODE_OAUTH_EMBEDDED=true a `claude auth login` sessionhöz, vagy CLAUDE_CODE_OAUTH_TOKEN-t a `claude setup-token` kimenetével)',
    )
  }
  if (!isClaudeCodeCredentialExpired(current) || !current.refreshToken) {
    return current
  }
  const refreshed = await refreshClaudeCodeAccessToken(current.refreshToken)
  const next: ClaudeCodeOAuthTokens = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt ?? current.expiresAt,
    subscriptionType: current.subscriptionType,
  }
  await persistClaudeCodeTokens(current, next)
  return next
}

function claudeRequestHeaders(accessToken: string, thinkingEnabled: boolean): Record<string, string> {
  const version = process.env.CLAUDE_CODE_CLI_VERSION?.trim() || '2.1.239'
  const betas = thinkingEnabled
    ? 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14'
    : 'claude-code-20250219,oauth-2025-04-20'
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': betas,
    'user-agent': `claude-cli/${version} (external, cli)`,
    'x-app': 'cli',
  }
}

export type ClaudeCodeBridgeResult = {
  content: string
  toolCalls?: GatewayToolCall[]
  usage: { promptTokens: number; completionTokens: number }
  model: string
}

type ClaudeCodeCallInput = {
  tokens: ClaudeCodeOAuthTokens
  messages: GatewayMessage[]
  model: string
  tools?: ToolDefinition[]
  maxTokens?: number
  thinkingBudget?: ClaudeThinkingBudget
  onReasoningDelta?: (delta: string) => void
}

function buildClaudeBody(input: ClaudeCodeCallInput, stream: boolean): Record<string, unknown> {
  const model = resolveClaudeCodeModel(input.model)
  const { system, messages } = toAnthropicRequest(input.messages)
  const toolNameToOriginal = new Map<string, string>()
  const tools = input.tools?.map((t, index) => {
    const base = sanitizeToolName(t.name)
    const safeName = toolNameToOriginal.has(base) ? `${base}_${index}` : base
    toolNameToOriginal.set(safeName, t.name)
    return {
      name: safeName,
      description: t.description,
      input_schema: t.inputSchema,
    }
  })
  return {
    model,
    max_tokens: input.maxTokens && input.maxTokens > 0 ? input.maxTokens : 8_192,
    system,
    messages,
    stream,
    ...(tools?.length ? { tools } : {}),
    ...(input.thinkingBudget
      ? { thinking: { type: 'enabled', budget_tokens: input.thinkingBudget } }
      : {}),
    __toolNameToOriginal: toolNameToOriginal,
  }
}

type AnthropicContentItem = {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

function parseClaudeContent(
  content: AnthropicContentItem[] | undefined,
  toolNameToOriginal: Map<string, string>,
  onReasoningDelta?: (delta: string) => void,
): { text: string; toolCalls: GatewayToolCall[] } {
  let text = ''
  const toolCalls: GatewayToolCall[] = []
  for (const block of content ?? []) {
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      onReasoningDelta?.(block.thinking)
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text
      continue
    }
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
      toolCalls.push({
        id: typeof block.id === 'string' && block.id ? block.id : `call_${toolCalls.length}`,
        name: toolNameToOriginal.get(block.name) ?? block.name,
        input: block.input && typeof block.input === 'object' ? block.input : {},
      })
    }
  }
  return { text, toolCalls }
}

export async function callClaudeCodeOAuth(input: ClaudeCodeCallInput): Promise<ClaudeCodeBridgeResult> {
  const body = buildClaudeBody(input, false)
  const toolNameToOriginal = body.__toolNameToOriginal as Map<string, string>
  delete body.__toolNameToOriginal

  const request = await startTimedRequest(MESSAGES_URL, {
    method: 'POST',
    headers: claudeRequestHeaders(input.tokens.accessToken, Boolean(input.thinkingBudget)),
    body: JSON.stringify(body),
  })
  try {
    const response = successfulResponse(request)
    let data: {
      content?: AnthropicContentItem[]
      usage?: { input_tokens?: number; output_tokens?: number }
      model?: string
    }
    try {
      data = (await response.json()) as typeof data
    } catch (error) {
      backendReadError(request, error)
    }
    const parsed = parseClaudeContent(data.content, toolNameToOriginal, input.onReasoningDelta)
    if (!parsed.text.trim() && parsed.toolCalls.length === 0) {
      throw new Error('Claude Code OAuth backend returned empty content')
    }
    return {
      content: parsed.text,
      ...(parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
      usage: {
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens: data.usage?.output_tokens ?? 0,
      },
      model: data.model ?? resolveClaudeCodeModel(input.model),
    }
  } finally {
    request.close()
  }
}

export async function* callClaudeCodeOAuthStream(input: {
  tokens: ClaudeCodeOAuthTokens
  messages: GatewayMessage[]
  model: string
  thinkingBudget?: ClaudeThinkingBudget
  onReasoningDelta?: (delta: string) => void
}): AsyncGenerator<string, void, unknown> {
  const body = buildClaudeBody({ ...input, tools: undefined }, true)
  delete body.__toolNameToOriginal

  const request = await startTimedRequest(MESSAGES_URL, {
    method: 'POST',
    headers: {
      ...claudeRequestHeaders(input.tokens.accessToken, Boolean(input.thinkingBudget)),
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  })
  try {
    const response = successfulResponse(request)
    if (!response.body) throw new Error('Claude Code OAuth backend returned no body')
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
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          let evt: { type?: string; delta?: { type?: string; text?: string; thinking?: string } }
          try {
            evt = JSON.parse(payload) as typeof evt
          } catch {
            continue
          }
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
            yield evt.delta.text
          }
          if (
            input.onReasoningDelta &&
            evt.type === 'content_block_delta' &&
            evt.delta?.type === 'thinking_delta' &&
            evt.delta.thinking
          ) {
            input.onReasoningDelta(evt.delta.thinking)
          }
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
