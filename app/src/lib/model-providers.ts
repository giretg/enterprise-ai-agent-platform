// A create-agent és az agent-detail model-konfig űrlap közös provider-listája.
// A `value` a `modelConfig.provider`, amit a Model Gateway provider-regisztere ért.
export type ModelOption = {
  id: string
  label: string
  description?: string
}

export type ModelProviderOption = {
  value: string
  label: string
  defaultModel: string
  hint: string
  /** Ha megadva, a UI legördülőből választ; különben szabad szöveg. */
  models?: ModelOption[]
}

/** Szöveges generálásra ajánlott Gemini modellek (ai.google.dev, 2026-06). */
export const GEMINI_TEXT_MODELS: ModelOption[] = [
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    description: 'Stabil, gyors — agentic és kódolási feladatok',
  },
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro Preview',
    description: 'Összetett érvelés, kutatás, agentic feladatok',
  },
  {
    id: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash Preview',
    description: 'Frontier teljesítmény alacsonyabb költséggel',
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite',
    description: 'Gyors, költséghatékony multimodális',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    description: 'Mély érvelés és komplex feladatok',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description: 'Alacsony késleltetés, nagy volumen',
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite',
    description: 'Leggyorsabb és legolcsóbb a 2.5 családból',
  },
]

export const MODEL_PROVIDERS: ModelProviderOption[] = [
  {
    value: 'chatgpt-oauth',
    label: 'ChatGPT OAuth (felhő)',
    defaultModel: 'chatgpt-oauth-default',
    hint: 'A Model Gateway szerveroldali ChatGPT OAuth mediációja (gpt-5.5).',
  },
  {
    value: 'gemini',
    label: 'Google Gemini API',
    defaultModel: 'gemini-3.5-flash',
    hint: 'Google AI Studio API kulcs a szerveren (GEMINI_API_KEY). A modell a legördülőből választható.',
    models: GEMINI_TEXT_MODELS,
  },
  {
    value: 'ollama',
    label: 'Helyi Gemma (Ollama)',
    defaultModel: 'gemma-local',
    hint: 'Helyben futó modell az Ollama OpenAI-kompatibilis API-ján (OLLAMA_BASE_URL).',
  },
]

export function providerOption(value: string): ModelProviderOption {
  return MODEL_PROVIDERS.find((p) => p.value === value) ?? MODEL_PROVIDERS[0]
}

export function providerModelOptions(value: string): ModelOption[] {
  return providerOption(value).models ?? []
}

export function modelLabel(provider: string, modelId: string): string {
  const found = providerModelOptions(provider).find((m) => m.id === modelId)
  return found?.label ?? modelId
}

export function normalizeModelForProvider(provider: string, model: string): string {
  const option = providerOption(provider)
  const trimmed = model.trim()
  if (!trimmed) return option.defaultModel
  const known = providerModelOptions(provider)
  if (known.length === 0) return trimmed
  return known.some((m) => m.id === trimmed) ? trimmed : option.defaultModel
}
