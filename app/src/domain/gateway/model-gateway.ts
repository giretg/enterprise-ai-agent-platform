import { Prisma, type ModelCallStatus } from '@prisma/client'
import { allowsExternalRaw, type PrivacyCategoryAction } from '@/domain/privacy/privacy-category-policy'
import { recordPrivacyGatewayAudit } from '@/domain/privacy/privacy-audit'
import type { PrivacyGatewayMode, PrivacyModeResolver } from '@/domain/privacy/privacy-mode'
import {
  sensitivityLayerAuditsObservation,
  sensitivityLayerSkipsEnforcement,
  type SensitivityLayerMode,
  type SensitivityModeResolver,
} from '@/domain/gateway/sensitivity-mode'
import { summarizePrivacySpans } from '@/domain/privacy/privacy-mode'
import { transformPromptMessages } from '@/domain/privacy/prompt-privacy-transform'
import type { UserInputEntityResolution } from '@/domain/privacy/user-input-resolver'
import { privacyScopeForCall } from '@/domain/privacy/privacy-scope'
import {
  PrivacyTransformBlockedError,
  describePrivacyTransformFailure,
} from '@/domain/privacy/privacy-transform-failure'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import type {
  AuditRepository,
  ModelCallRepository,
  PlatformSettingsRepository,
} from '@/repositories/interfaces'
import {
  computeModelCostEur,
  resolvePricingFromSettings,
  DEFAULT_MODEL_PRICING,
  MODEL_PRICING_SETTING_KEY,
  MODEL_PRICING_SYNCED_SETTING_KEY,
  type ModelPricingTable,
} from '@/lib/model-pricing'
import {
  DEFAULT_MAX_CALLS_PER_TICKET,
  GATEWAY_TICKET_CALL_CAP_KEY,
  parseGatewayTicketCallCapStored,
  resolveMaxCallsPerTicket,
} from '@/lib/gateway-ticket-call-cap'
import {
  callChatGptOAuth,
  callChatGptOAuthStream,
  chatGptOAuthDiagnostic,
  resolveReasoningEffort,
  stubChatStream,
  type ChatGptOAuthConcurrencyDiagnostic,
} from './chatgpt-oauth-bridge'
import {
  callClaudeCodeOAuth,
  callClaudeCodeOAuthStream,
  createClaudeCodeTokenStoreFromEnv,
  ensureFreshClaudeCodeTokens,
  resolveClaudeThinkingBudget,
} from './claude-code-oauth-bridge'
import { GeminiProvider } from './gemini-provider'
import {
  callGrokCliOAuth,
  callGrokCliOAuthStream,
  createGrokCliTokenStoreFromEnv,
  ensureFreshGrokCliTokens,
  resolveGrokReasoningEffort,
} from './grok-cli-oauth-bridge'
import { createTokenStoreFromEnv, ensureFreshTokens } from './oauth-token-store'
import {
  classifyPrompt,
  formatSensitivityBlockMessage,
  sensitivityPolicyFromEnv,
  type SensitivityDecision,
  type SensitivityPolicy,
} from './sensitivity-router'
import {
  buildEffectiveFallbackChain,
  classifyProviderError,
  extractAgentFallbackModels,
  fallbackMaxAttemptsFromEnv,
  FALLBACK_CHAIN_SETTING_KEY,
  isFallbackEligible,
  isModelCallAborted,
  isTransientRetryable,
  ModelCallAbortedError,
  parseFallbackChainSetting,
  ProviderSkipLedger,
  type FallbackCandidate,
  type FallbackErrorClass,
} from './fallback-chain'
export { ModelCallAbortedError, isModelCallAborted } from './fallback-chain'
import {
  cacheControlPayload,
  extractPromptCacheUsage,
  promptCachePolicyFromEnv,
  resolveCacheBreakpoints,
  type CacheControlPayload,
} from './prompt-cache'
import type { RoutingEngine } from './routing-engine'
import type { BudgetEngine } from './budget-engine'
import {
  logger,
  modelCallsTotal,
  modelCallLatencyMs,
  modelFallbackTotal,
  modelPromptCacheTokensTotal,
  privacyTransformDurationMs,
} from '@/lib/observability'

/** OpenRouter / Ollama stb. provider fetch timeout (ms). Default: 120s. */
const DEFAULT_MODEL_PROVIDER_FETCH_TIMEOUT_MS = 120_000

function modelProviderFetchTimeoutMs(): number {
  const raw = process.env.MODEL_PROVIDER_FETCH_TIMEOUT_MS
  const parsed = raw ? Number(raw) : DEFAULT_MODEL_PROVIDER_FETCH_TIMEOUT_MS
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MODEL_PROVIDER_FETCH_TIMEOUT_MS
}

