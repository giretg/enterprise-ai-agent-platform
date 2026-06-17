// A create-agent és az agent-detail model-konfig űrlap közös provider-listája.
// A `value` a `modelConfig.provider`, amit a Model Gateway provider-regisztere ért.
export type ModelProviderOption = {
  value: string
  label: string
  defaultModel: string
  hint: string
}

export const MODEL_PROVIDERS: ModelProviderOption[] = [
  {
    value: 'chatgpt-oauth',
    label: 'ChatGPT OAuth (felhő)',
    defaultModel: 'chatgpt-oauth-default',
    hint: 'A Model Gateway szerveroldali ChatGPT OAuth mediációja (gpt-5.5).',
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
