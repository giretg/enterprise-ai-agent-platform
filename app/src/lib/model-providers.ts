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

export const CHATGPT_OAUTH_MODELS: ModelOption[] = [
  {
    id: 'chatgpt-oauth-default',
    label: 'ChatGPT OAuth default',
    description: 'A szerveroldali ChatGPT OAuth adapter alapértelmezett modellje.',
  },
]

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

/** Helyi Ollama modellek — az `id` megegyezik az `ollama list` névvel. */
export const OLLAMA_TEXT_MODELS: ModelOption[] = [
  {
    id: 'gemma-local',
    label: 'Gemma 4 E4B (unsloth Q4_K_M)',
    description: 'Goose-ből importált unsloth/gemma-4-E4B-it-GGUF — szöveg-only, Ollama alias: gemma-local',
  },
]

/** OpenRouteren keresztül kísérletezésre felvehető modellek. Egyedi slug adminból adható hozzá. */
export const OPENROUTER_TEXT_MODELS: ModelOption[] = [
  {
    id: '~openai/gpt-latest',
    label: 'OpenAI GPT latest',
    description: 'OpenRouter latest alias — gyors kísérleti baseline.',
  },
  {
    id: 'x-ai/grok-4.5',
    label: 'Grok 4.5',
    description: 'xAI frontier modell — kódolás, agentic feladatok, STEM (500K context).',
  },
]

export const MODEL_PROVIDERS: ModelProviderOption[] = [
  {
    value: 'chatgpt-oauth',
    label: 'ChatGPT OAuth (felhő)',
    defaultModel: 'chatgpt-oauth-default',
    hint: 'A Model Gateway szerveroldali ChatGPT OAuth mediációja (gpt-5.5).',
    models: CHATGPT_OAUTH_MODELS,
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
    hint: 'Ollama fut (ollama serve / Ollama app). Modell: gemma-local (Goose GGUF import). OLLAMA_BASE_URL opcionális.',
    models: OLLAMA_TEXT_MODELS,
  },
  {
    value: 'openrouter',
    label: 'OpenRouter (kísérleti)',
    defaultModel: '~openai/gpt-latest',
    hint: 'OpenAI-kompatibilis OpenRouter API (OPENROUTER_API_KEY). Modellek csak admin allowlist után választhatók agenthez.',
    models: OPENROUTER_TEXT_MODELS,
  },
]

export function providerOption(
  value: string,
  providers: ModelProviderOption[] = MODEL_PROVIDERS,
): ModelProviderOption {
  return providers.find((p) => p.value === value) ?? MODEL_PROVIDERS.find((p) => p.value === value) ?? providers[0] ?? MODEL_PROVIDERS[0]
}

export function providerModelOptions(
  value: string,
  providers: ModelProviderOption[] = MODEL_PROVIDERS,
): ModelOption[] {
  return providerOption(value, providers).models ?? []
}

export function modelLabel(provider: string, modelId: string): string {
  const found = providerModelOptions(provider).find((m) => m.id === modelId)
  return found?.label ?? modelId
}

export function normalizeModelForProvider(
  provider: string,
  model: string,
  providers: ModelProviderOption[] = MODEL_PROVIDERS,
): string {
  const option = providerOption(provider, providers)
  const trimmed = model.trim()
  if (!trimmed) return option.defaultModel
  const known = providerModelOptions(provider, providers)
  if (known.length === 0) return trimmed
  return known.some((m) => m.id === trimmed) ? trimmed : option.defaultModel
}
