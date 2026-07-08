import { Prisma, type ModelCallStatus } from '@prisma/client'
import type {
  AuditRepository,
  ModelCallRepository,
  PlatformSettingsRepository,
} from '@/repositories/interfaces'
import {
  computeModelCostEur,
  parseModelPricingSetting,
  DEFAULT_MODEL_PRICING,
  MODEL_PRICING_SETTING_KEY,
  type ModelPricingTable,
} from '@/lib/model-pricing'
import { callChatGptOAuth, callChatGptOAuthStream, stubChatStream } from './chatgpt-oauth-bridge'
import { GeminiProvider } from './gemini-provider'
import { createTokenStoreFromEnv, ensureFreshTokens } from './oauth-token-store'
import {
  classifyPrompt,
  DEFAULT_SENSITIVITY_POLICY,
  type SensitivityPolicy,
} from './sensitivity-router'
import type { RoutingEngine } from './routing-engine'
import type { BudgetEngine } from './budget-engine'
import { logger, modelCallsTotal, modelCallLatencyMs } from '@/lib/observability'

export type GatewayGuardrail = {
  /** Ticketenkénti modellhívás-plafon (5.4) — túllépve a Gateway nem hív. */
  maxCallsPerTicket: number
}

/**
 * A per-ticket guardrail alapértéke. A goose harness `--max-turns` (alap 12) a
 * tényleges konvergencia-szabályozó; ez a plafon a FÖLÖTT ül biztonsági hálóként,
 * hogy egy elszabaduló agent-loop ne fogyassza a teljes napi budget capet
 * (100 hívás/agent/nap, ld. DispatcherService). Env-ből felülírható.
 */
export const DEFAULT_MAX_CALLS_PER_TICKET = 30

/** A guardrailt env-ből olvassa (`GATEWAY_MAX_CALLS_PER_TICKET`), különben az alapérték. */
export function guardrailFromEnv(
  env: Record<string, string | undefined> = process.env,
): GatewayGuardrail {
  const raw = env.GATEWAY_MAX_CALLS_PER_TICKET?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  const maxCallsPerTicket =
    Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CALLS_PER_TICKET
  return { maxCallsPerTicket }
}

export class GatewayBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayBudgetError'
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function classifyError(error: unknown): ModelCallStatus {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('429') || message.includes('rate') || message.includes('quota')) {
    return 'rate_limited'
  }
  return 'error'
}

export type ModelConfig = {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
}

export type SensitivityOverride = {
  reviewedByUserId: string
  allowedForbiddenCategories: string[]
  reason: string
}

export type ModelOverrideHint = {
  provider: string
  model: string
}

/** Egy natív tool definíció, amit a providernek átadunk (function calling). */
export type ToolDefinition = {
  name: string
  description: string
  /** JSON Schema objektum a tool bemenetéhez. */
  inputSchema: Record<string, unknown>
}

/** A modell által kért natív eszközhívás (protokoll-szintű, nem szövegbe ágyazott). */
export type GatewayToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * Gateway üzenet — diszkriminált unió, hogy a natív tool use protokoll-szinten
 * elférjen a szöveg mellett:
 * - `assistant`: a modell válasza, opcionális szöveggel ÉS/VAGY tool hívásokkal,
 * - `tool`: egy korábbi tool hívás eredménye (a `toolCallId` köti a híváshoz).
 */
export type GatewayMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string; toolCalls?: GatewayToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string }

/** Egy üzenet szöveges reprezentációja (token-becsléshez / prompt-építéshez). */
export function messageText(m: GatewayMessage): string {
  if (m.role === 'assistant') return m.content ?? ''
  return m.content
}

export type ModelProviderResult = {
  content: string
  /** Natív tool hívások, ha a modell eszközt kért (szöveg helyett/mellett). */
  toolCalls?: GatewayToolCall[]
  usage?: { promptTokens?: number; completionTokens?: number }
  latencyMs: number
  /** A provider által ténylegesen használt modell (pl. a feloldott `gpt-5.5`). */
  model?: string
}

export interface ModelProvider {
  readonly name: string
  chat(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    /** Natív tool use definíciók — ha megadva, a provider function callingot kér. */
    tools?: ToolDefinition[]
  }): Promise<ModelProviderResult>
  chatStream?(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
  }): AsyncGenerator<string, void, unknown>
}

type OpenAiCompatibleContentPart = {
  type?: string
  text?: string
}

