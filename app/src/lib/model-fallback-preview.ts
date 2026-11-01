import { buildEffectiveFallbackChain } from '@/domain/model-gateway/fallback-chain'
import type { ModelPolicy, ModelRef } from '@/lib/model-policy'

export type FallbackPreviewStep = { from: ModelRef; to: ModelRef }

/** Lánc-előnézet lépései — a UI fordítja: „Ha a {from} nem elérhető, ezt próbáljuk: {to}.” */
export function fallbackPreviewSteps(input: {
  primary: ModelRef | null
  agentFallbacks?: ModelRef[]
  globalFallbacks?: ModelRef[]
  policy: ModelPolicy
  maxAttempts: number
}): FallbackPreviewStep[] {
  const chain = buildEffectiveFallbackChain(input)
  return chain.slice(1).map((to, i) => ({ from: chain[i]!, to }))
}
