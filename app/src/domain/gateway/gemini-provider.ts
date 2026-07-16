import { GoogleGenAI } from '@google/genai'
import type {
  GatewayMessage,
  GatewayToolCall,
  ModelConfig,
  ModelProvider,
  ModelProviderResult,
  ToolDefinition,
} from './model-gateway'

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

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }
type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

function buildGeminiRequest(messages: GatewayMessage[]) {
  const systemInstruction = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join('\n\n')

  const contents: GeminiContent[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] })
      continue
    }
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = []
      if (m.content?.trim()) parts.push({ text: m.content })
      for (const call of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.input ?? {} } })
      }
      if (parts.length) contents.push({ role: 'model', parts })
      continue
    }
    // tool eredmény → functionResponse part (Gemini user-szerepként várja)
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name: m.toolName, response: { result: m.content } } }],
    })
  }

  return {
    systemInstruction: systemInstruction || undefined,
    contents: contents.length > 0 ? contents : [{ role: 'user' as const, parts: [{ text: 'Hello' }] }],
  }
}

/**
 * A "thinking-trace" (WP-8) thought-részeit szedi ki a Gemini válaszból. A
 * `thinkingConfig.includeThoughts:true` esetén a modell külön, `thought:true`
 * jelölésű text-partokat ad vissza (thought summary); ezeket összefűzzük. A
 * `response.text` már eleve KIZÁRJA ezeket, így a végső válasz tiszta marad.
 */
export function extractGeminiThoughtText(response: {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
}): string {
  const parts = response.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((p) => p.thought === true && typeof p.text === 'string')
    .map((p) => p.text ?? '')
    .join('')
    .trim()
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
    tools?: ToolDefinition[]
    onReasoningDelta?: (delta: string) => void
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
        // Chat "thinking-trace" (WP-8): thought summary bekérése csak akkor, ha a
        // hívó kért reasoning-et (a runtime a tenant D7-kapcsolójától teszi függővé).
        // A `thinkingBudget:-1` dinamikus keret — a modell dönt a gondolkodás mélységéről.
        ...(input.onReasoningDelta
          ? { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } }
          : {}),
        ...(input.tools?.length
          ? {
              tools: [
                {
                  functionDeclarations: input.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema,
                  })),
                },
              ],
            }
          : {}),
      },
    })

    const toolCalls: GatewayToolCall[] = (response.functionCalls ?? []).map((fc, index) => ({
      id: fc.id || `call_${index}`,
      name: fc.name ?? '',
      input: (fc.args as Record<string, unknown> | undefined) ?? {},
    }))

    const content = response.text?.trim() ?? ''
    // Tool-only válasznál a content üres — csak akkor hiba, ha sem szöveg, sem
    // tool hívás nem jött vissza.
    if (!content && toolCalls.length === 0) {
      throw new Error('Gemini provider returned empty content')
    }

    // Chat "thinking-trace" (WP-8): a thought summary egyetlen deltaként (a
    // generateContent nem streamel). A tartalom-őr (D5) a hívó oldalán fut.
    if (input.onReasoningDelta) {
      const thought = extractGeminiThoughtText(response)
      if (thought) input.onReasoningDelta(thought)
    }

    return {
      content,
      ...(toolCalls.length ? { toolCalls } : {}),
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount,
        completionTokens: response.usageMetadata?.candidatesTokenCount,
      },
      latencyMs: Date.now() - started,
      model: response.modelVersion ?? input.modelConfig.model,
    }
  }
}
