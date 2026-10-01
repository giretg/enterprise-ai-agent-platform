import { z } from 'zod'
import { MODEL_PROVIDER_IDS } from '@/lib/model-providers'
import { parseModelRefs, sameModel, type ModelPolicy, type ModelRef } from '@/lib/model-policy'

export const MAX_FALLBACK_MODELS = 5

export const modelRefSchema = z.object({
  provider: z.enum(MODEL_PROVIDER_IDS),
  model: z.string().trim().min(1).max(200),
})

/** `Agent.modelConfig` (#768). Nem kerül az MCP-snapshotba. */
export const agentModelConfigSchema = modelRefSchema.extend({
  modelType: z.enum(['luna', 'terra', 'sol']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
  fallbackModels: z.array(modelRefSchema).max(MAX_FALLBACK_MODELS).default([]),
})

export type AgentModelConfig = z.infer<typeof agentModelConfigSchema>

/** A tárolt JSON olvasása: hibás/hiányzó → null (a hívó az alapértékre esik vissza). */
export function parseAgentModelConfig(raw: unknown): AgentModelConfig | null {
  const parsed = agentModelConfigSchema.safeParse(raw)
  if (!parsed.success) return null
  return { ...parsed.data, fallbackModels: parseModelRefs(parsed.data.fallbackModels) }
}

/**
 * Az agent tényleges elsődleges modellje: a beállított, ha van; különben a tenant engedett
 * listájának első modellje (nincs legacy forrás a backfillhez, ezért ez az alapérték).
 */
export function resolveAgentPrimary(raw: unknown, policy: ModelPolicy): ModelRef | null {
  const config = parseAgentModelConfig(raw)
  if (config) return { provider: config.provider, model: config.model }
  return policy.enabled[0] ?? null
}

/** Mentés előtti tisztítás: a tartalék nem lehet maga az elsődleges, duplikátum nélkül. */
export function normalizeModelConfig(config: AgentModelConfig): AgentModelConfig {
  const fallbacks = parseModelRefs(config.fallbackModels).filter((f) => !sameModel(f, config))
  return { ...config, fallbackModels: fallbacks }
}
