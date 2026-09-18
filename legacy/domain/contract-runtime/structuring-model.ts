/**
 * Platform-szintű „strukturáló” (olcsó formázó) modell (#33).
 * A javító hívások ezt használják; érzékeny tartalomnál a gateway a lépés
 * jóváhagyott modelljére eshet vissza.
 */
import { z } from 'zod'
import type { ModelConfig } from '@/domain/gateway/model-gateway'

export const STRUCTURING_MODEL_SETTING_KEY = 'model.structuring' as const

export const structuringModelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
})

export type StructuringModelSetting = z.infer<typeof structuringModelSchema>

export function parseStructuringModelSetting(raw: unknown): StructuringModelSetting | null {
  if (raw == null) return null
  const parsed = structuringModelSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Env fallback (teszt / bootstrap), ha nincs platform-beállítás. */
export function structuringModelFromEnv(
  env: Record<string, string | undefined> = process.env,
): StructuringModelSetting | null {
  const provider = env.STRUCTURING_MODEL_PROVIDER?.trim()
  const model = env.STRUCTURING_MODEL?.trim()
  if (!provider || !model) return null
  return { provider, model }
}

export function toStructuringModelConfig(
  setting: StructuringModelSetting | null,
  fallback: ModelConfig,
): ModelConfig {
  if (!setting) return { provider: fallback.provider, model: fallback.model }
  return { provider: setting.provider, model: setting.model }
}
