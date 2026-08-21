import {
  findEmbeddedSurrogates,
  type EmbeddedSurrogate,
} from '@/domain/privacy/surrogate-format'

/**
 * Prompt-cache — a stabil prefix cache-határának (`cache_control`) kezelése.
 *
 * A prefix-sorrend spec (Prompt-Cache-Prefix-Ordering) elérte, hogy a stabil,
 * agent-szintű blokkok megszakítás nélkül a prompt elején álljanak, de a
 * határt semmi nem jelölte meg: az implicit (automatikus) prefix-cache-t
 * kínáló providereknél ez elég, az Anthropic-stílusú **explicit** breakpointot
 * váró providereknél (OpenRouter → Anthropic modellek) viszont a cache
 * egyáltalán nem lépett életbe. Üzletileg: a nagy, soha nem változó blokkok
 * (tool-sémák, agent system prompt, connector-katalógus) minden fordulóban
 * teljes áron mentek ki.
 *
 * A megoldás két lépcsős:
 *  1. a prompt-assembler **megjelöli** a stabil zóna utolsó üzenetét
 *     (`cacheBoundary`), tartalom-változtatás nélkül,
 *  2. a Gateway a providerhez menet **lefordítja** ezt a jelölést a provider
 *     saját cache-API-jára (itt: `cache_control: { type: 'ephemeral' }`).
 *
 * Ez a modul a 2. lépcső providerfüggetlen, I/O-mentes politikája.
 */

/**
 * Kérésenkénti breakpoint-plafon (Anthropic korlát: max 4 `cache_control`).
 * Több jelölésnél a leghosszabb prefixeket tartjuk meg.
 */
export const MAX_CACHE_BREAKPOINTS = 4

/**
 * Ennél rövidebb prefixet nem jelölünk meg. A providerek minimum-hossz alatt
 * csendben nem cache-elnek (nincs hiba, csak nincs találat), a jelölés viszont
 * cache-írási felárat vonhat maga után — ezért a rövid promptot békén hagyjuk.
 */
export const DEFAULT_CACHE_MIN_PREFIX_TOKENS = 1024

/** Csak ezeken a szerepeken van értelme (és biztonságos) a határ. */
const CACHE_BOUNDARY_ROLES = new Set(['system', 'user'])

export type PromptCacheTtl = '5m' | '1h'

export type PromptCachePolicy = {
  /** Kikapcsolva a gateway sosem küld `cache_control`-t. */
  enabled: boolean
  /** Becsült prefix-token minimum a jelöléshez. */
  minPrefixTokens: number
  ttl: PromptCacheTtl
}

/** A providernek küldött cache-jelölés (Anthropic-kompatibilis alak). */
export type CacheControlPayload = { type: 'ephemeral'; ttl?: '1h' }

/**
 * A gateway által ténylegesen látott üzenet minimális alakja. Szándékosan
 * strukturális típus (nem a `GatewayMessage` import), hogy ez a modul a
 * model-gateway-től függetlenül tesztelhető maradjon.
 */
export type CacheBoundaryCandidate = {
  role: string
  content?: string
  cacheBoundary?: boolean
}

/**
 * Politika env-ből:
 * - `GATEWAY_PROMPT_CACHE=off|false|0` → teljes kikapcsolás (kill switch),
 * - `GATEWAY_PROMPT_CACHE_MIN_TOKENS` → minimum prefix-hossz,
 * - `GATEWAY_PROMPT_CACHE_TTL=1h` → hosszú TTL (drágább írás, ritkább forgalomhoz).
 */
export function promptCachePolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): PromptCachePolicy {
  const raw = env.GATEWAY_PROMPT_CACHE?.trim().toLowerCase()
  const enabled = !(raw === 'off' || raw === 'false' || raw === '0')

  const rawMin = env.GATEWAY_PROMPT_CACHE_MIN_TOKENS?.trim()
  const parsedMin = rawMin ? Number.parseInt(rawMin, 10) : NaN
  const minPrefixTokens =
    Number.isInteger(parsedMin) && parsedMin >= 0 ? parsedMin : DEFAULT_CACHE_MIN_PREFIX_TOKENS

  const ttl: PromptCacheTtl = env.GATEWAY_PROMPT_CACHE_TTL?.trim() === '1h' ? '1h' : '5m'
  return { enabled, minPrefixTokens, ttl }
}

/** ~4 karakter/token — ugyanaz a heurisztika, mint a gateway token-fallbackje. */
export function estimatePromptTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/** APG-15 / R7: conversation-scoped álnév a megosztott, cache-elt prefixben. */
export class CachedPrefixSurrogateInvariantError extends Error {
  readonly surrogates: readonly string[]