type OpenAiToolCall = {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

type OpenAiCompatibleChoice = {
  message?: {
    content?: string | OpenAiCompatibleContentPart[] | null
    reasoning?: string | null
    tool_calls?: OpenAiToolCall[] | null
  }
  text?: string | null
  finish_reason?: string | null
}

type OpenAiCompatibleResponse = {
  choices?: OpenAiCompatibleChoice[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  model?: string
}

function normalizeOpenAiCompatibleContentPart(part: OpenAiCompatibleContentPart): string {
  if (typeof part.text === 'string') return part.text
  return ''
}

export function extractOpenAiCompatibleContent(data: OpenAiCompatibleResponse): string {
  const choice = data.choices?.[0]
  const message = choice?.message
  const content = message?.content

  if (typeof content === 'string' && content.trim()) return content

  if (Array.isArray(content)) {
    const text = content.map(normalizeOpenAiCompatibleContentPart).join('')
    if (text.trim()) return text
  }

  if (typeof message?.reasoning === 'string' && message.reasoning.trim()) {
    return message.reasoning
  }

  if (typeof choice?.text === 'string' && choice.text.trim()) return choice.text

  return ''
}

/** Az OpenAI-kompatibilis `tool_calls` tömböt `GatewayToolCall[]`-ra fordítja. */
export function extractOpenAiToolCalls(data: OpenAiCompatibleResponse): GatewayToolCall[] {
  const rawCalls = data.choices?.[0]?.message?.tool_calls
  if (!Array.isArray(rawCalls)) return []
  const calls: GatewayToolCall[] = []
  for (const [index, call] of rawCalls.entries()) {
    const name = call.function?.name
    if (typeof name !== 'string' || !name) continue
    let input: Record<string, unknown> = {}
    const rawArgs = call.function?.arguments
    if (typeof rawArgs === 'string' && rawArgs.trim()) {
      try {
        const parsed = JSON.parse(rawArgs)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>
        }
      } catch {
        // hibás argument JSON → üres input; a tool oldal validál tovább
      }
    }
    calls.push({ id: call.id || `call_${index}`, name, input })
  }
  return calls
}

type OpenAiRequestMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

/** Egy `GatewayMessage`-t OpenAI chat/completions üzenet-alakra fordít. */
function toOpenAiMessage(m: GatewayMessage): OpenAiRequestMessage {
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
}

function isDirectAgentChat(messages: GatewayMessage[]): boolean {
  return messages.some(
    (m) =>
      m.role === 'system' &&
      m.content.includes('Ez egy közvetlen beszélgetés a felhasználóval'),
  )
}

function stubDirectChatAnswer(messages: GatewayMessage[]): ModelProviderResult {
  const lastUser =
    [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() ?? ''
  const lower = lastUser.toLowerCase()

  let content =
    'Szia! Közvetlen beszélgetésben vagyunk — kérdezz nyugodtan, segítek magyarul.'
  if (lower.includes('feladat') || lower.includes('mit csinál')) {
    content =
      'A rendszerinstrukcióm alapján dolgozom: a szerepköröm és viselkedési profilom határozza meg, miben segíthetek. Mondd, mire van szükséged most.'
  } else if (lower.includes('szia') || lower.includes('hello') || lower === 'hi') {
    content = 'Szia! Örülök, hogy írsz — miben segíthetek?'
  }

  return {
    content,
    usage: { promptTokens: 40, completionTokens: Math.ceil(content.length / 4) },
    latencyMs: 1,
  }
}

function stubWikiAnswer(messages: GatewayMessage[]): ModelProviderResult {
  if (isDirectAgentChat(messages)) {
    return stubDirectChatAnswer(messages)
  }

  const combined = messages.map(messageText).join('\n')
  const lower = combined.toLowerCase()

  const hasKbHits =
    lower.includes('[1] docid=') ||
    lower.includes('"hits"') ||
    (lower.includes('docid=') && lower.includes('sourceref='))

  if (!hasKbHits) {
    return {
      content:
        'Először hívd meg a kb_search MCP eszközt a kérdésre (max 6 találat). Ne válaszolj tényállításokkal a keresés nélkül.',
      usage: { promptTokens: 48, completionTokens: 28 },
      latencyMs: 1,
    }
  }

  const hasBoardPayload = lower.includes('"answer"') && lower.includes('"confidence"')

  if (!hasBoardPayload) {
    return {
      content:
        'Most hívd meg a board_write MCP eszközt: { answer, sources[], rationale, confidence } — a ticket_id paraméterrel.',
      usage: { promptTokens: 56, completionTokens: 32 },
      latencyMs: 1,
    }
  }

  const content = JSON.stringify({
    answer:
      'Az MVP célja egy architektúra-teljes walking skeleton; minden modellhívás a Model Gatewayen, minden eszközhívás a Tool Brokeren keresztül történik.',
    sources: [{ docId: 'memory:stub', sectionRef: 'acceptance:wiki' }],
    rationale: 'Stub harness E2E — kb_search + board_write proof.',
    confidence: 'high',
  })

  const promptLength = messages.map(messageText).join('\n').length
  return {
    content,
    usage: {
      promptTokens: Math.ceil(promptLength / 4),
      completionTokens: Math.ceil(content.length / 4),
    },
    latencyMs: 1,
  }
}

function isStubProviderConfigured(providerUrl: string | undefined): boolean {
  if (!providerUrl) return process.env.CHATGPT_OAUTH_STUB === 'true'
  return providerUrl === 'stub' || providerUrl.startsWith('stub://')
}

export class ChatGptOAuthProvider implements ModelProvider {
  readonly name = 'chatgpt-oauth'

  async chat(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    tools?: ToolDefinition[]
  }): Promise<ModelProviderResult> {
    const providerUrl = process.env.CHATGPT_OAUTH_PROVIDER_URL
    const internalKey = process.env.CHATGPT_OAUTH_PROVIDER_KEY

    if (isStubProviderConfigured(providerUrl)) {
      return stubWikiAnswer(input.messages)
    }

    // Beágyazott (in-process) mediáció: a tokent Secret Managerből / fájlból
    // töltjük, lejáratkor frissítünk + write-back, és közvetlenül a ChatGPT
    // Responses backendet hívjuk. A token nem hagyja el a szerver-runtime-ot.
    const tokenStore = createTokenStoreFromEnv()
    if (tokenStore) {
      const started = Date.now()
      const tokens = await ensureFreshTokens(tokenStore)
      const result = await callChatGptOAuth({
        tokens,
        messages: input.messages,
        model: input.modelConfig.model,
        tools: input.tools,
      })
      return {
        content: result.content,
        toolCalls: result.toolCalls,
        usage: result.usage,
        latencyMs: Date.now() - started,
        model: result.model,
      }
    }

    if (!providerUrl || !internalKey) {
      throw new Error(
        'ChatGPT OAuth provider is not configured (állítsd be CHATGPT_OAUTH_TOKEN_SECRET / CHATGPT_OAUTH_EMBEDDED, vagy CHATGPT_OAUTH_PROVIDER_URL+KEY)',
      )
    }

    const started = Date.now()
    const response = await fetch(providerUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${internalKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    })

    if (!response.ok) {
      throw new Error(`ChatGPT OAuth provider failed: ${response.status}`)
    }

    const data = (await response.json()) as {
      content?: string
      toolCalls?: GatewayToolCall[]
      usage?: { promptTokens?: number; completionTokens?: number }
      model?: string
    }

    return {
      content: data.content ?? '',
      toolCalls: data.toolCalls,
      usage: data.usage,
      latencyMs: Date.now() - started,
      model: data.model,
    }
  }

  async *chatStream(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
  }): AsyncGenerator<string, void, unknown> {
    const providerUrl = process.env.CHATGPT_OAUTH_PROVIDER_URL

    if (isStubProviderConfigured(providerUrl)) {
      const result = stubWikiAnswer(input.messages)
      yield* stubChatStream(result.content)
      return
    }

    const tokenStore = createTokenStoreFromEnv()
    if (tokenStore) {
      const tokens = await ensureFreshTokens(tokenStore)
      yield* callChatGptOAuthStream({
        tokens,
        messages: input.messages,
        model: input.modelConfig.model,
      })
      return
    }

    // External sidecar doesn't expose a streaming endpoint — fall back to
    // single-chunk via chat() so at least the SSE infrastructure still works.
    const result = await this.chat({ ...input, tools: undefined })
    yield result.content
  }
}

