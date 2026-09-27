import { DEFAULT_TENANT_LANGUAGE } from './tenant-language'

/**
 * KB-keresés nyelvi registry — EGYETLEN forrás a tudástár nyelvéhez.
 * Kulcs: üzleti nyelv-kód (connector/document/tenant szinten tárolt érték).
 * `pgConfig`: a Postgres `regconfig`; SQL-be kizárólag a
 * `knowledge-repository.ts`-beli `kbRegconfig` allowlist-lookupja teheti
 * (a `regconfig` nem köthető paraméterként).
 *
 * Prisma-függés nélkül — Control Plane client-componensek is importálhatják.
 */
export const KB_LANGUAGE_REGISTRY = {
  hu: { pgConfig: 'hungarian', label: 'Magyar' },
  en: { pgConfig: 'english', label: 'English' },
} as const

export type KbLanguage = keyof typeof KB_LANGUAGE_REGISTRY

/** Ismeretlen / nem-allowlist értékre eső Postgres konfig. */
export const KB_PG_FALLBACK = 'simple' as const

type KbPgConfig = (typeof KB_LANGUAGE_REGISTRY)[KbLanguage]['pgConfig'] | typeof KB_PG_FALLBACK

/** Mai viselkedés őrzése: nyelv nélkül magyar. */
export const DEFAULT_KB_LANGUAGE: KbLanguage = 'hu'

export const KB_LANGUAGE_OPTIONS: ReadonlyArray<{ value: KbLanguage; label: string }> = [
  { value: 'hu', label: KB_LANGUAGE_REGISTRY.hu.label },
  { value: 'en', label: KB_LANGUAGE_REGISTRY.en.label },
]

export function isKbLanguage(value: unknown): value is KbLanguage {
  return value === 'hu' || value === 'en'
}

/** Ismeretlen értéket a mai viselkedésre (`hu`) normalizál. */
export function resolveKbLanguage(value: unknown): KbLanguage {
  return isKbLanguage(value) ? value : DEFAULT_KB_LANGUAGE
}

/** Registry → Postgres `regconfig`-név; nem-allowlist inputra `simple`. */
export function kbPgConfig(language: unknown): KbPgConfig {
  if (!isKbLanguage(language)) return KB_PG_FALLBACK
  return KB_LANGUAGE_REGISTRY[language].pgConfig
}

/**
 * Effektív KB-nyelv egy chunkra/dokumentumra:
 * `override ?? connector ?? tenant ?? 'hu'`.
 */
export function resolveEffectiveKbLanguage(input: {
  override?: unknown
  connector?: unknown
  tenant?: unknown
}): KbLanguage {
  if (isKbLanguage(input.override)) return input.override
  if (isKbLanguage(input.connector)) return input.connector
  if (isKbLanguage(input.tenant)) return input.tenant
  return DEFAULT_TENANT_LANGUAGE
}
