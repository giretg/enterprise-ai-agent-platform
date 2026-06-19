import { MODEL_PROVIDERS, normalizeModelForProvider, providerOption } from './model-providers'

export type AgentModelConfig = {
  provider: string
  model: string
}

export function parseAgentModelConfig(raw: unknown): AgentModelConfig {
  const cfg = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    provider?: string
    model?: string
  }
  const provider = cfg.provider?.trim() || 'chatgpt-oauth'
  const model = normalizeModelForProvider(
    provider,
    cfg.model?.trim() || providerOption(provider).defaultModel,
  )
  return { provider, model }
}

/** Provider default / harness sentinel — nem konkrét modell-azonosító. */
export function isProviderDefaultModel(model: string | undefined): boolean {
  const trimmed = model?.trim()
  if (!trimmed) return true
  return MODEL_PROVIDERS.some((p) => p.defaultModel === trimmed)
}

/** Gateway OpenAI-kompatibilis kérés: a harness sentinel helyett az agent modellje érvényesül. */
export function resolveGatewayRequestModel(
  requested: string | undefined,
  agentModel: string,
): string {
  if (isProviderDefaultModel(requested)) return agentModel
  return requested?.trim() || agentModel
}