/**
 * OpenAI-kompatibilis provider helyi/önálló modellekhez (pl. Ollama-n futó
 * Gemma, vagy llama.cpp `llama-server`). A `modelConfig.provider` ezt választja
 * (pl. `ollama`); a `modelConfig.model` a backend modell-azonosítója
 * (pl. `gemma-local`). A base URL env-ből jön (default Ollama: localhost:11434).
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  constructor(
    readonly name: string,
    private baseUrlEnvVar: string,
    private defaultBaseUrl?: string,
    private apiKeyEnvVar?: string,
    private options: {
      apiKeyRequired?: boolean
      extraHeaders?: () => Record<string, string>
      extraBody?: () => Record<string, unknown>
    } = {},
  ) {}

  async chat(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    tools?: ToolDefinition[]
  }): Promise<ModelProviderResult> {
    const baseUrl = (process.env[this.baseUrlEnvVar] || this.defaultBaseUrl)?.replace(/\/+$/, '')
    if (!baseUrl) {
      throw new Error(`${this.name} provider base URL not configured (${this.baseUrlEnvVar})`)
    }
    const apiKey = this.apiKeyEnvVar ? process.env[this.apiKeyEnvVar] : undefined
    if (this.options.apiKeyRequired && !apiKey?.trim()) {
      throw new Error(`${this.name} provider API key not configured (${this.apiKeyEnvVar})`)
    }

    const started = Date.now()
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...this.options.extraHeaders?.(),
      },
      body: JSON.stringify({
        model: input.modelConfig.model,
        messages: input.messages.map(toOpenAiMessage),
        temperature: input.modelConfig.temperature,
        max_tokens: input.modelConfig.maxTokens,
        stream: false,
        ...(input.tools?.length
          ? {
              tools: input.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
              tool_choice: 'auto',
            }
          : {}),
        ...this.options.extraBody?.(),
      }),
    })

    if (!response.ok) {
      throw new Error(`${this.name} provider failed: ${response.status} ${(await response.text()).slice(0, 200)}`)
    }

    const data = (await response.json()) as OpenAiCompatibleResponse
    const content = extractOpenAiCompatibleContent(data)
    const toolCalls = extractOpenAiToolCalls(data)

    // Tool-only válasznál a content üres — csak akkor hiba, ha sem szöveg, sem
    // tool hívás nem jött vissza.
    if (!content.trim() && toolCalls.length === 0) {
      const finishReason = data.choices?.[0]?.finish_reason
      throw new Error(
        `${this.name} provider returned empty content${finishReason ? ` (finish_reason=${finishReason})` : ''}`,
      )
    }

    return {
      content,
      ...(toolCalls.length ? { toolCalls } : {}),
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
      },
      latencyMs: Date.now() - started,
      model: data.model,
    }
  }

  async *chatStream(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
  }): AsyncGenerator<string, void, unknown> {
    const baseUrl = (process.env[this.baseUrlEnvVar] || this.defaultBaseUrl)?.replace(/\/+$/, '')
    if (!baseUrl) {
      throw new Error(`${this.name} provider base URL not configured (${this.baseUrlEnvVar})`)
    }
    const apiKey = this.apiKeyEnvVar ? process.env[this.apiKeyEnvVar] : undefined
    if (this.options.apiKeyRequired && !apiKey?.trim()) {
      throw new Error(`${this.name} provider API key not configured (${this.apiKeyEnvVar})`)
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...this.options.extraHeaders?.(),
      },
      body: JSON.stringify({
        model: input.modelConfig.model,
        messages: input.messages.map(toOpenAiMessage),
        temperature: input.modelConfig.temperature,
        max_tokens: input.modelConfig.maxTokens,
        stream: true,
        ...this.options.extraBody?.(),
      }),
    })

    if (!response.ok) {
      throw new Error(`${this.name} provider failed: ${response.status} ${(await response.text()).slice(0, 200)}`)
    }

    if (!response.body) {
      throw new Error(`${this.name} provider returned no body`)
    }

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
          const data = trimmed.slice(6)
          if (data === '[DONE]') return
          try {
            const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
            const chunk = parsed.choices?.[0]?.delta?.content
            if (typeof chunk === 'string' && chunk) yield chunk
          } catch {
            // ignore malformed SSE JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}

/** A Gateway által ismert providerek (modelConfig.provider → implementáció). */
export function createDefaultProviders(): Map<string, ModelProvider> {
  const providers: ModelProvider[] = [
    new ChatGptOAuthProvider(),
    new GeminiProvider(),
    // Helyi Gemma Ollama-n keresztül (OpenAI-kompatibilis /v1).
    new OpenAiCompatibleProvider('ollama', 'OLLAMA_BASE_URL', 'http://localhost:11434/v1', 'OLLAMA_API_KEY'),
    new OpenAiCompatibleProvider(
      'openrouter',
      'OPENROUTER_BASE_URL',
      'https://openrouter.ai/api/v1',
      'OPENROUTER_API_KEY',
      {
        apiKeyRequired: true,
        extraHeaders: () => ({
          ...(process.env.OPENROUTER_HTTP_REFERER
            ? { 'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER }
            : {}),
          ...(process.env.OPENROUTER_APP_TITLE
            ? { 'X-OpenRouter-Title': process.env.OPENROUTER_APP_TITLE }
            : {}),
        }),
        extraBody: () => ({ reasoning: { exclude: true } }),
      },
    ),
  ]
  return new Map(providers.map((p) => [p.name, p]))
}

/** Maximum retry attempts for transient errors (5xx / network). */
const MAX_RETRIES = 2

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (error: unknown) {
      lastError = error
      const status = classifyError(error)
      // Only retry on transient errors, not rate-limit or budget denials.
      if (status !== 'error') throw error
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
      }
    }
  }
  throw lastError
}

