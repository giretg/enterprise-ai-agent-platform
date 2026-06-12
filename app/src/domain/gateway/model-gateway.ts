import { GoogleGenAI } from '@google/genai'
import { Prisma } from '@prisma/client'
import type { AuditRepository, ModelCallRepository } from '@/repositories/interfaces'

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

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000

// Rough EUR estimates per 1M tokens (dev placeholder)
const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash-lite': { input: 0.08, output: 0.3 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6 },
  'gemini-2.5-pro': { input: 1.25, output: 5.0 },
}

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const rates = COST_PER_MILLION[model] ?? { input: 0.2, output: 0.8 }
  return (
    (promptTokens / 1_000_000) * rates.input + (completionTokens / 1_000_000) * rates.output
  )
}

export class ModelGateway {
  constructor(
    private audit: AuditRepository,
    private modelCalls: ModelCallRepository,
  ) {}

  async call(params: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    retryCount?: number
  }): Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured')
    }

    const retryCount = params.retryCount ?? 0
    const model = params.modelConfig.model || 'gemini-2.5-flash-lite'
    const prompt = params.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')

    try {
      const genAI = new GoogleGenAI({ apiKey })
      const result = await genAI.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      })

      const content = result.text ?? ''
      const usageMetadata = result.usageMetadata
      const promptTokens = usageMetadata?.promptTokenCount ?? Math.ceil(prompt.length / 4)
      const completionTokens =
        usageMetadata?.candidatesTokenCount ?? Math.ceil(content.length / 4)
      const costEstimate = estimateCost(model, promptTokens, completionTokens)

      await this.modelCalls.create({
        agentId: params.agentId,
        ticketId: params.ticketId ?? null,
        provider: params.modelConfig.provider || 'google',
        model,
        promptTokens,
        completionTokens,
        costEstimate: new Prisma.Decimal(costEstimate),
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
        policyDecision: 'n/a',
        prevHash: null,
        hash: null,
        metadata: { costEstimate },
      })

      return { content, usage: { promptTokens, completionTokens } }
    } catch (error: unknown) {
      const err = error as { status?: number; error?: { code?: number; status?: string } }
      const code = err?.status ?? err?.error?.code
      const status = err?.error?.status
      const retryable =
        code === 429 ||
        code === 503 ||
        status === 'RESOURCE_EXHAUSTED' ||
        status === 'UNAVAILABLE'
      if (retryable && retryCount < MAX_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS * (retryCount + 1)),
        )
        return this.call({ ...params, retryCount: retryCount + 1 })
      }
      throw error
    }
  }
}
