/**
 * #1126 fokozatos bevezetés: a flagek listája. Az állapot az adatbázisban van, a lista itt, így az
 * elgépelt név fordítási hiba, és egy bejegyzés törlése után a típushibák megmutatják az összes
 * használati helyet. Útmutató: `docs/feature-flags.md`.
 */
export type LocalizedText = { hu: string; en: string }

export type FeatureFlagDefinition = {
  /** Rövid név; a cég auditnaplója is ezt mutatja. */
  title: LocalizedText
  /** Mit kap a felhasználó bekapcsolva, közérthetően. */
  whatChanges: LocalizedText
  /** Mi történik leállításkor, és mi lesz a bekapcsolva keletkezett adatokkal. */
  whenOff: LocalizedText
  /** Felelős. */
  owner: string
  /** Kapcsolódó GitHub issue vagy PR száma. */
  issue: number
  /** Felülvizsgálati dátum (ÉÉÉÉ-HH-NN); ha lejár, a CI figyelmeztet. */
  reviewBy: string
}

/** A kulcs formája `terület.funkció`, pl. `chat.resumable_pause`. */
export const FEATURE_FLAGS = {} satisfies Record<string, FeatureFlagDefinition>

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS & string

export type FeatureFlagRegistry = Readonly<Record<string, FeatureFlagDefinition>>

/** Törölt kulcsok: nem használhatók újra, mert a régi adatbázis-sor új jelentést kapna. */
export const RETIRED_FEATURE_FLAG_KEYS: readonly string[] = []

const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
}

/** CI-ellenőrzés: a hibák megbuktatják a futást, a figyelmeztetések nem (D6). */
export function validateFeatureFlagRegistry(
  registry: FeatureFlagRegistry,
  retiredKeys: readonly string[],
  today: Date,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  for (const [key, def] of Object.entries(registry)) {
    if (!KEY_PATTERN.test(key)) errors.push(`${key}: a kulcs formája legyen terület.funkció (kisbetű, szám, aláhúzás)`)
    if (retiredKeys.includes(key)) errors.push(`${key}: törölt kulcs nem használható újra`)
    for (const field of ['title', 'whatChanges', 'whenOff'] as const) {
      if (!def[field]?.hu?.trim() || !def[field]?.en?.trim()) errors.push(`${key}: a(z) ${field} magyarul és angolul is kötelező`)
    }
    if (!def.owner?.trim()) errors.push(`${key}: a felelős kötelező`)
    if (!Number.isInteger(def.issue) || def.issue <= 0) errors.push(`${key}: az issue száma kötelező`)
    if (!isRealDate(def.reviewBy ?? '')) {
      errors.push(`${key}: a felülvizsgálati dátum formája ÉÉÉÉ-HH-NN`)
    } else if (new Date(`${def.reviewBy}T23:59:59Z`).getTime() < today.getTime()) {
      warnings.push(`${key}: a felülvizsgálati dátum (${def.reviewBy}) lejárt`)
    }
  }
  return { errors, warnings }
}