export class ModelGateway {
  constructor(
    private audit: AuditRepository,
    private modelCalls: ModelCallRepository,
    private providers: Map<string, ModelProvider> = createDefaultProviders(),
    private guardrail: GatewayGuardrail = guardrailFromEnv(),
    private routingEngine?: RoutingEngine,
    private budgetEngine?: BudgetEngine,
    private sensitivityPolicy: SensitivityPolicy = DEFAULT_SENSITIVITY_POLICY,
    // D11 / §16.1 — a `model.pricing` tarifa-forrás a valódi costEstimate-hez.
    // Ha nincs megadva, a beépített DEFAULT_MODEL_PRICING él (a költség NEM marad 0).
    private pricingSettings?: Pick<PlatformSettingsRepository, 'get'>,
  ) {}

  /** Cache-elt tarifa-betöltés (setting → default fallback). */
  private cachedPricing: ModelPricingTable | null = null
  private async loadPricing(): Promise<ModelPricingTable> {
    if (this.cachedPricing) return this.cachedPricing
    if (!this.pricingSettings) {
      this.cachedPricing = DEFAULT_MODEL_PRICING
      return this.cachedPricing
    }
    try {
      const raw = await this.pricingSettings.get(MODEL_PRICING_SETTING_KEY)
      this.cachedPricing = parseModelPricingSetting(raw)
    } catch {
      this.cachedPricing = DEFAULT_MODEL_PRICING
    }
    return this.cachedPricing
  }

