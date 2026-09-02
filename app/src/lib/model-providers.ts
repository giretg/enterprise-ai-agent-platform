// A create-agent és az agent-detail model-konfig űrlap közös provider-listája.
// A `value` a `modelConfig.provider`, amit a Model Gateway provider-regisztere ért.
export type ModelOption = {
  id: string
  label: string
  description?: string
}

/** Ortogonális gondolkodási profil (Cursor-féle luna/terra/sol) — a modell ID mellett. */
export type ModelType = 'luna' | 'terra' | 'sol'

export const MODEL_TYPES: Array<{
  id: ModelType
  label: string
  description: string
}> = [
  {
    id: 'luna',
    label: 'Luna',
    description: 'Gyors, könnyű gondolkodás — rutin feladatokhoz.',
  },
  {
    id: 'terra',
    label: 'Terra',
    description: 'Kiegyensúlyozott — a legtöbb agent munkához.',
  },
  {
    id: 'sol',
    label: 'Sol',
    description: 'Mély gondolkodás — összetett, több lépéses feladatokhoz.',
  },
]

export const DEFAULT_MODEL_TYPE: ModelType = 'terra'

export function isModelType(value: unknown): value is ModelType {
  return value === 'luna' || value === 'terra' || value === 'sol'
}

export function modelTypeLabel(modelType: string | undefined): string | null {
  if (!modelType) return null
  return MODEL_TYPES.find((t) => t.id === modelType)?.label ?? modelType
}

export type ModelProviderOption = {
  value: string
  label: string
  defaultModel: string
  hint: string
  /** Ha megadva, a UI legördülőből választ; különben szabad szöveg. */
  models?: ModelOption[]
  /**
   * Luna/Terra/Sol a provider reasoning/thinking paraméterére megy.
   * OpenRouter / Gemini / Ollama: no-op — a UI elrejti a mezőt.
   */
  thinkingProfile?: boolean
}

export const CHATGPT_OAUTH_MODELS: ModelOption[] = [
  {
    id: 'chatgpt-oauth-default',
    label: 'ChatGPT OAuth default',
    description: 'A szerveroldali ChatGPT OAuth adapter alapértelmezett modellje.',
  },
]

/** Claude Code előfizetés (Pro/Max) — `claude auth login`, nem API-kulcs. */
export const CLAUDE_CODE_OAUTH_MODELS: ModelOption[] = [
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    description: 'Claude Code előfizetés — kiegyensúlyozott agent-munkához.',
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    description: 'Claude Code előfizetés — mélyebb érvelés, összetett feladatok.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    description: 'Claude Code előfizetés — gyors, olcsóbb kvótájú modell.',
  },
]

/** Grok CLI előfizetés (SuperGrok / X Premium+) — `grok login`, nem xAI API-kulcs. */
export const GROK_CLI_OAUTH_MODELS: ModelOption[] = [
  {
    id: 'grok-4.6',
    label: 'Grok 4.6',
    description: 'Grok CLI előfizetés — flagship, 500K context, reasoning.',
  },
  {
    id: 'grok-4.5',
    label: 'Grok 4.5',
    description: 'Grok CLI előfizetés — előző flagship, ha a fiók arra van jogosítva.',
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
  {
    id: 'deepseek/deepseek-v4-flash-0731',
    label: 'DeepSeek V4 Flash',
    description: 'DeepSeek gyors kísérleti modell (0731) — alacsony latency, OpenRouteren át.',
  },
]

export const MODEL_PROVIDER_IDS = [
  'chatgpt-oauth',
  'claude-code-oauth',
  'grok-cli-oauth',
  'gemini',
  'ollama',
  'openrouter',
] as const

export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number]

export const MODEL_PROVIDERS: ModelProviderOption[] = [
  {
    value: 'chatgpt-oauth',
    label: 'ChatGPT OAuth (felhő)',
    defaultModel: 'chatgpt-oauth-default',
    hint: 'A Model Gateway szerveroldali ChatGPT OAuth mediációja (gpt-5.5). Codex CLI belépés: ~/.codex/auth.json.',
    models: CHATGPT_OAUTH_MODELS,
    thinkingProfile: true,
  },
  {
    value: 'claude-code-oauth',
    label: 'Claude Code OAuth (előfizetés)',
    defaultModel: 'claude-sonnet-4-6',
    hint: 'Claude Pro/Max előfizetés a Claude Code CLI belépésével (`claude auth login` vagy `claude setup-token`). Nem API-kulcs.',
    models: CLAUDE_CODE_OAUTH_MODELS,
    thinkingProfile: true,
  },
  {
    value: 'grok-cli-oauth',
    label: 'Grok CLI OAuth (előfizetés)',
    defaultModel: 'grok-4.6',
    hint: 'SuperGrok / X Premium+ a Grok CLI belépésével (`grok login`). Token: ~/.grok/auth.json. Nem xAI API-kulcs.',
    models: GROK_CLI_OAUTH_MODELS,
    thinkingProfile: true,
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

/** Luna/Terra/Sol csak ott jelenik meg, ahol a gateway ténylegesen alkalmazza. */
export function providerUsesThinkingProfile(provider: string): boolean {
  return MODEL_PROVIDERS.find((p) => p.value === provider)?.thinkingProfile === true
}

export function providerModelOptions(
  value: string,
  providers: ModelProviderOption[] = MODEL_PROVIDERS,
): ModelOption[] {
  return providerOption(value, providers).models ?? []
}

export function modelLabel(
  provider: string,
  modelId: string,
  providers: ModelProviderOption[] = MODEL_PROVIDERS,
): string {
  const found = providerModelOptions(provider, providers).find((m) => m.id === modelId)
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
