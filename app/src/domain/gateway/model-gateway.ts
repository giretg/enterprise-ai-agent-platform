import { Prisma, type ModelCallStatus } from '@prisma/client'
import type { AuditRepository, ModelCallRepository } from '@/repositories/interfaces'
import { callChatGptOAuth } from './chatgpt-oauth-bridge'
import { GeminiProvider } from './gemini-provider'
import { createTokenStoreFromEnv, ensureFreshTokens } from './oauth-token-store'

export type GatewayGuardrail = {
  /** Ticketenkénti modellhívás-plafon (5.4) — túllépve a Gateway nem hív. */
  maxCallsPerTicket: number
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

export type GatewayMessage = {
  role: 'user' | 'system'
  content: string
}

export type ModelProviderResult = {
  content: string
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
  }): Promise<ModelProviderResult>
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

  const combined = messages.map((m) => m.content).join('\n')
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

  const promptLength = messages.map((m) => m.content).join('\n').length
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
      })
      return {
        content: result.content,
        usage: result.usage,
        latencyMs: Date.now() - started,
        model: result.model,
      }
    }

    if (!providerUrl || !internalKey) {
      throw new Error('ChatGPT OAuth provider is not configured yet (S2 spike pending)')
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
      usage?: { promptTokens?: number; completionTokens?: number }
      model?: string
    }

    return {
      content: data.content ?? '',
      usage: data.usage,
      latencyMs: Date.now() - started,
      model: data.model,
    }
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
  ) {}

  async chat(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
  }): Promise<ModelProviderResult> {
    const baseUrl = (process.env[this.baseUrlEnvVar] || this.defaultBaseUrl)?.replace(/\/+$/, '')
    if (!baseUrl) {
      throw new Error(`${this.name} provider base URL not configured (${this.baseUrlEnvVar})`)
    }
    const apiKey = this.apiKeyEnvVar ? process.env[this.apiKeyEnvVar] : undefined

    const started = Date.now()
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: input.modelConfig.model,
        messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: input.modelConfig.temperature,
        max_tokens: input.modelConfig.maxTokens,
        stream: false,
      }),
    })

    if (!response.ok) {
      throw new Error(`${this.name} provider failed: ${response.status} ${(await response.text()).slice(0, 200)}`)
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
      model?: string
    }
    const content = data.choices?.[0]?.message?.content ?? ''
    if (!content.trim()) throw new Error(`${this.name} provider returned empty content`)

    return {
      content,
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
      },
      latencyMs: Date.now() - started,
      model: data.model,
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
  ]
  return new Map(providers.map((p) => [p.name, p]))
}

export class ModelGateway {
  constructor(
    private audit: AuditRepository,
    private modelCalls: ModelCallRepository,
    private providers: Map<string, ModelProvider> = createDefaultProviders(),
    private guardrail: GatewayGuardrail = { maxCallsPerTicket: 20 },
  ) {}

  async call(params: {
    agentId: string
    ticketId?: string
    conversationId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    retryCount?: number
  }): Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> {
    const provider = this.providers.get(params.modelConfig.provider)
    if (!provider) {
      throw new Error(
        `Unsupported model provider: ${params.modelConfig.provider} (ismert: ${[...this.providers.keys()].join(', ')})`,
      )
    }

    const model = params.modelConfig.model || 'chatgpt-oauth-default'
    const prompt = params.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')

    // Guardrail (5.4): ticketenkénti hívás-keret — túllépve a Gateway nem hív.
    if (params.ticketId && isUuid(params.ticketId)) {
      const usage = await this.modelCalls.getUsageForTicket(params.ticketId)
      if (usage.calls >= this.guardrail.maxCallsPerTicket) {
        await this.audit.append({
          actorType: 'agent',
          actorId: params.agentId,
          agentVersion: null,
          action: 'model.call.budget_blocked',
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

    const started = Date.now()
    try {
      const result = await provider.chat({
        agentId: params.agentId,
        ticketId: params.ticketId,
        messages: params.messages,
        modelConfig: { ...params.modelConfig, model },
      })

      const content = result.content
      const promptTokens = result.usage?.promptTokens ?? Math.ceil(prompt.length / 4)
      const completionTokens = result.usage?.completionTokens ?? Math.ceil(content.length / 4)
      const costEstimate = 0
      // A ténylegesen használt modellt naplózzuk (a provider feloldhatja a
      // sentinel modell-azonosítót, pl. `chatgpt-oauth-default` → `gpt-5.5`).
      const usedModel = result.model || model

      await this.modelCalls.create({
        agentId: params.agentId,
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

      const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
      const targetId = params.ticketId ?? params.conversationId ?? params.agentId

      await this.audit.append({
        actorType: 'agent',
        actorId: params.agentId,
        agentVersion: null,
        action: 'model.call',
        targetType,
        targetId,
        modelUsed: usedModel,
        inputRef: `tokens:${promptTokens}`,
        outputRef: `tokens:${completionTokens}`,
        policyDecision: 'allowed',
        metadata: { costEstimate, latencyMs: result.latencyMs, status: 'ok' },
      })

      return { content, usage: { promptTokens, completionTokens } }
    } catch (error: unknown) {
      const status = classifyError(error)
      const latencyMs = Date.now() - started
      const message = error instanceof Error ? error.message : String(error)

      // Hibás/rate-limited hívás is naplózódik (§4.7 status enum).
      await this.modelCalls.create({
        agentId: params.agentId,
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

      const targetType = params.ticketId ? 'ticket' : params.conversationId ? 'conversation' : 'agent'
      const targetId = params.ticketId ?? params.conversationId ?? params.agentId

      await this.audit.append({
        actorType: 'agent',
        actorId: params.agentId,
        agentVersion: null,
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
}