  async call(params: {
    agentId: string
    agentVersion?: number
    tenantId?: string
    ticketId?: string
    conversationId?: string
    ticketType?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    /** Low-trust request-level model choice. Routing policy must explicitly allow it. */
    modelOverrideHint?: ModelOverrideHint
    /** Natív tool use definíciók — átadva a provider function callingot kér. */
    tools?: ToolDefinition[]
    /** Explicit human review for narrowly scoped, audited sensitivity overrides. */
    sensitivityOverride?: SensitivityOverride
  }): Promise<{
    content: string
    toolCalls?: GatewayToolCall[]
    usage: { promptTokens: number; completionTokens: number }
    provider: string
    model: string
  }> {
    const agentVersion = params.agentVersion ?? null

    // ── Step 2: Sensitivity pre-flight (Fázis 2-B) ─────────────────────────
    const sensitivity = classifyPrompt(params.messages)
    const sensitivityOverrideAllowed =
      sensitivity.level === 'forbidden' &&
      !!sensitivity.matchedCategory &&
      params.sensitivityOverride?.allowedForbiddenCategories.includes(sensitivity.matchedCategory)
    if (sensitivity.level === 'forbidden' && !sensitivityOverrideAllowed) {
      const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
      const targetId = params.ticketId ?? params.conversationId ?? params.agentId
      await this.audit.append({
        actorType: 'agent',
        actorId: params.agentId,
        agentVersion,
        action: 'model.call.denied',
        targetType,
        targetId,
        modelUsed: params.modelConfig.model,
        inputRef: `sensitivity:${sensitivity.matchedCategory}`,
        outputRef: 'blocked',
        policyDecision: 'sensitivity_block',
        metadata: { reason: 'sensitivity_block', category: sensitivity.matchedCategory },
      })
      throw new GatewayBudgetError(
        `Gateway sensitivity block: forbidden content detected (${sensitivity.matchedCategory})`,
      )
    }
    if (sensitivityOverrideAllowed) {
      const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
      const targetId = params.ticketId ?? params.conversationId ?? params.agentId
      await this.audit.append({
        actorType: 'human',
        actorId: params.sensitivityOverride!.reviewedByUserId,
        agentVersion,
        action: 'model.call.sensitivity_override',
        targetType,
        targetId,
        modelUsed: params.modelConfig.model,
        inputRef: `sensitivity:${sensitivity.matchedCategory}`,
        outputRef: 'allowed_by_human_review',
        policyDecision: 'human_review_override',
        metadata: {
          reason: params.sensitivityOverride!.reason,
          category: sensitivity.matchedCategory,
        },
      })
    }

    // ── Step 3: Routing (Fázis 2-A) ────────────────────────────────────────
    let resolvedConfig = { ...params.modelConfig }
    if (this.routingEngine) {
      const decision = await this.routingEngine.resolve({
        agentId: params.agentId,
        tenantId: params.tenantId,
        ticketType: params.ticketType,
        overrideHint: params.modelOverrideHint,
        agentModelConfig: params.modelConfig,
      })
      resolvedConfig = { ...resolvedConfig, provider: decision.provider, model: decision.model }
    }

    // Sensitivity override: force local model for sensitive prompts
    if (sensitivity.level === 'sensitive' && this.sensitivityPolicy.enforceLocalForSensitive) {
      resolvedConfig = {
        ...resolvedConfig,
        provider: this.sensitivityPolicy.localProvider,
        model: this.sensitivityPolicy.localModel,
      }
    }

    const provider = this.providers.get(resolvedConfig.provider)
    if (!provider) {
      throw new Error(
        `Unsupported model provider: ${resolvedConfig.provider} (ismert: ${[...this.providers.keys()].join(', ')})`,
      )
    }

    const model = resolvedConfig.model || 'chatgpt-oauth-default'
    const prompt = params.messages
      .map((m) => `${m.role.toUpperCase()}: ${messageText(m)}`)
      .join('\n\n')

    // ── Step 4a: Ticket-level guardrail (MVP) ───────────────────────────────
    if (params.ticketId && isUuid(params.ticketId)) {
      const usage = await this.modelCalls.getUsageForTicket(params.ticketId)
      if (usage.calls >= this.guardrail.maxCallsPerTicket) {
        await this.audit.append({
          actorType: 'agent',
          actorId: params.agentId,
          agentVersion,
          action: 'model.call.denied',
          targetType: 'ticket',
          targetId: params.ticketId,
          modelUsed: model,
          inputRef: `calls:${usage.calls}`,
          outputRef: `cap:${this.guardrail.maxCallsPerTicket}`,
          policyDecision: 'budget_blocked',
          metadata: usage,
        })
        modelCallsTotal.inc({ provider: 'guardrail', status: 'budget_blocked' })
        throw new GatewayBudgetError(
          `Gateway guardrail: ticket ${params.ticketId} reached ${this.guardrail.maxCallsPerTicket} model calls`,
        )
      }
    }

    // ── Step 4b: Budget engine gate (Fázis 2-A) ─────────────────────────────
    if (this.budgetEngine) {
      const budgetCheck = await this.budgetEngine.check({
        tenantId: params.tenantId,
        agentId: params.agentId,
        ticketType: params.ticketType,
      })
      if (!budgetCheck.allowed) {
        const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
        const targetId = params.ticketId ?? params.conversationId ?? params.agentId
        await this.audit.append({
          actorType: 'agent',
          actorId: params.agentId,
          agentVersion,
          action: 'model.call.denied',
          targetType,
          targetId,
          modelUsed: model,
          inputRef: 'budget_check',
          outputRef: 'denied',
          policyDecision: 'budget_blocked',
          metadata: { reason: budgetCheck.reason },
        })
        modelCallsTotal.inc({ provider: 'budget', status: 'budget_blocked' })
        throw new GatewayBudgetError(`Gateway budget gate: ${budgetCheck.reason}`)
      }
    }

    // ── Steps 5-9: Secret injection, provider call, output guard, logging ────
    const started = Date.now()
    try {
      const result = await withRetry(() =>
        provider.chat({
          agentId: params.agentId,
          ticketId: params.ticketId,
          messages: params.messages,
          modelConfig: { ...resolvedConfig, model },
          tools: params.tools,
        }),
      )

      const content = result.content
      const promptTokens = result.usage?.promptTokens ?? Math.ceil(prompt.length / 4)
      const completionTokens = result.usage?.completionTokens ?? Math.ceil(content.length / 4)
      const usedModel = result.model || model
      // §16.1 — valódi becslés a token-számokból (korábban fixen 0).
      const costEstimate = computeModelCostEur(
        usedModel,
        promptTokens,
        completionTokens,
        await this.loadPricing(),
      )

      await this.modelCalls.create({
        agentId: params.agentId,
        agentVersion,
        ticketId: params.ticketId ?? null,
        conversationId: params.conversationId ?? null,
        provider: provider.name,
        model: usedModel,
        promptTokens,
        completionTokens,
        costEstimate: new Prisma.Decimal(costEstimate),
        latencyMs: result.latencyMs,
        status: 'ok',
      })

      // WP-6 (O2): gateway telemetria — hívásszám + latency + költség (metaadat).
      modelCallsTotal.inc({ provider: provider.name, status: 'ok' })
      modelCallLatencyMs.observe(result.latencyMs, { provider: provider.name })
      logger.info(
        {
          event: 'model.call',
          provider: provider.name,
          model: usedModel,
          status: 'ok',
          latencyMs: result.latencyMs,
          costEstimate,
          promptTokens,
          completionTokens,
          agentId: params.agentId,
          ticketId: params.ticketId ?? null,
        },
        'model gateway call',
      )

      const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
      const targetId = params.ticketId ?? params.conversationId ?? params.agentId

      await this.audit.append({
        actorType: 'agent',
        actorId: params.agentId,
        agentVersion,
        action: 'model.call',
        targetType,
        targetId,
        modelUsed: usedModel,
        inputRef: `tokens:${promptTokens}`,
        outputRef: `tokens:${completionTokens}`,
        policyDecision: 'allowed',
        metadata: {
          costEstimate,
          latencyMs: result.latencyMs,
          status: 'ok',
          sensitivity: sensitivity.level,
        },
      })

      return {
        content,
        ...(result.toolCalls?.length ? { toolCalls: result.toolCalls } : {}),
        usage: { promptTokens, completionTokens },
        provider: provider.name,
        model: usedModel,
      }
    } catch (error: unknown) {
      if (error instanceof GatewayBudgetError) throw error
      const status = classifyError(error)
      const latencyMs = Date.now() - started
      const message = error instanceof Error ? error.message : String(error)

      await this.modelCalls.create({
        agentId: params.agentId,
        agentVersion,
        ticketId: params.ticketId ?? null,
        conversationId: params.conversationId ?? null,
        provider: provider.name,
        model,
        promptTokens: 0,
        completionTokens: 0,
        costEstimate: new Prisma.Decimal(0),
        latencyMs,
        status,
      })

      // WP-6 (O2): hibás modellhívás telemetriája (rate_limited / error).
      modelCallsTotal.inc({ provider: provider.name, status })
      modelCallLatencyMs.observe(latencyMs, { provider: provider.name })
      logger.warn(
        {
          event: 'model.call',
          provider: provider.name,
          model,
          status,
          latencyMs,
          agentId: params.agentId,
          ticketId: params.ticketId ?? null,
          error: message,
        },
        'model gateway call failed',
      )

      const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
      const targetId = params.ticketId ?? params.conversationId ?? params.agentId

      await this.audit.append({
        actorType: 'agent',
        actorId: params.agentId,
        agentVersion,
        action: 'model.call',
        targetType,
        targetId,
        modelUsed: model,
        inputRef: 'error',
        outputRef: status,
        policyDecision: status,
        metadata: { latencyMs, status, error: message },
      })

      throw error
    }
  }