async function fetchWithProviderTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const timeoutMs = modelProviderFetchTimeoutMs()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const callerSignal = init.signal
  const signal =
    callerSignal && !callerSignal.aborted
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal
  try {
    return await fetch(url, { ...init, signal })
  } catch (error: unknown) {
    if (callerSignal?.aborted) throw new ModelCallAbortedError()
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new Error(`Model provider request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export type GatewayGuardrail = {
  /** Ticketenkénti modellhívás-plafon (5.4) — túllépve a Gateway nem hív. */
  maxCallsPerTicket: number
}

/**
 * A per-ticket guardrail alapértéke. A runtime saját loop-szabályozása FÖLÖTT
 * ül biztonsági hálóként,
 * hogy egy elszabaduló agent-loop ne fogyassza a teljes napi budget capet
 * (100 hívás/agent/nap, ld. DispatcherService). Env-ből felülírható.
 */
export { DEFAULT_MAX_CALLS_PER_TICKET }

/** Platform_settings → env → alapértelmezés; tesztekben a konstruktor guardrail-je is él. */
export function guardrailFromEnv(
  env: Record<string, string | undefined> = process.env,
): GatewayGuardrail {
  return { maxCallsPerTicket: resolveMaxCallsPerTicket({ env }) }
}

export class GatewayBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayBudgetError'
  }
}

/**
 * A `sensitive` prompt nem küldhető külső providerhez, és a helyi modell sem
 * elérhető. A hívó (chat SSE / task runtime) ezt felhasználónak mutatható
 * üzenetként kapja meg — nem nyers `fetch failed`-ként.
 */
export class GatewaySensitivityError extends Error {
  constructor(
    message: string,
    readonly category: string | undefined,
    readonly reason: 'local_model_unavailable' | 'local_call_failed',
  ) {
    super(message)
    this.name = 'GatewaySensitivityError'
  }
}

/**
 * Per-agent felülbírálás olvasása (§ sensitivity router, APG-11 kategória-policy).
 * Azért interface és nem hívási paraméter, mert a gateway-nek nyolc hívási helye van,
 * és mindegyik átadja már az `agentId`-t — így a bővítés egy seamre korlátozódik.
 */
export interface AgentSensitivityPolicyReader {
  /**
   * @deprecated APG-11: a kategória-policy `allow` akciója a döntés.
   * Teszt-seam és visszaesés, ha `actionForCategory` nincs.
   */
  allowsSensitiveExternalModel(agentId: string): Promise<boolean>
  /** Kategóriánkénti akció. Ha megvan, a boolean felmentést felülírja. */
  actionForCategory?(agentId: string, category: string): Promise<PrivacyCategoryAction>
}

/**
 * Az agent szervezetének feloldása a gateway határán — ugyanaz a seam-minta, mint
 * az `AgentSensitivityPolicyReader`-nél.
 *
 * ÜZLETI PROBLÉMA: a keret- és routing-kapu a hívótól várta a `tenantId`-t, de a
 * futásidejű hívási helyek egyike sem adta át (a tool-loop kontextusa csak
 * ticket/conversation azonosítót visz). A kapu így tenant-vakon értékelt: egy másik
 * szervezet napi keretének elfogyása megállította ezt az agentet is, holott a saját
 * kerete még bőven élt. A felhasználó ebből annyit látott, hogy a feladat
 * „Végrehajtásra vár"-ban marad, magyarázat nélkül.
 *
 * A tenantot ezért a gateway maga oldja fel az `agentId`-ból: nincs hívási hely,
 * ahol el lehetne felejteni.
 */
export interface AgentTenantResolver {
  /** Az agent szervezete; `null`, ha az agent nem található vagy platform-szintű. */
  tenantIdForAgent(agentId: string): Promise<string | null>
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function persistedStatusFromErrorClass(errorClass: FallbackErrorClass): ModelCallStatus {
  return errorClass === 'rate_limited' ? 'rate_limited' : 'error'
}

export type ModelConfig = {
  provider: string
  model: string
  /**
   * Ortogonális gondolkodási profil (luna / terra / sol).
   * ChatGPT OAuth: `reasoningEffort`; Claude Code: thinking budget;
   * Grok CLI: `reasoning.effort`. Más providernél jelenleg no-op, de a
   * konfigban megőrződik.
   */
  modelType?: 'luna' | 'terra' | 'sol'
  temperature?: number
  maxTokens?: number
  /**
   * Agent-szintű tartalék-lista (admin konfiguráció, verziózott).
   * Futásidőben sem a request, sem az agent nem írhatja felül másképp —
   * csak ez a befagyasztott modelConfig mező.
   */
  fallbackModels?: FallbackCandidate[]
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
 * Prompt-cache határ jelölése. A prompt-assembler teszi rá a stabil zóna utolsó
 * üzenetére: „eddig (bezárólag) hívások közt bájt-azonos a prefix". A jelölés
 * providerfüggetlen — a Gateway fordítja le annak, aki explicit cache-API-t vár
 * (`cache_control`); a többinél no-op, mert ott az automatikus prefix-cache él.
 */
export type CacheBoundaryMarker = {
  cacheBoundary?: boolean
}

/**
 * Gateway üzenet — diszkriminált unió, hogy a natív tool use protokoll-szinten
 * elférjen a szöveg mellett:
 * - `assistant`: a modell válasza, opcionális szöveggel ÉS/VAGY tool hívásokkal,
 * - `tool`: egy korábbi tool hívás eredménye (a `toolCallId` köti a híváshoz).
 */
export type GatewayMessage =
  | ({ role: 'system'; content: string } & CacheBoundaryMarker)
  | ({ role: 'user'; content: string } & CacheBoundaryMarker)
  | ({ role: 'assistant'; content?: string; toolCalls?: GatewayToolCall[] } & CacheBoundaryMarker)
  | ({ role: 'tool'; toolCallId: string; toolName: string; content: string } & CacheBoundaryMarker)

/** Egy üzenet szöveges reprezentációja (token-becsléshez / prompt-építéshez). */
export function messageText(m: GatewayMessage): string {
  if (m.role === 'assistant') return m.content ?? ''
  return m.content
}

export type ModelProviderResult = {
  content: string
  /** Natív tool hívások, ha a modell eszközt kért (szöveg helyett/mellett). */
  toolCalls?: GatewayToolCall[]
  usage?: {
    promptTokens?: number
    completionTokens?: number
    /** Prompt-cache-ből olvasott prompt-token (ahol a provider visszaadja). */
    cachedPromptTokens?: number
    /** Prompt-cache-be írt prompt-token (ahol a provider visszaadja). */
    cacheWritePromptTokens?: number
  }
  latencyMs: number
  /** A provider által ténylegesen használt modell (pl. a feloldott `gpt-5.5`). */
  model?: string
  /** Szolgáltató-specifikus, tartalommentes konkurencia-diagnosztika. */
  oauthConcurrency?: ChatGptOAuthConcurrencyDiagnostic
}

export type ModelProviderUsage = NonNullable<ModelProviderResult['usage']>

export interface ModelProvider {
  readonly name: string
  /**
   * Opcionális képességjelző (#33): a provider tud-e séma-kényszerített választ.
   * Hiánya nem hiba — a runtime promptba fűzött sémával és közös beolvasóval megy.
   */
  readonly supportsStructuredOutput?: boolean
  chat(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    /** Natív tool use definíciók — ha megadva, a provider function callingot kér. */
    tools?: ToolDefinition[]
    /**
     * #33 — JSON Schema a válaszra (provider-natív séma-kényszer, ha támogatott).
     * A kapu továbbítja; a provider figyelmen kívül hagyhatja.
     */
    responseJsonSchema?: Record<string, unknown>
    /**
     * Chat "thinking-trace" spec — a modell gondolkodási (reasoning-summary)
     * deltáit oldalcsatornán adja tovább, ahol a provider ezt szolgáltatja. A
     * hívó felelős a tartalom-őrért (D5), mielőtt a kliensre kerül.
     */
    onReasoningDelta?: (delta: string) => void
    /** Forduló-falióra — a fetch és a body-olvasás is megszakad. */
    signal?: AbortSignal
  }): Promise<ModelProviderResult>
  chatStream?(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    onReasoningDelta?: (delta: string) => void
    /** A streaming válasz végén érkező provider usage-blokk oldalcsatornája. */
    onUsage?: (usage: ModelProviderUsage) => void
    signal?: AbortSignal
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
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    /** Prompt-cache telemetria — provideronként opcionális (ld. `extractPromptCacheUsage`). */
    prompt_tokens_details?: {
      cached_tokens?: number
      cache_write_tokens?: number
      cache_creation_tokens?: number
    } | null
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
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

/** OpenAI-kompatibilis szöveg-rész, opcionális Anthropic-stílusú cache-jelöléssel. */
type OpenAiTextPart = {
  type: 'text'
  text: string
  cache_control?: CacheControlPayload
}

type OpenAiRequestMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAiTextPart[] | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

/**
 * Cache-határ rátétele egy kész üzenetre: a sima szöveges `content` egyetlen
 * `text` részre bomlik, amin ott a `cache_control`. Ez az OpenAI-kompatibilis
 * séma dokumentált módja az Anthropic-stílusú breakpoint átadására; a tartalom
 * bájtra változatlan marad, csak a burkolat lesz tömb.
 */
function withCacheControl(
  message: OpenAiRequestMessage,
  cacheControl: CacheControlPayload,
): OpenAiRequestMessage {
  if (typeof message.content !== 'string' || !message.content) return message
  return {
    ...message,
    content: [{ type: 'text', text: message.content, cache_control: cacheControl }],
  }
}

/** Egy `GatewayMessage`-t OpenAI chat/completions üzenet-alakra fordít. */
function toOpenAiMessage(m: GatewayMessage, cacheControl?: CacheControlPayload): OpenAiRequestMessage {
  const message = toOpenAiMessageBase(m)
  return cacheControl ? withCacheControl(message, cacheControl) : message
}

function toOpenAiMessageBase(m: GatewayMessage): OpenAiRequestMessage {
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
      'A platform célja kontrollált, auditálható AI agent munkakörnyezet biztosítása; minden modellhívás a Model Gatewayen, minden eszközhívás a Tool Brokeren keresztül történik.',
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
    responseJsonSchema?: Record<string, unknown>
    onReasoningDelta?: (delta: string) => void
    signal?: AbortSignal
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
        reasoningEffort: resolveReasoningEffort(input.modelConfig.modelType),
        onReasoningDelta: input.onReasoningDelta,
        signal: input.signal,
      })
      return {
        content: result.content,
        toolCalls: result.toolCalls,
        usage: result.usage,
        latencyMs: Date.now() - started,
        model: result.model,
        oauthConcurrency: result.oauthConcurrency,
      }
    }

    if (!providerUrl || !internalKey) {
      throw new Error(
        'ChatGPT OAuth provider is not configured (állítsd be CHATGPT_OAUTH_TOKEN_SECRET / CHATGPT_OAUTH_EMBEDDED, vagy CHATGPT_OAUTH_PROVIDER_URL+KEY)',
      )
    }

    const started = Date.now()
    const response = await fetchWithProviderTimeout(providerUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${internalKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: input.signal,
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
    onReasoningDelta?: (delta: string) => void
    onUsage?: (usage: ModelProviderUsage) => void
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
        reasoningEffort: resolveReasoningEffort(input.modelConfig.modelType),
        onReasoningDelta: input.onReasoningDelta,
      })
      return
    }

    // External sidecar doesn't expose a streaming endpoint — fall back to
    // single-chunk via chat() so at least the SSE infrastructure still works.
    const result = await this.chat({ ...input, tools: undefined })
    yield result.content
  }
}

function isClaudeCodeStubConfigured(): boolean {
  return process.env.CLAUDE_CODE_OAUTH_STUB === 'true'
}

function isGrokCliStubConfigured(): boolean {
  return process.env.GROK_CLI_OAUTH_STUB === 'true'
}

/**
 * Claude Code előfizetéses OAuth (Pro/Max) — `claude auth login` / `claude setup-token`.
 * Nem Anthropic API-kulcs: a CLI session tokenjével hívjuk a Messages API-t.
 */
export class ClaudeCodeOAuthProvider implements ModelProvider {
  readonly name = 'claude-code-oauth'
  readonly supportsStructuredOutput = true

  async chat(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    tools?: ToolDefinition[]
    responseJsonSchema?: Record<string, unknown>
    onReasoningDelta?: (delta: string) => void
    signal?: AbortSignal
  }): Promise<ModelProviderResult> {
    if (isClaudeCodeStubConfigured()) {
      return stubWikiAnswer(input.messages)
    }
    if (!createClaudeCodeTokenStoreFromEnv()) {
      throw new Error(
        'Claude Code OAuth provider is not configured (CLAUDE_CODE_OAUTH_EMBEDDED=true vagy CLAUDE_CODE_OAUTH_TOKEN)',
      )
    }
    const started = Date.now()
    const tokens = await ensureFreshClaudeCodeTokens()
    const result = await callClaudeCodeOAuth({
      tokens,
      messages: input.messages,
      model: input.modelConfig.model,
      tools: input.tools,
      maxTokens: input.modelConfig.maxTokens,
      signal: input.signal,
      thinkingBudget: input.onReasoningDelta
        ? resolveClaudeThinkingBudget(input.modelConfig.modelType)
        : null,
      onReasoningDelta: input.onReasoningDelta,
    })
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      usage: result.usage,
      latencyMs: Date.now() - started,
      model: result.model,
    }
  }

  async *chatStream(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    onReasoningDelta?: (delta: string) => void
    onUsage?: (usage: ModelProviderUsage) => void
  }): AsyncGenerator<string, void, unknown> {
    if (isClaudeCodeStubConfigured()) {
      const result = stubWikiAnswer(input.messages)
      yield* stubChatStream(result.content)
      return
    }
    const tokens = await ensureFreshClaudeCodeTokens()
    yield* callClaudeCodeOAuthStream({
      tokens,
      messages: input.messages,
      model: input.modelConfig.model,
      thinkingBudget: input.onReasoningDelta
        ? resolveClaudeThinkingBudget(input.modelConfig.modelType)
        : null,
      onReasoningDelta: input.onReasoningDelta,
    })
  }
}

/**
 * Grok CLI előfizetéses OAuth (SuperGrok / X Premium+) — `grok login`.
 * Nem xAI API-kulcs: a ~/.grok/auth.json session tokenjével a CLI chat-proxyt hívjuk.
 */
export class GrokCliOAuthProvider implements ModelProvider {
  readonly name = 'grok-cli-oauth'
  readonly supportsStructuredOutput = true

  async chat(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    tools?: ToolDefinition[]
    responseJsonSchema?: Record<string, unknown>
    onReasoningDelta?: (delta: string) => void
    signal?: AbortSignal
  }): Promise<ModelProviderResult> {
    if (isGrokCliStubConfigured()) {
      return stubWikiAnswer(input.messages)
    }
    if (!createGrokCliTokenStoreFromEnv()) {
      throw new Error(
        'Grok CLI OAuth provider is not configured (GROK_CLI_OAUTH_EMBEDDED=true és `grok login`)',
      )
    }
    const started = Date.now()
    const tokens = await ensureFreshGrokCliTokens()
    const result = await callGrokCliOAuth({
      tokens,
      messages: input.messages,
      model: input.modelConfig.model,
      tools: input.tools,
      maxTokens: input.modelConfig.maxTokens,
      temperature: input.modelConfig.temperature,
      reasoningEffort: resolveGrokReasoningEffort(input.modelConfig.modelType),
      onReasoningDelta: input.onReasoningDelta,
      signal: input.signal,
    })
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      usage: result.usage,
      latencyMs: Date.now() - started,
      model: result.model,
    }
  }

  async *chatStream(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    onReasoningDelta?: (delta: string) => void
    onUsage?: (usage: ModelProviderUsage) => void
  }): AsyncGenerator<string, void, unknown> {
    if (isGrokCliStubConfigured()) {
      const result = stubWikiAnswer(input.messages)
      yield* stubChatStream(result.content)
      return
    }
    const tokens = await ensureFreshGrokCliTokens()
    yield* callGrokCliOAuthStream({
      tokens,
      messages: input.messages,
      model: input.modelConfig.model,
      reasoningEffort: resolveGrokReasoningEffort(input.modelConfig.modelType),
      onReasoningDelta: input.onReasoningDelta,
    })
  }
}

/**
 * OpenAI-kompatibilis provider helyi/önálló modellekhez (pl. Ollama-n futó
 * Gemma, vagy llama.cpp `llama-server`). A `modelConfig.provider` ezt választja
 * (pl. `ollama`); a `modelConfig.model` a backend modell-azonosítója
 * (pl. `gemma-local`). A base URL env-ből jön (default Ollama: localhost:11434).
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly supportsStructuredOutput = true

  constructor(
    readonly name: string,
    private baseUrlEnvVar: string,
    private defaultBaseUrl?: string,
    private apiKeyEnvVar?: string,
    private options: {
      apiKeyRequired?: boolean
      /**
       * A provider átengedi-e az Anthropic-stílusú `cache_control` breakpointot
       * (OpenRouter → Anthropic modellek). Ahol nincs explicit cache-API, ott
       * a jelölést NEM küldjük ki — az automatikus prefix-cache úgyis él.
       */
      promptCache?: boolean
      extraHeaders?: () => Record<string, string>
      /**
       * A request-body kiegészítése. A `reasoningRequested` jelzi, hogy a hívó
       * kért-e thinking-trace-t (a runtime csak akkor köti be az
       * `onReasoningDelta`-t, ha a tenant D7-kapcsolója engedélyezi) — így az
       * OpenRouter `reasoning.exclude`-ja (WP-7) csak akkor oldódik fel.
       */
      extraBody?: (ctx: { reasoningRequested: boolean }) => Record<string, unknown>
    } = {},
  ) {}

  /**
   * Mely üzenetekre kerüljön `cache_control`. A határt a prompt-assembler jelöli
   * ki a stabil zóna végén; itt már csak a provider-képesség és a politika
   * (kill switch, minimum prefix-hossz, max 4 breakpoint) dönt.
   */
  private cacheBreakpoints(messages: GatewayMessage[]): {
    indexes: Set<number>
    cacheControl: CacheControlPayload
  } {
    const policy = promptCachePolicyFromEnv()
    const indexes = this.options.promptCache ? resolveCacheBreakpoints(messages, policy) : []
    return { indexes: new Set(indexes), cacheControl: cacheControlPayload(policy) }
  }

  async chat(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    tools?: ToolDefinition[]
    responseJsonSchema?: Record<string, unknown>
    onReasoningDelta?: (delta: string) => void
    signal?: AbortSignal
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
    const { indexes: cacheIndexes, cacheControl } = this.cacheBreakpoints(input.messages)
    const response = await fetchWithProviderTimeout(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...this.options.extraHeaders?.(),
      },
      body: JSON.stringify({
        model: input.modelConfig.model,
        messages: input.messages.map((m, index) =>
          toOpenAiMessage(m, cacheIndexes.has(index) ? cacheControl : undefined),
        ),
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
        // #33 — provider-natív JSON Schema kényszer (OpenAI-kompatibilis response_format).
        // Tool-hívással együtt nem kényszerítünk sémát (a tool_choice felülírná).
        ...(input.responseJsonSchema && !input.tools?.length
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: 'structured_output',
                  strict: true,
                  schema: input.responseJsonSchema,
                },
              },
            }
          : {}),
        ...this.options.extraBody?.({ reasoningRequested: typeof input.onReasoningDelta === 'function' }),
      }),
      signal: input.signal,
    })

    if (!response.ok) {
      throw new Error(`${this.name} provider failed: ${response.status} ${(await response.text()).slice(0, 200)}`)
    }

    let data: OpenAiCompatibleResponse
    try {
      data = (await response.json()) as OpenAiCompatibleResponse
    } catch (error) {
      if (input.signal?.aborted) throw new ModelCallAbortedError()
      throw error
    }
    const content = extractOpenAiCompatibleContent(data)
    const toolCalls = extractOpenAiToolCalls(data)

    // Chat "thinking-trace" (WP-7) nem-streamelő ág: ha a hívó kért reasoning-et
    // és a modell külön `message.reasoning`-et adott vissza (nem a content
    // fallbackje), egyetlen deltaként továbbadjuk. A tartalom-őr (D5) a hívónál fut.
    const rawReasoning = data.choices?.[0]?.message?.reasoning
    if (
      input.onReasoningDelta &&
      typeof rawReasoning === 'string' &&
      rawReasoning.trim() &&
      rawReasoning !== content
    ) {
      input.onReasoningDelta(rawReasoning)
    }

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
        ...extractPromptCacheUsage(data.usage),
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
    onReasoningDelta?: (delta: string) => void
    onUsage?: (usage: ModelProviderUsage) => void
    signal?: AbortSignal
  }): AsyncGenerator<string, void, unknown> {
    const baseUrl = (process.env[this.baseUrlEnvVar] || this.defaultBaseUrl)?.replace(/\/+$/, '')
    if (!baseUrl) {
      throw new Error(`${this.name} provider base URL not configured (${this.baseUrlEnvVar})`)
    }
    const apiKey = this.apiKeyEnvVar ? process.env[this.apiKeyEnvVar] : undefined
    if (this.options.apiKeyRequired && !apiKey?.trim()) {
      throw new Error(`${this.name} provider API key not configured (${this.apiKeyEnvVar})`)
    }

    const { indexes: cacheIndexes, cacheControl } = this.cacheBreakpoints(input.messages)
    const response = await fetchWithProviderTimeout(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...this.options.extraHeaders?.(),
      },
      body: JSON.stringify({
        model: input.modelConfig.model,
        messages: input.messages.map((m, index) =>
          toOpenAiMessage(m, cacheIndexes.has(index) ? cacheControl : undefined),
        ),
        temperature: input.modelConfig.temperature,
        max_tokens: input.modelConfig.maxTokens,
        stream: true,
        ...(this.options.promptCache ? { stream_options: { include_usage: true } } : {}),
        ...this.options.extraBody?.({ reasoningRequested: typeof input.onReasoningDelta === 'function' }),
      }),
      signal: input.signal,
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
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string; reasoning?: string } }>
              usage?: OpenAiCompatibleResponse['usage']
            }
            if (parsed.usage) {
              input.onUsage?.({
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens,
                ...extractPromptCacheUsage(parsed.usage),
              })
            }
            const delta = parsed.choices?.[0]?.delta
            // OpenRouter/kompatibilis reasoning-csatorna (WP-7): csak akkor jön, ha a
            // provider a `reasoning.exclude:false`-t kapta és a modell szolgáltatja.
            if (input.onReasoningDelta && typeof delta?.reasoning === 'string' && delta.reasoning) {
              input.onReasoningDelta(delta.reasoning)
            }
            const chunk = delta?.content
            if (typeof chunk === 'string' && chunk) yield chunk
          } catch {
            // ignore malformed SSE JSON lines
          }
        }
      }
    } catch (error) {
      // A forduló-falióra a body-olvasás közben is megszakíthat.
      if (input.signal?.aborted) throw new ModelCallAbortedError()
      throw error
    } finally {
      reader.releaseLock()
    }
  }
}

/** A Gateway által ismert providerek (modelConfig.provider → implementáció). */
export function createDefaultProviders(): Map<string, ModelProvider> {
  const providers: ModelProvider[] = [
    new ChatGptOAuthProvider(),
    new ClaudeCodeOAuthProvider(),
    new GrokCliOAuthProvider(),
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
        // Az OpenRouter átengedi az Anthropic-stílusú `cache_control` breakpointot
        // a mögöttes modellnek — ez a platform egyetlen olyan útja, ahol a stabil
        // prefix csak explicit jelöléssel cache-elődik.
        promptCache: true,
        extraHeaders: () => ({
          ...(process.env.OPENROUTER_HTTP_REFERER
            ? { 'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER }
            : {}),
          ...(process.env.OPENROUTER_APP_TITLE
            ? { 'X-OpenRouter-Title': process.env.OPENROUTER_APP_TITLE }
            : {}),
        }),
        // WP-7: a reasoning-csatorna alapból kizárt (költség + válaszméret), és
        // csak akkor oldjuk fel, ha a hívó kért thinking-trace-t — azaz a tenant
        // D7-kapcsolója engedélyezte és a runtime bekötötte az `onReasoningDelta`-t.
        extraBody: ({ reasoningRequested }) => ({ reasoning: { exclude: !reasoningRequested } }),
      },
    ),
  ]
  return new Map(providers.map((p) => [p.name, p]))
}

/**
 * Prompt-cache mérés: metrikába írja a cache-ből olvasott / cache-be írt
 * prompt-tokeneket, és visszaadja az audit-metadata mezőket. Csak számokat ad
 * tovább, prompt-tartalmat soha (MG-N4). Ahol a provider nem jelent cache-adatot,
 * a visszaadott objektum üres — nem szemeteljük tele az auditot nullákkal.
 *
 * A számokat a naplóba NEM tesszük: a logger a `prompt`/`token` kulcsneveket
 * redaktálja (`REDACT_KEYS`), ott csak a `cacheHit` jelzés hasznos. A tényleges
 * megtakarítást a `model_gateway_prompt_cache_tokens_total` metrikán mérjük.
 */
function recordPromptCacheUsage(
  provider: string,
  usage: ModelProviderResult['usage'],
): { cachedPromptTokens?: number; cacheWritePromptTokens?: number } {
  const cachedPromptTokens = usage?.cachedPromptTokens
  const cacheWritePromptTokens = usage?.cacheWritePromptTokens
  if (cachedPromptTokens) {
    modelPromptCacheTokensTotal.inc({ provider, kind: 'read' }, cachedPromptTokens)
  }
  if (cacheWritePromptTokens) {
    modelPromptCacheTokensTotal.inc({ provider, kind: 'write' }, cacheWritePromptTokens)
  }
  return {
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(cacheWritePromptTokens !== undefined ? { cacheWritePromptTokens } : {}),
  }
}

/**
 * Napló-jelzés a prompt-cache-ről: `true`, ha a provider cache-találatot
 * jelentett. Ha a provider egyáltalán nem ad cache-telemetriát, a mező kimarad
 * — a „nincs adat" és a „nem volt találat" nem ugyanaz.
 */
function promptCacheLogFields(cache: {
  cachedPromptTokens?: number
  cacheWritePromptTokens?: number
}): { cacheHit?: boolean } {
  if (cache.cachedPromptTokens === undefined && cache.cacheWritePromptTokens === undefined) {
    return {}
  }
  return { cacheHit: (cache.cachedPromptTokens ?? 0) > 0 }
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
      // 401/4xx: a következő kísérlet ugyanazt adná. A tartalék-lánc dolga
      // váltani, nem a retry. Csak 5xx/hálózat ismétlődik a tartalék előtt.
      if (!isTransientRetryable(classifyProviderError(error))) throw error
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
      }
    }
  }
  throw lastError
}

export type EntityResolutionProvider = (ctx: {
  agentId: string
  tenantId: string
}) => Promise<UserInputEntityResolution | null>

export class ModelGateway {
  constructor(
    private audit: AuditRepository,
    private modelCalls: ModelCallRepository,
    private providers: Map<string, ModelProvider> = createDefaultProviders(),
    private guardrail: GatewayGuardrail = guardrailFromEnv(),
    private routingEngine?: RoutingEngine,
    private budgetEngine?: BudgetEngine,
    private sensitivityPolicy: SensitivityPolicy = sensitivityPolicyFromEnv(),
    // D11 / §16.1 — a `model.pricing` tarifa-forrás a valódi costEstimate-hez.
    // Ha nincs megadva, a beépített DEFAULT_MODEL_PRICING él (a költség NEM marad 0).
    private pricingSettings?: Pick<PlatformSettingsRepository, 'get'>,
    /** Ha nincs megadva, egyetlen agent sem kap sensitivity-router felmentést. */
    private agentSensitivityPolicy?: AgentSensitivityPolicyReader,
    /**
     * Ha nincs megadva, a hívó `tenantId`-ja dönt; annak hiányában csak a
     * platform-szintű keretek és routing-policy-k élnek (idegen tenant sosem).
     */
    private agentTenantResolver?: AgentTenantResolver,
  ) {}

  /**
   * Folyamat-szintű skip: ha a ChatGPT OAuth (vagy más elsődleges) 401/unavailable,
   * a következő hívások a tartalékkal indulnak. Ez a fallback értelme — ne égesse
   * el a forduló falióráját ugyanarra a holt providerre.
   */
  private readonly skipLedger = new ProviderSkipLedger()

  private async resolveMaxCallsPerTicketLimit(): Promise<number> {
    if (this.pricingSettings) {
      const raw = await this.pricingSettings.get(GATEWAY_TICKET_CALL_CAP_KEY)
      const stored = parseGatewayTicketCallCapStored(raw)
      return resolveMaxCallsPerTicket({ platformMax: stored?.maxCallsPerTicket ?? null })
    }
    return this.guardrail.maxCallsPerTicket
  }

  /**
   * APG-12 — prompt-privacy transzformáció a classify előtt. Hiányában a mai
   * sorrend marad (osztályozó a nyers üzeneteken).
   */
  private privacyEngine: SurrogateEngine | null = null
  private privacyModeResolver: PrivacyModeResolver | null = null
  private sensitivityModeResolver: SensitivityModeResolver | null = null
  private entityResolutionProvider: EntityResolutionProvider | null = null

  setPrivacyEngine(engine: SurrogateEngine | null): void {
    this.privacyEngine = engine
  }

  setPrivacyModeResolver(resolver: PrivacyModeResolver | null): void {
    this.privacyModeResolver = resolver
  }

  setSensitivityModeResolver(resolver: SensitivityModeResolver | null): void {
    this.sensitivityModeResolver = resolver
  }

  /** APG-17 — prompt előtti connector `resolve()` (best-effort). */
  setEntityResolutionProvider(provider: EntityResolutionProvider | null): void {
    this.entityResolutionProvider = provider
  }

  private async categoryActionForCall(agentId: string, category?: string): Promise<PrivacyCategoryAction | null> {
    if (!this.agentSensitivityPolicy?.actionForCategory || !category) return null
    return this.agentSensitivityPolicy.actionForCategory(agentId, category)
  }

  /**
   * Ha a reader csak a régi boolean seamet implementálja, az minden kategóriára
   * `allow`-t jelent (a mai mindent-vagy-semmit felmentés).
   */
  private async categoryAllowsExternalRaw(agentId: string, category?: string): Promise<boolean> {
    if (!this.agentSensitivityPolicy) return false
    if (this.agentSensitivityPolicy.actionForCategory) {
      const action = await this.categoryActionForCall(agentId, category)
      return action != null && allowsExternalRaw(action)
    }
    return this.agentSensitivityPolicy.allowsSensitiveExternalModel(agentId)
  }

  /**
   * Ellenőrzi és auditálja az agent kategória-policy `allow` felmentését.
   * A nyers érték kimehet; az osztályozás és az auditnyom ettől még megmarad.
   */
  private async allowsAgentSensitivityBypass(ctx: {
    agentId: string
    agentVersion: number | null
    ticketId?: string
    conversationId?: string
    modelUsed: string
    sensitivity: SensitivityDecision
  }): Promise<boolean> {
    const bypass = await this.categoryAllowsExternalRaw(ctx.agentId, ctx.sensitivity.matchedCategory)
    if (!bypass) return false

    const targetType = ctx.ticketId ? 'ticket' : ctx.conversationId ? 'conversation' : 'agent'
    const targetId = ctx.ticketId ?? ctx.conversationId ?? ctx.agentId
    const category = ctx.sensitivity.matchedCategory
    await this.audit.append({
      actorType: 'agent',
      actorId: ctx.agentId,
      agentVersion: ctx.agentVersion,
      action: 'model.call.sensitivity_agent_bypass',
      targetType,
      targetId,
      modelUsed: ctx.modelUsed,
      inputRef: `sensitivity:${category}`,
      outputRef: 'allowed_by_agent_policy',
      policyDecision: 'agent_sensitivity_bypass',
      metadata: {
        reason: 'agent_allows_sensitive_external_model',
        level: ctx.sensitivity.level,
        category,
      },
    })
    return true
  }

  /**
   * A hívás szervezete: az explicit `tenantId` erősebb, egyébként az agent
   * szervezete. Ha egyik sincs, `null` — ilyenkor csak a platform-szintű keretek
   * és routing-policy-k élnek, idegen szervezeté soha.
   */
  private async resolveTenantId(
    agentId: string,
    explicitTenantId?: string,
  ): Promise<string | null> {
    if (explicitTenantId) return explicitTenantId
    if (!this.agentTenantResolver) return null
    try {
      return await this.agentTenantResolver.tenantIdForAgent(agentId)
    } catch {
      // A feloldás hibája nem buktathatja a modellhívást; a szűkebb (platform-szintű)
      // keret-halmaz marad érvényben.
      return null
    }
  }

  private async resolvePrivacyGatewayModeForCall(
    tenantId: string | null,
    agentId: string,
  ): Promise<PrivacyGatewayMode | null> {
    if (!this.privacyModeResolver || !tenantId) return null
    return this.privacyModeResolver({ tenantId, agentId })
  }

  private async resolveSensitivityLayerModeForCall(
    tenantId: string | null,
    agentId: string,
  ): Promise<SensitivityLayerMode | null> {
    if (!this.sensitivityModeResolver || !tenantId) return null
    return this.sensitivityModeResolver({ tenantId, agentId })
  }

  private async recordSensitivityObserved(ctx: {
    agentId: string
    agentVersion: number | null
    ticketId?: string
    conversationId?: string
    modelUsed: string
    sensitivity: SensitivityDecision
    wouldHave: 'block' | 'local'
  }): Promise<void> {
    const category = ctx.sensitivity.matchedCategory
    const targetType = ctx.ticketId ? 'ticket' : ctx.conversationId ? 'conversation' : 'agent'
    const targetId = ctx.ticketId ?? ctx.conversationId ?? ctx.agentId
    await this.audit.append({
      actorType: 'agent',
      actorId: ctx.agentId,
      agentVersion: ctx.agentVersion,
      action: 'model.call.sensitivity_observed',
      targetType,
      targetId,
      modelUsed: ctx.modelUsed,
      inputRef: `sensitivity:${category}`,
      outputRef: 'observed',
      policyDecision: 'observed',
      metadata: {
        reason: 'sensitivity_layer_skip_enforcement',
        category,
        level: ctx.sensitivity.level,
        wouldHave: ctx.wouldHave,
      },
    })
  }

  /** Közös forbidden preflight a normál és a streaming modellhíváshoz. */
  private async enforceForbiddenSensitivityPolicy(ctx: {
    agentId: string
    agentVersion: number | null
    ticketId?: string
    conversationId?: string
    modelUsed: string
    sensitivity: SensitivityDecision
    sensitivityOverride?: SensitivityOverride
    observeOnly?: boolean
    auditObservation?: boolean
  }): Promise<void> {
    if (ctx.sensitivity.level !== 'forbidden') return

    if (ctx.observeOnly) {
      if (ctx.auditObservation) {
        await this.recordSensitivityObserved({ ...ctx, wouldHave: 'block' })
      }
      return
    }

    if (await this.allowsAgentSensitivityBypass(ctx)) return

    const category = ctx.sensitivity.matchedCategory
    const targetType = ctx.ticketId ? 'ticket' : ctx.conversationId ? 'conversation' : 'agent'
    const targetId = ctx.ticketId ?? ctx.conversationId ?? ctx.agentId
    const sensitivityOverrideAllowed =
      !!category && ctx.sensitivityOverride?.allowedForbiddenCategories.includes(category)

    if (!sensitivityOverrideAllowed) {
      await this.audit.append({
        actorType: 'agent',
        actorId: ctx.agentId,
        agentVersion: ctx.agentVersion,
        action: 'model.call.denied',
        targetType,
        targetId,
        modelUsed: ctx.modelUsed,
        inputRef: `sensitivity:${category}`,
        outputRef: 'blocked',
        policyDecision: 'sensitivity_block',
        metadata: { reason: 'sensitivity_block', category },
      })
      throw new GatewayBudgetError(formatSensitivityBlockMessage(category))
    }

    await this.audit.append({
      actorType: 'human',
      actorId: ctx.sensitivityOverride!.reviewedByUserId,
      agentVersion: ctx.agentVersion,
      action: 'model.call.sensitivity_override',
      targetType,
      targetId,
      modelUsed: ctx.modelUsed,
      inputRef: `sensitivity:${category}`,
      outputRef: 'allowed_by_human_review',
      policyDecision: 'human_review_override',
      metadata: {
        reason: ctx.sensitivityOverride!.reason,
        category,
      },
    })
  }

  /**
   * Eldönti, hogy a `sensitive` prompt hová mehet. Három kimenet:
   *   - `external`  — az agent kapott felmentést (audit-ált), marad a routing döntése
   *   - `local`     — helyi modellre kényszerítünk
   *   - dobás       — nincs hová: fail-closed blokk
   */
  private async resolveSensitiveTarget(ctx: {
    agentId: string
    agentVersion: number | null
    ticketId?: string
    conversationId?: string
    modelUsed: string
    sensitivity: SensitivityDecision
    sensitivityOverride?: SensitivityOverride
  }): Promise<'external' | 'local'> {
    const category = ctx.sensitivity.matchedCategory

    if (await this.allowsAgentSensitivityBypass(ctx)) return 'external'

    const categoryAction = await this.categoryActionForCall(ctx.agentId, category)
    if (categoryAction === 'block') {
      const targetType = ctx.ticketId ? 'ticket' : ctx.conversationId ? 'conversation' : 'agent'
      const targetId = ctx.ticketId ?? ctx.conversationId ?? ctx.agentId
      await this.audit.append({
        actorType: 'agent',
        actorId: ctx.agentId,
        agentVersion: ctx.agentVersion,
        action: 'model.call.denied',
        targetType,
        targetId,
        modelUsed: ctx.modelUsed,
        inputRef: `sensitivity:${category}`,
        outputRef: 'blocked',
        policyDecision: 'sensitivity_block',
        metadata: { reason: 'category_policy_block', category },
      })
      throw new GatewayBudgetError(formatSensitivityBlockMessage(category))
    }

    const localUsable =
      this.sensitivityPolicy.localModelAvailable &&
      this.providers.has(this.sensitivityPolicy.localProvider)
    if (localUsable) return 'local'

    const sensitivityOverrideAllowed =
      !!category && ctx.sensitivityOverride?.allowedForbiddenCategories.includes(category)
    if (sensitivityOverrideAllowed) {
      const targetType = ctx.ticketId ? 'ticket' : ctx.conversationId ? 'conversation' : 'agent'
      const targetId = ctx.ticketId ?? ctx.conversationId ?? ctx.agentId
      await this.audit.append({
        actorType: 'human',
        actorId: ctx.sensitivityOverride!.reviewedByUserId,
        agentVersion: ctx.agentVersion,
        action: 'model.call.sensitivity_override',
        targetType,
        targetId,
        modelUsed: ctx.modelUsed,
        inputRef: `sensitivity:${category}`,
        outputRef: 'allowed_by_human_review',
        policyDecision: 'human_review_override',
        metadata: {
          reason: ctx.sensitivityOverride!.reason,
          category,
          level: ctx.sensitivity.level,
        },
      })
      return 'external'
    }

    const targetType = ctx.ticketId ? 'ticket' : ctx.conversationId ? 'conversation' : 'agent'
    const targetId = ctx.ticketId ?? ctx.conversationId ?? ctx.agentId
    await this.audit.append({
      actorType: 'agent',
      actorId: ctx.agentId,
      agentVersion: ctx.agentVersion,
      action: 'model.call.denied',
      targetType,
      targetId,
      modelUsed: ctx.modelUsed,
      inputRef: `sensitivity:${category}`,
      outputRef: 'blocked',
      policyDecision: 'sensitivity_local_unavailable',
      metadata: {
        reason: 'sensitivity_local_unavailable',
        category,
        localProvider: this.sensitivityPolicy.localProvider,
        localModel: this.sensitivityPolicy.localModel,
      },
    })
    modelCallsTotal.inc({ provider: 'sensitivity', status: 'local_unavailable' })
    throw new GatewaySensitivityError(
      `Érzékeny tartalmat (${category}) észleltem, ezt csak helyi modell dolgozhatná fel — ` +
        `de ebben a környezetben nincs elérhető helyi modell (${this.sensitivityPolicy.localProvider}/${this.sensitivityPolicy.localModel}). ` +
        `A hívás blokkolva. Engedélyezd az agentnél a külső modellt, vagy állíts be helyi modellt.`,
      category,
      'local_model_unavailable',
    )
  }

  private async applySensitivityRouting(ctx: {
    agentId: string
    agentVersion: number | null
    ticketId?: string
    conversationId?: string
    resolvedConfig: ModelConfig
    sensitivity: SensitivityDecision
    sensitivityOverride?: SensitivityOverride
    observeOnly?: boolean
    auditObservation?: boolean
  }): Promise<{ resolvedConfig: ModelConfig; forcedLocal: boolean }> {
    if (ctx.sensitivity.level !== 'sensitive' || !this.sensitivityPolicy.enforceLocalForSensitive) {
      return { resolvedConfig: ctx.resolvedConfig, forcedLocal: false }
    }

    if (ctx.observeOnly) {
      if (ctx.auditObservation) {
        await this.recordSensitivityObserved({
          agentId: ctx.agentId,
          agentVersion: ctx.agentVersion,
          ticketId: ctx.ticketId,
          conversationId: ctx.conversationId,
          modelUsed: ctx.resolvedConfig.model,
          sensitivity: ctx.sensitivity,
          wouldHave: 'local',
        })
      }
      return { resolvedConfig: ctx.resolvedConfig, forcedLocal: false }
    }

    const target = await this.resolveSensitiveTarget({
      agentId: ctx.agentId,
      agentVersion: ctx.agentVersion,
      ticketId: ctx.ticketId,
      conversationId: ctx.conversationId,
      modelUsed: ctx.resolvedConfig.model,
      sensitivity: ctx.sensitivity,
      sensitivityOverride: ctx.sensitivityOverride,
    })
    if (target === 'external') {
      return { resolvedConfig: ctx.resolvedConfig, forcedLocal: false }
    }

    return {
      resolvedConfig: {
        ...ctx.resolvedConfig,
        provider: this.sensitivityPolicy.localProvider,
        model: this.sensitivityPolicy.localModel,
      },
      forcedLocal: true,
    }
  }

  private localSensitivityError(params: {
    sensitivity: SensitivityDecision
    provider: string
    model: string
    providerError: string
  }): GatewaySensitivityError {
    return new GatewaySensitivityError(
      `Érzékeny tartalmat (${params.sensitivity.matchedCategory}) észleltem, a helyi modell ` +
        `(${params.provider}/${params.model}) viszont nem válaszolt: ${params.providerError}. ` +
        `A hívás blokkolva, adat nem hagyta el a platformot.`,
      params.sensitivity.matchedCategory,
      'local_call_failed',
    )
  }

  /**
   * Tarifa-betöltés hívásonként (három réteg → merge; hiány/hiba → builtin).
   * Nincs process-lifetime cache: admin mentés / CLI szinkron a következő híváson él.
   */
  private async loadPricing(): Promise<ModelPricingTable> {
    if (!this.pricingSettings) return DEFAULT_MODEL_PRICING
    try {
      const [manual, synced] = await Promise.all([
        this.pricingSettings.get(MODEL_PRICING_SETTING_KEY),
        this.pricingSettings.get(MODEL_PRICING_SYNCED_SETTING_KEY),
      ])
      return resolvePricingFromSettings({ manual, synced })
    } catch {
      return DEFAULT_MODEL_PRICING
    }
  }

  /** Globális tartalék-lánc — szintén hívásonként friss (nincs örök cache). */
  private async loadGlobalFallbacks(): Promise<FallbackCandidate[]> {
    if (!this.pricingSettings) return []
    try {
      const raw = await this.pricingSettings.get(FALLBACK_CHAIN_SETTING_KEY)
      return parseFallbackChainSetting(raw)
    } catch {
      return []
    }
  }

  /**
   * Effektív tartalék-lánc előnézet (admin UI). Ugyanaz a feloldás + szűrés, mint a hívási úton
   * (routing → érzékeny helyi kényszer → agent/globális tartalék).
   * A `sensitiveBranch` a helyi-kényszerített ágat jelöli.
   */
  async previewEffectiveFallbackChain(input: {
    primary: FallbackCandidate
    agentId?: string
    tenantId?: string
    agentModelConfig?: unknown
    /** Ha true, az érzékeny ágat szimulálja (csak helyi jelöltek). */
    simulateSensitive?: boolean
  }): Promise<{
    chain: FallbackCandidate[]
    sensitiveBranch: boolean
    localProvider: string
  }> {
    let primary = input.primary
    const agentModelConfig: ModelConfig = {
      provider: primary.provider,
      model: primary.model,
      ...(input.agentModelConfig &&
      typeof input.agentModelConfig === 'object' &&
      !Array.isArray(input.agentModelConfig)
        ? (input.agentModelConfig as ModelConfig)
        : {}),
    }

    if (this.routingEngine && input.agentId) {
      const decision = await this.routingEngine.resolve({
        agentId: input.agentId,
        tenantId: input.tenantId,
        agentModelConfig,
      })
      primary = { provider: decision.provider, model: decision.model }
    }

    const forcedLocal = !!input.simulateSensitive && this.sensitivityPolicy.enforceLocalForSensitive
    const chain = buildEffectiveFallbackChain({
      primary: forcedLocal
        ? {
            provider: this.sensitivityPolicy.localProvider,
            model: this.sensitivityPolicy.localModel,
          }
        : primary,
      agentFallbacks: extractAgentFallbackModels(input.agentModelConfig ?? agentModelConfig),
      globalFallbacks: await this.loadGlobalFallbacks(),
      knownProviders: this.providers.keys(),
      forcedLocal,
      localProvider: this.sensitivityPolicy.localProvider,
      maxAttempts: fallbackMaxAttemptsFromEnv(),
    })
    return {
      chain,
      sensitiveBranch: forcedLocal,
      localProvider: this.sensitivityPolicy.localProvider,
    }
  }

  private async resolveCallChain(input: {
    resolvedConfig: ModelConfig
    agentModelConfig: unknown
    forcedLocal: boolean
  }): Promise<FallbackCandidate[]> {
    const chain = buildEffectiveFallbackChain({
      primary: {
        provider: input.resolvedConfig.provider,
        model: input.resolvedConfig.model || 'chatgpt-oauth-default',
      },
      agentFallbacks: extractAgentFallbackModels(input.agentModelConfig),
      globalFallbacks: await this.loadGlobalFallbacks(),
      knownProviders: this.providers.keys(),
      forcedLocal: input.forcedLocal,
      localProvider: this.sensitivityPolicy.localProvider,
      maxAttempts: fallbackMaxAttemptsFromEnv(),
    })
    return this.skipLedger.filterChain(chain)
  }

  /**
   * Közös előkészítés a `call` / `callStream` számára: érzékenység, routing,
   * keret-kapu, effektív tartalék-lánc. A request nem írhatja felül a láncot.
   */
  private async prepareModelCall(params: {
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
  }): Promise<{
    agentVersion: number | null
    sensitivity: SensitivityDecision
    resolvedConfig: ModelConfig
    forcedLocal: boolean
    chain: FallbackCandidate[]
    attemptGroupId: string
    prompt: string
    messages: GatewayMessage[]
    targetType: 'ticket' | 'conversation' | 'agent'
    targetId: string
  }> {
    const agentVersion = params.agentVersion ?? null
    // A szervezet a keret- és routing-kapu kulcsa. A hívó megadhatja, de ha nem
    // teszi (a futásidejű utak nem viszik), az agentből oldjuk fel — így nem
    // eshetünk vissza a „minden tenant kerete érvényes" állapotba.
    const tenantId = await this.resolveTenantId(params.agentId, params.tenantId)

    const privacyMode = await this.resolvePrivacyGatewayModeForCall(tenantId, params.agentId)
    const sensitivityMode = await this.resolveSensitivityLayerModeForCall(tenantId, params.agentId)
    const skipSensitivity = sensitivityLayerSkipsEnforcement(sensitivityMode)
    const auditSensitivity = sensitivityLayerAuditsObservation(sensitivityMode)

    const messages = await this.applyPromptPrivacyTransform({
      agentId: params.agentId,
      tenantId,
      ticketId: params.ticketId,
      conversationId: params.conversationId,
      messages: params.messages,
      mode: privacyMode,
    })
    const sensitivity = classifyPrompt(messages)
    await this.enforceForbiddenSensitivityPolicy({
      agentId: params.agentId,
      agentVersion,
      ticketId: params.ticketId,
      conversationId: params.conversationId,
      modelUsed: params.modelConfig.model,
      sensitivity,
      sensitivityOverride: params.sensitivityOverride,
      observeOnly: skipSensitivity,
      auditObservation: auditSensitivity,
    })

    let resolvedConfig = { ...params.modelConfig }
    if (this.routingEngine) {
      const decision = await this.routingEngine.resolve({
        agentId: params.agentId,
        ...(tenantId ? { tenantId } : {}),
        ticketType: params.ticketType,
        overrideHint: params.modelOverrideHint,
        agentModelConfig: params.modelConfig,
      })
      resolvedConfig = { ...resolvedConfig, provider: decision.provider, model: decision.model }
    }

    const sensitivityRouting = await this.applySensitivityRouting({
      agentId: params.agentId,
      agentVersion,
      ticketId: params.ticketId,
      conversationId: params.conversationId,
      resolvedConfig,
      sensitivity,
      sensitivityOverride: params.sensitivityOverride,
      observeOnly: skipSensitivity,
      auditObservation: auditSensitivity,
    })
    resolvedConfig = sensitivityRouting.resolvedConfig
    const forcedLocal = sensitivityRouting.forcedLocal
    const model = resolvedConfig.model || 'chatgpt-oauth-default'

    if (params.ticketId && isUuid(params.ticketId)) {
      const maxCallsPerTicket = await this.resolveMaxCallsPerTicketLimit()
      const usage = await this.modelCalls.getUsageForTicket(params.ticketId)
      if (usage.calls >= maxCallsPerTicket) {
        await this.audit.append({
          actorType: 'agent',
          actorId: params.agentId,
          agentVersion,
          action: 'model.call.denied',
          targetType: 'ticket',
          targetId: params.ticketId,
          modelUsed: model,
          inputRef: `calls:${usage.calls}`,
          outputRef: `cap:${maxCallsPerTicket}`,
          policyDecision: 'budget_blocked',
          metadata: usage,
        })
        modelCallsTotal.inc({ provider: 'guardrail', status: 'budget_blocked' })
        throw new GatewayBudgetError(
          `Gateway guardrail: ticket ${params.ticketId} reached ${maxCallsPerTicket} model calls`,
        )
      }
    }

    if (this.budgetEngine) {
      const budgetCheck = await this.budgetEngine.check({
        tenantId,
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

    const chain = await this.resolveCallChain({
      resolvedConfig,
      agentModelConfig: params.modelConfig,
      forcedLocal,
    })
    if (chain.length === 0) {
      throw new Error(
        `Unsupported model provider: ${resolvedConfig.provider} (ismert: ${[...this.providers.keys()].join(', ')})`,
      )
    }

    const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
    const targetId = params.ticketId ?? params.conversationId ?? params.agentId
    return {
      agentVersion,
      sensitivity,
      resolvedConfig,
      forcedLocal,
      chain,
      attemptGroupId: crypto.randomUUID(),
      prompt: messages
        .map((m) => `${m.role.toUpperCase()}: ${messageText(m)}`)
        .join('\n\n'),
      messages,
      targetType,
      targetId,
    }
  }

  /**
   * Spec §2 sorrend: privacy transform a classify előtt. OBSERVE/OFF vagy hiányzó
   * engine/scope esetén a nyers üzenetek mennek tovább — a mai viselkedés.
   */
  private async applyPromptPrivacyTransform(ctx: {
    agentId: string
    tenantId: string | null
    ticketId?: string
    conversationId?: string
    messages: GatewayMessage[]
    mode?: PrivacyGatewayMode | null
  }): Promise<GatewayMessage[]> {
    if (!this.privacyEngine || !this.privacyModeResolver || !ctx.tenantId) {
      return ctx.messages
    }
    const scope = privacyScopeForCall(ctx.conversationId, ctx.ticketId)
    if (!scope) return ctx.messages

    const mode: PrivacyGatewayMode =
      ctx.mode ??
      (await this.privacyModeResolver({
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
      }))
    if (mode === 'off') return ctx.messages

    const started = Date.now()
    try {
      const entityResolution =
        this.entityResolutionProvider && ctx.tenantId
          ? await this.entityResolutionProvider({ agentId: ctx.agentId, tenantId: ctx.tenantId })
          : null
      const result = await transformPromptMessages({
        messages: ctx.messages,
        mode,
        // A szabad szöveges minta-réteg (e-mail/telefon/bankszámla) az agent
        // overlay-jel feloldott kategória-akciót követi. Reader nélkül
        // `local_only`: nem álnevesítünk, a routing dönt — nyers érték így sem
        // megy külső modellhez.
        policy: async (category) =>
          (await this.categoryActionForCall(ctx.agentId, category)) ?? 'local_only',
        engine: this.privacyEngine,
        tenantId: ctx.tenantId,
        scope,
        entityResolution: entityResolution ?? undefined,
      })
      if (result.spans.length > 0) {
        await recordPrivacyGatewayAudit(this.audit, {
          action: result.applied ? 'privacy.transform.applied' : 'privacy.transform.observed',
          tenantId: ctx.tenantId,
          scope,
          summary: summarizePrivacySpans(result.spans),
          mode,
          ticketId: ctx.ticketId ?? null,
        })
      }
      if (result.failure) {
        await recordPrivacyGatewayAudit(this.audit, {
          action: 'privacy.transform.failed',
          tenantId: ctx.tenantId,
          scope,
          summary: summarizePrivacySpans(result.spans),
          mode,
          reason: `${result.failure.layer}:${result.failure.reason}`,
          ticketId: ctx.ticketId ?? null,
        })
      }
      return result.messages
    } catch (error) {
      if (error instanceof PrivacyTransformBlockedError) {
        try {
          await recordPrivacyGatewayAudit(this.audit, {
            action: 'privacy.transform.failed',
            tenantId: ctx.tenantId,
            scope,
            summary: { spanCount: 0, categories: [], byCategory: {} },
            mode,
            reason: `${error.layer}:${describePrivacyTransformFailure(error.cause ?? error)}`,
            ticketId: ctx.ticketId ?? null,
          })
        } catch {
          // A felhasználói fail-closed hiba maradjon az elsődleges akkor is, ha az audit DB is áll.
        }
      }
      throw error
    } finally {
      privacyTransformDurationMs.observe(Date.now() - started)
    }
  }

  /**
   * Sikertelen kísérlet naplója + tartalék döntés.
   * @returns `true` ha a hívó a következő jelölttel folytathat.
   */
  private async handleAttemptFailure(input: {
    error: unknown
    agentId: string
    agentVersion: number | null
    ticketId?: string
    conversationId?: string
    /** issue #180 WP-2 — a sikertelen kísérlet is a fordulót terheli (latency, retry). */
    agentTurnId?: string
    targetType: 'ticket' | 'conversation' | 'agent'
    targetId: string
    provider: ModelProvider
    model: string
    started: number
    attemptGroupId: string
    attemptIndex: number
    chain: FallbackCandidate[]
    /** Stream: csak az első token előtt `true`. */
    allowFallback: boolean
    stream?: boolean
    forcedLocal: boolean
    sensitivity: SensitivityDecision
    extraAuditMetadata?: Record<string, unknown>
  }): Promise<boolean> {
    if (
      input.error instanceof GatewayBudgetError ||
      input.error instanceof GatewaySensitivityError ||
      input.error instanceof PrivacyTransformBlockedError
    ) {
      throw input.error
    }

    const errorClass = classifyProviderError(input.error)
    const status = persistedStatusFromErrorClass(errorClass)
    const latencyMs = Date.now() - input.started
    const message = input.error instanceof Error ? input.error.message : String(input.error)
    const oauthResponse = chatGptOAuthDiagnostic(input.error)
    const next = input.chain[input.attemptIndex + 1]
    const willFallback = input.allowFallback && isFallbackEligible(errorClass) && !!next
    this.skipLedger.mark(input.provider.name, errorClass)

    await this.modelCalls.create({
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      ticketId: input.ticketId ?? null,
      conversationId: input.conversationId ?? null,
      agentTurnId: input.agentTurnId ?? null,
      provider: input.provider.name,
      model: input.model,
      promptTokens: 0,
      completionTokens: 0,
      // A hibaágon nincs usage, tehát cache-adat sincs — `null` = „nincs mérés",
      // nem „nem volt találat".
      cachedPromptTokens: null,
      costEstimate: new Prisma.Decimal(0),
      latencyMs,
      status,
    })

    modelCallsTotal.inc({ provider: input.provider.name, status })
    modelCallLatencyMs.observe(latencyMs, { provider: input.provider.name })

    if (errorClass === 'auth_error') {
      logger.error(
        {
          event: 'model.call.auth_fallback',
          provider: input.provider.name,
          model: input.model,
          status,
          latencyMs,
          agentId: input.agentId,
          ticketId: input.ticketId ?? null,
          error: message,
          attemptGroupId: input.attemptGroupId,
          attemptIndex: input.attemptIndex,
          willFallback,
          ...(input.stream ? { stream: true } : {}),
        },
        'model gateway AUTH error — fallback may hide a misconfiguration',
      )
    } else {
      logger.warn(
        {
          event: 'model.call',
          provider: input.provider.name,
          model: input.model,
          status,
          latencyMs,
          agentId: input.agentId,
          ticketId: input.ticketId ?? null,
          error: message,
          attemptGroupId: input.attemptGroupId,
          attemptIndex: input.attemptIndex,
          errorClass,
          ...(oauthResponse ? { oauthResponse } : {}),
          ...(input.stream ? { stream: true } : {}),
        },
        'model gateway call failed',
      )
    }

    await this.audit.append({
      actorType: 'agent',
      actorId: input.agentId,
      agentVersion: input.agentVersion,
      action: 'model.call',
      targetType: input.targetType,
      targetId: input.targetId,
      modelUsed: input.model,
      inputRef: 'error',
      outputRef: status,
      policyDecision: status,
      metadata: {
        latencyMs,
        status,
        error: message,
        errorClass,
        attemptGroupId: input.attemptGroupId,
        attemptIndex: input.attemptIndex,
        chainLength: input.chain.length,
        provider: input.provider.name,
        ...input.extraAuditMetadata,
      },
    })

    if (willFallback && next) {
      modelFallbackTotal.inc({
        from: input.provider.name,
        to: next.provider,
        reason: errorClass,
      })
      await this.audit.append({
        actorType: 'agent',
        actorId: input.agentId,
        agentVersion: input.agentVersion,
        action: 'model.call.fallback',
        targetType: input.targetType,
        targetId: input.targetId,
        modelUsed: next.model,
        inputRef: `${input.provider.name}/${input.model}`,
        outputRef: `${next.provider}/${next.model}`,
        policyDecision: errorClass,
        metadata: {
          attemptGroupId: input.attemptGroupId,
          attemptIndex: input.attemptIndex,
          chainLength: input.chain.length,
          fromProvider: input.provider.name,
          fromModel: input.model,
          toProvider: next.provider,
          toModel: next.model,
          reason: errorClass,
          error: message,
          ...(input.stream ? { stream: true } : {}),
        },
      })
      return true
    }

    if (input.forcedLocal) {
      throw this.localSensitivityError({
        sensitivity: input.sensitivity,
        provider: input.provider.name,
        model: input.model,
        providerError: message,
      })
    }

    throw input.error
  }

  private throwChainExhausted(input: {
    forcedLocal: boolean
    sensitivity: SensitivityDecision
    chain: FallbackCandidate[]
    resolvedConfig: ModelConfig
    lastError: unknown
  }): never {
    if (input.forcedLocal) {
      const last = input.chain[input.chain.length - 1]
      throw this.localSensitivityError({
        sensitivity: input.sensitivity,
        provider: last?.provider ?? input.resolvedConfig.provider,
        model: last?.model ?? input.resolvedConfig.model,
        providerError:
          input.lastError instanceof Error
            ? input.lastError.message
            : String(input.lastError ?? 'no candidates'),
      })
    }
    throw input.lastError instanceof Error
      ? input.lastError
      : new Error(String(input.lastError ?? 'fallback chain exhausted'))
  }

  async call(params: {
    agentId: string
    agentVersion?: number
    tenantId?: string
    ticketId?: string
    conversationId?: string
    /**
     * issue #180 WP-2 — a hívást kiváltó chat-forduló rekord azonosítója. Ez köti
     * a költséget a fordulóhoz: enélkül a per-forduló token-számot csak
     * időbélyeg-illesztéssel lehetett kikövetkeztetni. A ticket/task úton nincs
     * forduló-rekord, ott hiányzik.
     */
    agentTurnId?: string
    ticketType?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    /** Low-trust request-level model choice. Routing policy must explicitly allow it. */
    modelOverrideHint?: ModelOverrideHint
    /** Natív tool use definíciók — átadva a provider function callingot kér. */
    tools?: ToolDefinition[]
    /**
     * #33 — JSON Schema a válaszra; a provider kapja, ha támogatja a séma-kényszert.
     */
    responseJsonSchema?: Record<string, unknown>
    /** Explicit human review for narrowly scoped, audited sensitivity overrides. */
    sensitivityOverride?: SensitivityOverride
    /**
     * Chat "thinking-trace" spec — reasoning-summary delta oldalcsatorna. A hívó
     * (chat-tool-loop) tartalom-őrön (D5) engedi át, mielőtt a kliensre kerül.
     */
    onReasoningDelta?: (delta: string) => void
    /** Forduló-falióra — a folyamatban lévő provider-hívást is megszakítja. */
    signal?: AbortSignal
  }): Promise<{
    content: string
    toolCalls?: GatewayToolCall[]
    usage: { promptTokens: number; completionTokens: number }
    /** EUR becslés a háromrétegű tarifa-feloldásból. */
    costEstimate: number
    provider: string
    model: string
    /** Az elsődleges (routing utáni) jelölt helyett ténylegesen használt tartalék — csak fallback esetén. */
    fallbackRoute?: FallbackCandidate
  }> {
    const prep = await this.prepareModelCall(params)
    const {
      agentVersion,
      sensitivity,
      resolvedConfig,
      forcedLocal,
      chain,
      attemptGroupId,
      prompt,
      targetType,
      targetId,
    } = prep

    let lastError: unknown

    for (let attemptIndex = 0; attemptIndex < chain.length; attemptIndex++) {
      const candidate = chain[attemptIndex]!
      const provider = this.providers.get(candidate.provider)
      if (!provider) continue

      const model = candidate.model
      const attemptConfig: ModelConfig = {
        ...resolvedConfig,
        provider: candidate.provider,
        model,
      }
      const started = Date.now()

      try {
        const result = await withRetry(() =>
          provider.chat({
            agentId: params.agentId,
            ticketId: params.ticketId,
            messages: prep.messages,
            modelConfig: attemptConfig,
            tools: params.tools,
            responseJsonSchema: params.responseJsonSchema,
            onReasoningDelta: params.onReasoningDelta,
            signal: params.signal,
          }),
        )

        const content = result.content
        const promptTokens = result.usage?.promptTokens ?? Math.ceil(prompt.length / 4)
        const completionTokens = result.usage?.completionTokens ?? Math.ceil(content.length / 4)
        const usedModel = result.model || model
        const costEstimate = computeModelCostEur(
          usedModel,
          promptTokens,
          completionTokens,
          await this.loadPricing(),
        )

        // A cache-mérés a rekord ELŐTT fut: a `cached_prompt_tokens` oszlop
        // ugyanabból az egy forrásból töltődik, mint a metrika (issue #180 WP-2).
        const promptCache = recordPromptCacheUsage(provider.name, result.usage)
        await this.modelCalls.create({
          agentId: params.agentId,
          agentVersion,
          ticketId: params.ticketId ?? null,
          conversationId: params.conversationId ?? null,
          agentTurnId: params.agentTurnId ?? null,
          provider: provider.name,
          model: usedModel,
          promptTokens,
          completionTokens,
          cachedPromptTokens: promptCache.cachedPromptTokens ?? null,
          costEstimate: new Prisma.Decimal(costEstimate),
          latencyMs: result.latencyMs,
          status: 'ok',
        })

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
            ...promptCacheLogFields(promptCache),
            agentId: params.agentId,
            ticketId: params.ticketId ?? null,
            attemptGroupId,
            attemptIndex,
            chainLength: chain.length,
            ...(result.oauthConcurrency ? { oauthConcurrency: result.oauthConcurrency } : {}),
          },
          'model gateway call',
        )

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
            attemptGroupId,
            attemptIndex,
            chainLength: chain.length,
            provider: provider.name,
            ...promptCache,
          },
        })

        return {
          content,
          ...(result.toolCalls?.length ? { toolCalls: result.toolCalls } : {}),
          usage: { promptTokens, completionTokens },
          costEstimate,
          provider: provider.name,
          model: usedModel,
          ...(candidate.provider !== resolvedConfig.provider ||
          candidate.model !== (resolvedConfig.model || 'chatgpt-oauth-default')
            ? { fallbackRoute: { provider: candidate.provider, model: candidate.model } }
            : {}),
        }
      } catch (error: unknown) {
        if (isModelCallAborted(error) || params.signal?.aborted) {
          throw isModelCallAborted(error) ? error : new ModelCallAbortedError()
        }
        lastError = error
        const shouldContinue = await this.handleAttemptFailure({
          error,
          agentId: params.agentId,
          agentVersion,
          ticketId: params.ticketId,
          conversationId: params.conversationId,
          agentTurnId: params.agentTurnId,
          targetType,
          targetId,
          provider,
          model,
          started,
          attemptGroupId,
          attemptIndex,
          chain,
          allowFallback: true,
          forcedLocal,
          sensitivity,
        })
        if (shouldContinue) continue
      }
    }

    this.throwChainExhausted({
      forcedLocal,
      sensitivity,
      chain,
      resolvedConfig,
      lastError,
    })
  }

  async *callStream(params: {
    agentId: string
    agentVersion?: number
    tenantId?: string
    ticketId?: string
    conversationId?: string
    /** issue #180 WP-2 — a hívást kiváltó chat-forduló rekord azonosítója. */
    agentTurnId?: string
    ticketType?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    modelOverrideHint?: ModelOverrideHint
    sensitivityOverride?: SensitivityOverride
    /** Chat "thinking-trace" spec — reasoning-summary delta oldalcsatorna (tool nélküli ág). */
    onReasoningDelta?: (delta: string) => void
    signal?: AbortSignal
  }): AsyncGenerator<string, void, unknown> {
    const prep = await this.prepareModelCall(params)
    const {
      agentVersion,
      sensitivity,
      resolvedConfig,
      forcedLocal,
      chain,
      attemptGroupId,
      prompt,
      targetType,
      targetId,
    } = prep

    let lastError: unknown

    for (let attemptIndex = 0; attemptIndex < chain.length; attemptIndex++) {
      const candidate = chain[attemptIndex]!
      const provider = this.providers.get(candidate.provider)
      if (!provider) continue

      const model = candidate.model
      const attemptConfig: ModelConfig = {
        ...resolvedConfig,
        provider: candidate.provider,
        model,
      }
      const started = Date.now()
      let content = ''
      let streamUsage: ModelProviderUsage | undefined
      /** Az első kiírt token elkötelezi a jelöltet — utána nincs fallback. */
      let committed = false

      try {
        if (!provider.chatStream) {
          // Nem-streamelő provider: egyben hív, majd egy chunkként adja.
          const result = await withRetry(() =>
            provider.chat({
              agentId: params.agentId,
              ticketId: params.ticketId,
              messages: prep.messages,
              modelConfig: attemptConfig,
              onReasoningDelta: params.onReasoningDelta,
            }),
          )
          content = result.content
          committed = true
          const promptTokens = result.usage?.promptTokens ?? Math.ceil(prompt.length / 4)
          const completionTokens = result.usage?.completionTokens ?? Math.ceil(content.length / 4)
          const usedModel = result.model || model
          const costEstimate = computeModelCostEur(
            usedModel,
            promptTokens,
            completionTokens,
            await this.loadPricing(),
          )
          const promptCache = recordPromptCacheUsage(provider.name, result.usage)
          await this.modelCalls.create({
            agentId: params.agentId,
            agentVersion,
            ticketId: params.ticketId ?? null,
            conversationId: params.conversationId ?? null,
            agentTurnId: params.agentTurnId ?? null,
            provider: provider.name,
            model: usedModel,
            promptTokens,
            completionTokens,
            cachedPromptTokens: promptCache.cachedPromptTokens ?? null,
            costEstimate: new Prisma.Decimal(costEstimate),
            latencyMs: result.latencyMs,
            status: 'ok',
          })
          modelCallsTotal.inc({ provider: provider.name, status: 'ok' })
          modelCallLatencyMs.observe(result.latencyMs, { provider: provider.name })
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
              attemptGroupId,
              attemptIndex,
              chainLength: chain.length,
              ...promptCache,
            },
          })
          yield content
          return
        }

        for await (const chunk of provider.chatStream({
          agentId: params.agentId,
          ticketId: params.ticketId,
          messages: prep.messages,
          modelConfig: attemptConfig,
          onReasoningDelta: params.onReasoningDelta,
          signal: params.signal,
          onUsage: (usage) => {
            streamUsage = usage
          },
        })) {
          if (!committed) committed = true
          content += chunk
          yield chunk
        }

        const promptTokens = streamUsage?.promptTokens ?? Math.ceil(prompt.length / 4)
        const completionTokens = streamUsage?.completionTokens ?? Math.ceil(content.length / 4)
        const costEstimate = computeModelCostEur(
          model,
          promptTokens,
          completionTokens,
          await this.loadPricing(),
        )
        const streamLatencyMs = Date.now() - started

        const promptCache = recordPromptCacheUsage(provider.name, streamUsage)
        await this.modelCalls.create({
          agentId: params.agentId,
          agentVersion,
          ticketId: params.ticketId ?? null,
          conversationId: params.conversationId ?? null,
          agentTurnId: params.agentTurnId ?? null,
          provider: provider.name,
          model,
          promptTokens,
          completionTokens,
          cachedPromptTokens: promptCache.cachedPromptTokens ?? null,
          costEstimate: new Prisma.Decimal(costEstimate),
          latencyMs: streamLatencyMs,
          status: 'ok',
        })
        modelCallsTotal.inc({ provider: provider.name, status: 'ok' })
        modelCallLatencyMs.observe(streamLatencyMs, { provider: provider.name })
        logger.info(
          {
            event: 'model.call',
            provider: provider.name,
            model,
            status: 'ok',
            latencyMs: streamLatencyMs,
            costEstimate,
            promptTokens,
            completionTokens,
            ...promptCacheLogFields(promptCache),
            agentId: params.agentId,
            ticketId: params.ticketId ?? null,
            attemptGroupId,
            attemptIndex,
            chainLength: chain.length,
            stream: true,
          },
          'model gateway call',
        )

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
          metadata: {
            costEstimate,
            latencyMs: streamLatencyMs,
            status: 'ok',
            sensitivity: sensitivity.level,
            attemptGroupId,
            attemptIndex,
            chainLength: chain.length,
            ...promptCache,
          },
        })
        return
      } catch (error: unknown) {
        if (isModelCallAborted(error) || params.signal?.aborted) {
          throw isModelCallAborted(error) ? error : new ModelCallAbortedError()
        }
        lastError = error
        const shouldContinue = await this.handleAttemptFailure({
          error,
          agentId: params.agentId,
          agentVersion,
          ticketId: params.ticketId,
          conversationId: params.conversationId,
          agentTurnId: params.agentTurnId,
          targetType,
          targetId,
          provider,
          model,
          started,
          attemptGroupId,
          attemptIndex,
          chain,
          allowFallback: !committed,
          stream: true,
          forcedLocal,
          sensitivity,
          extraAuditMetadata: { committed },
        })
        if (shouldContinue) continue
      }
    }

    this.throwChainExhausted({
      forcedLocal,
      sensitivity,
      chain,
      resolvedConfig,
      lastError,
    })
  }
}
