import { buildEffectiveFallbackChain } from '@/domain/model-gateway/fallback-chain'
import { modelDisplayName, type ModelPolicy, type ModelRef } from '@/lib/model-policy'

/** „Ha a GPT-x nem elérhető, ezt próbáljuk: …" — az űrlap és a globális panel közös előnézete. */
export function fallbackPreviewLines(input: {
  primary: ModelRef | null
  agentFallbacks?: ModelRef[]
  globalFallbacks?: ModelRef[]
  policy: ModelPolicy
  maxAttempts: number
}): string[] {
  const chain = buildEffectiveFallbackChain(input)
  return chain.slice(1).map((next, i) => {
    const from = chain[i]!
    return `Ha a ${modelDisplayName(from)} nem elérhető, ezt próbáljuk: ${modelDisplayName(next)}.`
  })
}
