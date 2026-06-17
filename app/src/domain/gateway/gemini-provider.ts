import { GoogleGenAI } from '@google/genai'
import type { GatewayMessage, ModelConfig, ModelProvider, ModelProviderResult } from './model-gateway'

function isGeminiStubConfigured(): boolean {
  return process.env.GEMINI_STUB === 'true'
}

function stubGeminiAnswer(messages: GatewayMessage[]): ModelProviderResult {
  const lastUser =
    [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() ?? ''
  const lower = lastUser.toLowerCase()

  let content =
    'Szia! Gemini stub módban vagyok — állítsd be a GEMINI_API_KEY-t valódi válaszokhoz.'
  if (lower.includes('szia') || lower.includes('hello') || lower === 'hi') {
    content = 'Szia! Gemini stub — a kulcs beállítása után éles modell válaszol.'
  } else if (lastUser) {
    content = `[Gemini stub] Megkaptam: „${lastUser.slice(0, 120)}”`
  }

  return {
    content,
    usage: { promptTokens: 32, completionTokens: Math.ceil(content.length / 4) },
    latencyMs: 1,
    model: 'gemini-stub',
  }
}

function buildGeminiRequest(messages: GatewayMessage[]) {
  const systemInstruction = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join('\n\n')

  const contents = messages
    .filter((m) => m.role === 'user')
    .map((m) => ({
      role: 'user' as const,
      parts: [{ text: m.content }],
    }))

  return {
    systemInstruction: systemInstruction || undefined,
    contents: contents.length > 0 ? contents : [{ role: 'user' as const, parts: [{ text: 'Hello' }] }],
  }
}

export class GeminiProvider implements ModelProvider {
  readonly name = 'gemini'
  private client: GoogleGenAI | null = null

  private getClient(): GoogleGenAI {
    const apiKey = process.env.GEMINI_API_KEY?.trim()
    if (!apiKey) {
      throw new Error('Gemini provider is not configured (GEMINI_API_KEY)')
    }
    if (!this.client) {
      this.client = new GoogleGenAI({ apiKey })
    }
    return this.client
  }

  async chat(input: {
    agentId: string
    ticketId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
  }): Promise<ModelProviderResult> {
    if (isGeminiStubConfigured()) {
      return stubGeminiAnswer(input.messages)
    }

    const started = Date.now()
    const ai = this.getClient()
    const { systemInstruction, contents } = buildGeminiRequest(input.messages)

    const response = await ai.models.generateContent({
      model: input.modelConfig.model,
      contents,
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(input.modelConfig.temperature != null ? { temperature: input.modelConfig.temperature } : {}),
        ...(input.modelConfig.maxTokens != null ? { maxOutputTokens: input.modelConfig.maxTokens } : {}),
      },
    })

    const content = response.text?.trim() ?? ''
    if (!content) {
      throw new Error('Gemini provider returned empty content')
    }

    return {
      content,
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount,
        completionTokens: response.usageMetadata?.candidatesTokenCount,
      },
      latencyMs: Date.now() - started,
      model: response.modelVersion ?? input.modelConfig.model,
    }
  }
}