  constructor(surrogates: readonly string[]) {
    super(
      `A cache-elt prefix nem tartalmazhat álnevet (APG-15): ${[...new Set(surrogates)].join(', ')}`,
    )
    this.name = 'CachedPrefixSurrogateInvariantError'
    this.surrogates = surrogates
  }
}

/**
 * A cache-breakpoint(ok) által lefedett prefix szövegében talált típusos álnevek.
 * Üres breakpoint-lista esetén nincs explicit cache-határ → nincs ellenőrzendő szegmens.
 */
export function findSurrogatesInCachedPrefix(
  messages: readonly CacheBoundaryCandidate[],
  breakpoints: readonly number[],
): EmbeddedSurrogate[] {
  if (breakpoints.length === 0) return []
  const endIndex = Math.max(...breakpoints)
  let prefixText = ''
  for (let index = 0; index <= endIndex; index++) {
    const content = messages[index]?.content
    if (typeof content === 'string') prefixText += content
  }
  return findEmbeddedSurrogates(prefixText).filter((match) => match.parsed != null)
}

/** APG-15: a cache-elt prefixben nincs `[[TYPE_N]]` álnév — red-line invariáns. */
export function assertCachedPrefixSurrogateInvariant(
  messages: readonly CacheBoundaryCandidate[],
  breakpoints: readonly number[],
): void {
  const matches = findSurrogatesInCachedPrefix(messages, breakpoints)
  if (matches.length === 0) return
  throw new CachedPrefixSurrogateInvariantError(matches.map((match) => match.text))
}

/**
 * Megadja, mely üzenet-indexekre kerüljön `cache_control`. Csak megjelölt
 * (`cacheBoundary`), nem üres system/user üzenet jöhet szóba, és csak ha az
 * addigi prefix elér egy értelmes hosszt. A tool-sémák (külön top-level mező)
 * a providernél a prefix elején állnak — a becslés ezért konzervatív, azaz
 * inkább kihagy, mint fölöslegesen írjon cache-t.
 */
export function resolveCacheBreakpoints(
  messages: readonly CacheBoundaryCandidate[],
  policy: PromptCachePolicy,
): number[] {
  if (!policy.enabled) return []

  const breakpoints: number[] = []
  let prefixChars = 0
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    prefixChars += message.content?.length ?? 0
    if (!message.cacheBoundary) continue
    if (!CACHE_BOUNDARY_ROLES.has(message.role)) continue
    if (typeof message.content !== 'string' || !message.content.trim()) continue
    if (estimatePromptTokens(prefixChars) < policy.minPrefixTokens) continue
    breakpoints.push(index)
  }

  // Plafon fölött a leghosszabb (leginkább megtérülő) prefixeket tartjuk meg.
  const resolved = breakpoints.slice(-MAX_CACHE_BREAKPOINTS)
  assertCachedPrefixSurrogateInvariant(messages, resolved)
  return resolved
}

export function cacheControlPayload(policy: PromptCachePolicy): CacheControlPayload {
  return policy.ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
}

/** Cache-találat / cache-írás prompt-tokenben, ahol a provider visszaadja. */
export type PromptCacheUsage = {
  /** Cache-ből olvasott (töredék áron számolt) prompt-token. */
  cachedPromptTokens?: number
  /** Cache-be írt (felárral számolt) prompt-token. */
  cacheWritePromptTokens?: number
}

type RawUsage = {
  prompt_tokens_details?: {
    cached_tokens?: unknown
    cache_write_tokens?: unknown
    cache_creation_tokens?: unknown
  } | null
  cache_read_input_tokens?: unknown
  cache_creation_input_tokens?: unknown
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

/**
 * Cache-telemetria kiolvasása a provider usage-blokkjából. Két alakot fogadunk:
 * az OpenAI-kompatibilis `prompt_tokens_details.cached_tokens`-t (OpenRouter
 * ezt normalizálja), és az Anthropic-natív `cache_*_input_tokens` mezőket,
 * amelyeket egyes providerek átengednek. Hiányuk nem hiba — a mérés opcionális.
 */
export function extractPromptCacheUsage(usage: unknown): PromptCacheUsage {
  if (!usage || typeof usage !== 'object') return {}
  const raw = usage as RawUsage
  const details = raw.prompt_tokens_details ?? undefined

  const cachedPromptTokens =
    positiveInteger(details?.cached_tokens) ?? positiveInteger(raw.cache_read_input_tokens)
  const cacheWritePromptTokens =
    positiveInteger(raw.cache_creation_input_tokens) ??
    positiveInteger(details?.cache_write_tokens) ??
    positiveInteger(details?.cache_creation_tokens)

  return {
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(cacheWritePromptTokens !== undefined ? { cacheWritePromptTokens } : {}),
  }
}
