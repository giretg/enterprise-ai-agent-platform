import { Prisma, type ModelCallStatus } from '@prisma/client'
import type { AuditRepository, ModelCallRepository } from '@/repositories/interfaces'

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
    }

    return {
      content: data.content ?? '',
      usage: data.usage,
      latencyMs: Date.now() - started,
    }
  }
}

export class ModelGateway {
  constructor(
    private audit: AuditRepository,
    private modelCalls: ModelCallRepository,
    private provider: ModelProvider = new ChatGptOAuthProvider(),
    private guardrail: GatewayGuardrail = { maxCallsPerTicket: 20 },
  ) {}

  async call(params: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    retryCount?: number
  }): Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> {
    if (params.modelConfig.provider !== this.provider.name) {
      throw new Error(`Unsupported model provider: ${params.modelConfig.provider}`)
    }

    const model = params.modelConfig.model || 'chatgpt-oauth-default'
    const prompt = params.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')

    // Guardrail (5.4): ticketenkénti hívás-keret — túllépve a Gateway nem hív.
    if (params.ticketId) {
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
      const result = await this.provider.chat({
        agentId: params.agentId,
        ticketId: params.ticketId,
        messages: params.messages,
        modelConfig: { ...params.modelConfig, model },
      })

      const content = result.content
      const promptTokens = result.usage?.promptTokens ?? Math.ceil(prompt.length / 4)
      const completionTokens = result.usage?.completionTokens ?? Math.ceil(content.length / 4)
      const costEstimate = 0

      await this.modelCalls.create({
        agentId: params.agentId,
        ticketId: params.ticketId ?? null,
        provider: this.provider.name,
        model,
        promptTokens,
        completionTokens,
        costEstimate: new Prisma.Decimal(costEstimate),
        latencyMs: result.latencyMs,
        status: 'ok',
      })

      await this.audit.append({
        actorType: 'agent',
        actorId: params.agentId,
        agentVersion: null,
        action: 'model.call',
        targetType: 'ticket',
        targetId: params.ticketId ?? null,
        modelUsed: model,
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
        provider: this.provider.name,
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
        agentVersion: null,
        action: 'model.call',
        targetType: 'ticket',
        targetId: params.ticketId ?? null,
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
