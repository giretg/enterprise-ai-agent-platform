/**
 * Tartalék-lánc feloldás és hiba-osztályozás (#768, legacy: domain/gateway/fallback-chain.ts).
 *
 * Sorrend: elsődleges → agent tartalék → globális lánc, a tenant engedett listájára szűrve.
 * Csak admini konfig írhatja (agent.modelConfig.fallbackModels + platform `model.fallback_chain`);
 * a futásidejű kérés nem.
 */
import { isModelAllowed, modelRefKey, type ModelPolicy, type ModelRef } from '@/lib/model-policy'

export const FALLBACK_CHAIN_SETTING_KEY = 'model.fallback_chain' as const
export const DEFAULT_FALLBACK_MAX_ATTEMPTS = 3

export type FallbackErrorClass =
  | 'provider_unavailable'
  | 'rate_limited'
  | 'model_unavailable'
  | 'auth_error'
  | 'content_error'
  | 'blocked'
  | 'other'

/** Keret- vagy érzékenység/tartalom-blokk: a döntés szándékos, tartalékra váltva megkerülnénk. */
export class GatewayBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayBlockedError'
  }
}

export function fallbackMaxAttemptsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number.parseInt(env.GATEWAY_FALLBACK_MAX_ATTEMPTS?.trim() ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_FALLBACK_MAX_ATTEMPTS
}

const has = (text: string, ...needles: string[]) => needles.some((n) => text.includes(n))

export function classifyProviderError(error: unknown): FallbackErrorClass {
  if (error instanceof GatewayBlockedError || (error instanceof Error && error.name === 'GatewayBlockedError')) {
    return 'blocked'
  }
  const err = error instanceof Error ? error : null
  // "timed out after 240000ms": a puszta időtartam ne legyen státuszkód-találat.
  const message = (err?.message ?? String(error)).toLowerCase().replace(/\b\d+\s*ms\b/g, ' ')

  // A provider ezen a hoston nincs bekötve: másik jelölt kell, nem újrapróba.
  if (has(message, 'provider is not configured', 'provider nincs beállítva')) return 'provider_unavailable'
  if (/\b(401|403)\b/.test(message) || has(message, 'unauthorized', 'forbidden', 'invalid api key', 'authentication')) {
    return 'auth_error'
  }
  // Keret / költségkeret / provider-számla: szándékos limit, másik modellre váltva megkerülnénk.
  // OpenRouter gyakran 402 / "Insufficient credits" (nem "quota") — a "provider failed" catch-all
  // előtt kell elkapni, különben a tartalék lánc továbbkölt a következő fizetős modellre.
  if (
    /\b402\b/.test(message) ||
    has(
      message,
      'keret',
      'költségkeret',
      'budget',
      'spend limit',
      'quota',
      'insufficient_quota',
      'insufficient_credits',
      'insufficient credits',
      'payment required',
      'out of credits',
    )
  ) {
    return 'blocked'
  }
  if (/\b429\b/.test(message) || /\brate[ _-]?limit/.test(message) || has(message, 'too many requests')) {
    return 'rate_limited'
  }
  if (
    /\b(400|413)\b/.test(message) ||
    has(message, 'context length', 'too long', 'invalid_request', 'invalid request', 'maximum context', 'empty content')
  ) {
    return 'content_error'
  }
  if (
    /\b404\b/.test(message) ||
    has(message, 'model_not_found', 'model not found', 'does not exist', 'unknown model', 'unsupported model')
  ) {
    return 'model_unavailable'
  }
  if (
    err?.name.toLowerCase() === 'aborterror' ||
    /\b5\d\d\b/.test(message) ||
    has(
      message,
      'abort',
      'internal server error',
      'bad gateway',
      'service unavailable',
      'gateway timeout',
      'timed out',
      'timeout',
      'fetch failed',
      'econnrefused',
      'enotfound',
      'network',
      'socket',
      'provider failed',
    )
  ) {
    return 'provider_unavailable'
  }
  return 'other'
}

/** Csak a provider/modell oldali kiesés vált; keret, blokk, auth és tartalom-hiba nem. */
export function isFallbackEligible(errorClass: FallbackErrorClass): boolean {
  return (
    errorClass === 'provider_unavailable' ||
    errorClass === 'rate_limited' ||
    errorClass === 'model_unavailable'
  )
}

/** Streamnél az első token kiküldése után már nem válthatunk (a kliens félmondatot kapott). */
export function shouldFallback(input: { error: unknown; firstTokenEmitted: boolean }): boolean {
  return !input.firstTokenEmitted && isFallbackEligible(classifyProviderError(input.error))
}

/**
 * Összefűzi a láncot: engedett lista szerinti szűrés (nem engedett elsődleges is kiesik),
 * duplikátum-kiszűrés (első előfordulás marad), max kísérletszám.
 */
export function buildEffectiveFallbackChain(input: {
  primary: ModelRef | null
  agentFallbacks?: ModelRef[]
  globalFallbacks?: ModelRef[]
  policy: ModelPolicy
  maxAttempts?: number
}): ModelRef[] {
  const max = input.maxAttempts ?? DEFAULT_FALLBACK_MAX_ATTEMPTS
  const seen = new Set<string>()
  const chain: ModelRef[] = []
  const raw = [
    ...(input.primary ? [input.primary] : []),
    ...(input.agentFallbacks ?? []),
    ...(input.globalFallbacks ?? []),
  ]
  for (const candidate of raw) {
    const key = modelRefKey(candidate)
    if (seen.has(key) || !isModelAllowed(input.policy, candidate)) continue
    seen.add(key)
    chain.push(candidate)
    if (chain.length >= max) break
  }
  return chain
}
