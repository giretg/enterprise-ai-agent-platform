/**
 * Tartalék-lánc feloldás és szűrés (Model Gateway kiesés-védelem).
 *
 * Effektív sorrend: elsődleges → agent tartalék → globális, majd kötelező szűrések.
 * Sem az agent futásidejű kérése, sem a beérkező request nem írhatja felül a listát —
 * csak adminisztrátori konfiguráció (platform-setting + agent modelConfig.fallbackModels).
 */

import { z } from 'zod'

export const FALLBACK_CHAIN_SETTING_KEY = 'model.fallback_chain' as const

/** Alap: max ennyi tényleges szolgáltató-hívás egy Gateway-híváson belül. */
export const DEFAULT_FALLBACK_MAX_ATTEMPTS = 3

export type FallbackCandidate = {
  provider: string
  model: string
}

export const fallbackCandidateSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
})

export const fallbackChainSettingSchema = z.array(fallbackCandidateSchema)

/** Belső hibaosztály — a perzisztált ModelCallStatus ettől függetlenül ok/error/rate_limited. */
export type FallbackErrorClass =
  | 'provider_unavailable'
  | 'rate_limited'
  | 'model_unavailable'
  | 'auth_error'
  | 'content_error'
  | 'other'

export function fallbackMaxAttemptsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.GATEWAY_FALLBACK_MAX_ATTEMPTS?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_FALLBACK_MAX_ATTEMPTS
}

export function parseFallbackChainSetting(raw: unknown): FallbackCandidate[] {
  if (raw == null) return []
  const parsed = fallbackChainSettingSchema.safeParse(raw)
  return parsed.success ? parsed.data : []
}

/** Agent modelConfig.fallbackModels — ismeretlen/rossz alak → üres lista. */
export function extractAgentFallbackModels(modelConfig: unknown): FallbackCandidate[] {
  if (!modelConfig || typeof modelConfig !== 'object' || Array.isArray(modelConfig)) return []
  const raw = (modelConfig as Record<string, unknown>).fallbackModels
  return parseFallbackChainSetting(raw)
}

export function classifyProviderError(error: unknown): FallbackErrorClass {
  const err = error instanceof Error ? error : null
  // Az időkorlát-üzenetek beleírják a beállított ezredmásodperc-értéket
  // ("... timed out after 240000ms"). Ez a szám nem hibakód, de a lentebbi
  // szövegmintákba beleeshet (240000 → "400" → content_error), és akkor egy
  // beragadt szolgáltatóra épp NEM indulna el a tartalék-lánc. Ezért a
  // besorolás előtt a puszta időtartamot kivesszük a szövegből.
  const message = (err?.message ?? String(error)).toLowerCase().replace(/\b\d+\s*ms\b/g, ' ')
  const name = (err?.name ?? '').toLowerCase()

  if (
    message.includes('401') ||
    message.includes('403') ||
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('invalid api key') ||
    message.includes('authentication')
  ) {
    return 'auth_error'
  }

  if (
    message.includes('429') ||
    message.includes('rate') ||
    message.includes('quota') ||
    message.includes('too many requests')
  ) {
    return 'rate_limited'
  }

  if (
    message.includes('400') ||
    message.includes('413') ||
    message.includes('context length') ||
    message.includes('too long') ||
    message.includes('invalid_request') ||
    message.includes('invalid request') ||
    message.includes('maximum context') ||
    message.includes('empty content')
  ) {
    return 'content_error'
  }

  if (
    message.includes('404') ||
    message.includes('model_not_found') ||
    message.includes('model not found') ||
    message.includes('does not exist') ||
    message.includes('unknown model') ||
    message.includes('unsupported model')
  ) {
    return 'model_unavailable'
  }

  // 5xx, network, timeout, fetch failed, AbortError → provider_unavailable
  if (
    name === 'aborterror' ||
    message.includes('aborted') ||
    message.includes('abort') ||
    message.includes('internal server error') ||
    message.includes('bad gateway') ||
    message.includes('service unavailable') ||
    message.includes('gateway timeout') ||
    /\b5\d\d\b/.test(message) ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('fetch failed') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('network') ||
    message.includes('socket') ||
    message.includes('provider failed')
  ) {
    return 'provider_unavailable'
  }

  // Ismeretlen hiba → nem vált (fail-closed a tartalékra)
  return 'other'
}

export function isFallbackEligible(errorClass: FallbackErrorClass): boolean {
  switch (errorClass) {
    case 'provider_unavailable':
    case 'rate_limited':
    case 'model_unavailable':
    case 'auth_error':
      return true
    case 'content_error':
    case 'other':
      return false
  }
}

/**
 * Összefűzi és szűri a láncot.
 * 1. ismeretlen provider kiesik
 * 2. érzékeny+helyi kényszer → csak helyi provider
 * 3. egymást követő azonos (provider+model) összevonás
 * 4. hossz korlát
 */
export function buildEffectiveFallbackChain(input: {
  primary: FallbackCandidate
  agentFallbacks?: FallbackCandidate[]
  globalFallbacks?: FallbackCandidate[]
  knownProviders: ReadonlySet<string> | Iterable<string>
  forcedLocal?: boolean
  localProvider?: string
  maxAttempts?: number
}): FallbackCandidate[] {
  const known =
    input.knownProviders instanceof Set
      ? input.knownProviders
      : new Set(input.knownProviders)
  const max = input.maxAttempts ?? DEFAULT_FALLBACK_MAX_ATTEMPTS

  const raw: FallbackCandidate[] = [
    input.primary,
    ...(input.agentFallbacks ?? []),
    ...(input.globalFallbacks ?? []),
  ]

  const filtered: FallbackCandidate[] = []
  for (const candidate of raw) {
    if (!known.has(candidate.provider)) continue
    if (input.forcedLocal && input.localProvider && candidate.provider !== input.localProvider) {
      continue
    }
    const prev = filtered[filtered.length - 1]
    if (prev && prev.provider === candidate.provider && prev.model === candidate.model) {
      continue
    }
    filtered.push(candidate)
    if (filtered.length >= max) break
  }

  return filtered
}