  async *callStream(params: {
    agentId: string
    agentVersion?: number
    tenantId?: string
    ticketId?: string
    conversationId?: string
    ticketType?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    modelOverrideHint?: ModelOverrideHint
    sensitivityOverride?: SensitivityOverride
  }): AsyncGenerator<string, void, unknown> {
    const agentVersion = params.agentVersion ?? null

    // Sensitivity pre-flight (Fázis 2-B)
    const sensitivity = classifyPrompt(params.messages)
    const sensitivityOverrideAllowed =
      sensitivity.level === 'forbidden' &&
      !!sensitivity.matchedCategory &&
      params.sensitivityOverride?.allowedForbiddenCategories.includes(sensitivity.matchedCategory)
    if (sensitivity.level === 'forbidden' && !sensitivityOverrideAllowed) {
      const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
      const targetId = params.ticketId ?? params.conversationId ?? params.agentId
      await this.audit.append({
        actorType: 'agent',
        actorId: params.agentId,
        agentVersion,
        action: 'model.call.denied',
        targetType,
        targetId,
        modelUsed: params.modelConfig.model,
        inputRef: `sensitivity:${sensitivity.matchedCategory}`,
        outputRef: 'blocked',
        policyDecision: 'sensitivity_block',
        metadata: { reason: 'sensitivity_block', category: sensitivity.matchedCategory },
      })
      throw new GatewayBudgetError(
        `Gateway sensitivity block: forbidden content detected (${sensitivity.matchedCategory})`,
      )
    }
    if (sensitivityOverrideAllowed) {
      const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
      const targetId = params.ticketId ?? params.conversationId ?? params.agentId
      await this.audit.append({
        actorType: 'human',
        actorId: params.sensitivityOverride!.reviewedByUserId,
        agentVersion,
        action: 'model.call.sensitivity_override',
        targetType,
        targetId,
        modelUsed: params.modelConfig.model,
        inputRef: `sensitivity:${sensitivity.matchedCategory}`,
        outputRef: 'allowed_by_human_review',
        policyDecision: 'human_review_override',
        metadata: {
          reason: params.sensitivityOverride!.reason,
          category: sensitivity.matchedCategory,
        },
      })
    }

    // Routing engine (Fázis 2-A)
    let resolvedConfig = { ...params.modelConfig }
    if (this.routingEngine) {
      const decision = await this.routingEngine.resolve({
        agentId: params.agentId,
        tenantId: params.tenantId,
        ticketType: params.ticketType,
        overrideHint: params.modelOverrideHint,
        agentModelConfig: params.modelConfig,
      })
      resolvedConfig = { ...resolvedConfig, provider: decision.provider, model: decision.model }
    }

    if (sensitivity.level === 'sensitive' && this.sensitivityPolicy.enforceLocalForSensitive) {
      resolvedConfig = {
        ...resolvedConfig,
        provider: this.sensitivityPolicy.localProvider,
        model: this.sensitivityPolicy.localModel,
      }
    }

    const provider = this.providers.get(resolvedConfig.provider)
    if (!provider) {
      throw new Error(
        `Unsupported model provider: ${resolvedConfig.provider} (ismert: ${[...this.providers.keys()].join(', ')})`,
      )
    }

    const model = resolvedConfig.model || 'chatgpt-oauth-default'
    const prompt = params.messages
      .map((m) => `${m.role.toUpperCase()}: ${messageText(m)}`)
      .join('\n\n')

    if (params.ticketId && isUuid(params.ticketId)) {
      const usage = await this.modelCalls.getUsageForTicket(params.ticketId)
      if (usage.calls >= this.guardrail.maxCallsPerTicket) {
        await this.audit.append({
          actorType: 'agent',
          actorId: params.agentId,
          agentVersion,
          action: 'model.call.denied',
          targetType: 'ticket',
          targetId: params.ticketId,
          modelUsed: model,
          inputRef: `calls:${usage.calls}`,
          outputRef: `cap:${this.guardrail.maxCallsPerTicket}`,
          policyDecision: 'budget_blocked',
          metadata: usage,
        })
        throw new GatewayBudgetError(
          `Gateway guardrail: ticket ${params.ticketId} reached ${this.guardrail.maxCallsPerTicket} model calls`,
        )
      }
    }

    if (this.budgetEngine) {
      const budgetCheck = await this.budgetEngine.check({
        tenantId: params.tenantId,
        agentId: params.agentId,
        ticketType: params.ticketType,
      })
      if (!budgetCheck.allowed) {
        const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
        const targetId = params.ticketId ?? params.conversationId ?? params.agentId
        await this.audit.append({
          actorType: 'agent',
          actorId: params.agentId,
          agentVersion,
          action: 'model.call.denied',
          targetType,
          targetId,
          modelUsed: model,
          inputRef: 'budget_check',
          outputRef: 'denied',
          policyDecision: 'budget_blocked',
          metadata: { reason: budgetCheck.reason },
        })
        throw new GatewayBudgetError(`Gateway budget gate: ${budgetCheck.reason}`)
      }
    }

    const started = Date.now()
    let content = ''

    if (!provider.chatStream) {
      // Fallback: call non-streaming and yield the full content as one chunk.
      try {
        const result = await withRetry(() =>
          provider.chat({
            agentId: params.agentId,
            ticketId: params.ticketId,
            messages: params.messages,
            modelConfig: { ...resolvedConfig, model },
          }),
        )
        content = result.content
        const promptTokens = result.usage?.promptTokens ?? Math.ceil(prompt.length / 4)
        const completionTokens = result.usage?.completionTokens ?? Math.ceil(content.length / 4)
        const usedModel = result.model || model
        const costEstimate = computeModelCostEur(
          usedModel,
          promptTokens,
          completionTokens,
          await this.loadPricing(),
        )
        const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
        const targetId = params.ticketId ?? params.conversationId ?? params.agentId
        await this.modelCalls.create({
          agentId: params.agentId,
          agentVersion,
          ticketId: params.ticketId ?? null,
          conversationId: params.conversationId ?? null,
          provider: provider.name,
          model: usedModel,
          promptTokens,
          completionTokens,
          costEstimate: new Prisma.Decimal(costEstimate),
          latencyMs: result.latencyMs,
          status: 'ok',
        })
        await this.audit.append({
          actorType: 'agent',
          actorId: params.agentId,
          agentVersion,
          action: 'model.call',
          targetType,
          targetId,
          modelUsed: usedModel,
          inputRef: `tokens:${promptTokens}`,
          outputRef: `tokens:${completionTokens}`,
          policyDecision: 'allowed',
          metadata: { costEstimate, latencyMs: result.latencyMs, status: 'ok', sensitivity: sensitivity.level },
        })
        yield content
      } catch (error: unknown) {
        if (error instanceof GatewayBudgetError) throw error
        const status = classifyError(error)
        const latencyMs = Date.now() - started
        const errorMessage = error instanceof Error ? error.message : String(error)
        const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
        const targetId = params.ticketId ?? params.conversationId ?? params.agentId
        await this.modelCalls.create({
          agentId: params.agentId,
          agentVersion,
          ticketId: params.ticketId ?? null,
          conversationId: params.conversationId ?? null,
          provider: provider.name,
          model,
          promptTokens: 0,
          completionTokens: 0,
          costEstimate: new Prisma.Decimal(0),
          latencyMs,
          status,
        })
        await this.audit.append({
          actorType: 'agent',
          actorId: params.agentId,
          agentVersion,
          action: 'model.call',
          targetType,
          targetId,
          modelUsed: model,
          inputRef: 'error',
          outputRef: status,
          policyDecision: status,
          metadata: { latencyMs, status, error: errorMessage },
        })
        throw error
      }
      return
    }

    try {
      for await (const chunk of provider.chatStream({
        agentId: params.agentId,
        ticketId: params.ticketId,
        messages: params.messages,
        modelConfig: { ...resolvedConfig, model },
      })) {
        content += chunk
        yield chunk
      }

      const promptTokens = Math.ceil(prompt.length / 4)
      const completionTokens = Math.ceil(content.length / 4)
      const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
      const targetId = params.ticketId ?? params.conversationId ?? params.agentId

      await this.modelCalls.create({
        agentId: params.agentId,
        agentVersion,
        ticketId: params.ticketId ?? null,
        conversationId: params.conversationId ?? null,
        provider: provider.name,
        model,
        promptTokens,
        completionTokens,
        costEstimate: new Prisma.Decimal(0),
        latencyMs: Date.now() - started,
        status: 'ok',
      })

      await this.audit.append({
        actorType: 'agent',
        actorId: params.agentId,
        agentVersion,
        action: 'model.call',
        targetType,
        targetId,
        modelUsed: model,
        inputRef: `tokens:${promptTokens}`,
        outputRef: `tokens:${completionTokens}`,
        policyDecision: 'allowed',
        metadata: { costEstimate: 0, latencyMs: Date.now() - started, status: 'ok', sensitivity: sensitivity.level },
      })
    } catch (error: unknown) {
      if (error instanceof GatewayBudgetError) throw error
      const status = classifyError(error)
      const latencyMs = Date.now() - started
      const errorMessage = error instanceof Error ? error.message : String(error)
      const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
      const targetId = params.ticketId ?? params.conversationId ?? params.agentId

      await this.modelCalls.create({
        agentId: params.agentId,
        agentVersion,
        ticketId: params.ticketId ?? null,
        conversationId: params.conversationId ?? null,
        provider: provider.name,
        model,
        promptTokens: 0,
        completionTokens: 0,
        costEstimate: new Prisma.Decimal(0),
        latencyMs,
        status,
      })

      await this.audit.append({
        actorType: 'agent',
        actorId: params.agentId,
        agentVersion,
        action: 'model.call',
        targetType,
        targetId,
        modelUsed: model,
        inputRef: 'error',
        outputRef: status,
        policyDecision: status,
        metadata: { latencyMs, status, error: errorMessage },
      })

      throw error
    }
  }
}
