/**
 * Típusos álnév formátuma (AI Privacy Gateway spec §5, issue #320 D1/D3).
 *
 * Alak: `[[COMPANY@S2_1]]` — entitástípus nagybetűvel, opcionális forrásbélyeg
 * (`@S{n}`), majd beszélgetésen belüli 1-alapú sorszám. A régi bélyeg nélküli
 * `[[COMPANY_1]]` továbbra is parse-olható (visszafelé kompatibilitás).
 *
 * Az entitástípus kulcsa forrás-definiált slug; a platform nem tart nyilván
 * zárt listát. Az alapöt típus seed alapértelmezésként megmarad a nem
 * nyilatkozó forrásokhoz.
 */
export const DEFAULT_SURROGATE_ENTITY_TYPES = [
  'company',
  'person',
  'email',
  'phone',
  'account',
] as const

/** @deprecated Használd a `DEFAULT_SURROGATE_ENTITY_TYPES`-ot; alias a kompatibilitásért. */
export const SURROGATE_ENTITY_TYPES = DEFAULT_SURROGATE_ENTITY_TYPES

export type DefaultSurrogateEntityType = (typeof DEFAULT_SURROGATE_ENTITY_TYPES)[number]

/** Nyitott entitástípus-slug (forrás-definiált). */
export const ENTITY_TYPE_SLUG_RE = /^[a-z][a-z0-9_]{0,31}$/

export type SurrogateEntityType = string

const DEFAULT_LABEL_BY_TYPE: Record<DefaultSurrogateEntityType, string> = {
  company: 'COMPANY',
  person: 'PERSON',
  email: 'EMAIL',
  phone: 'PHONE',
  account: 'ACCOUNT',
}

const DEFAULT_TYPE_BY_LABEL: Record<string, DefaultSurrogateEntityType> = Object.fromEntries(
  DEFAULT_SURROGATE_ENTITY_TYPES.map((entityType) => [DEFAULT_LABEL_BY_TYPE[entityType], entityType]),
) as Record<string, DefaultSurrogateEntityType>

/** Teljes álnév: `[[TYPE_N]]` vagy `[[TYPE@S2_N]]`, N ≥ 1. */
const SURROGATE_EXACT =
  /^\[\[([A-Z][A-Z0-9_]*)(?:@(S[0-9]+))?_([1-9][0-9]*)\]\]$/

/** Beágyazott álnév szövegben. A típusnév-ellenőrzést a `parseSurrogate` adja. */
const SURROGATE_EMBEDDED =
  /\[\[([A-Z][A-Z0-9_]*)(?:@(S[0-9]+))?_([1-9][0-9]*)\]\]/g

export type ParsedSurrogate = {
  entityType: SurrogateEntityType
  ordinal: number
  /** Tenanton belüli forrás-sorszám, pl. `S2`. Régi álneveknél hiányzik. */
  sourceSlot?: string
}

export class UnknownEntityTypeError extends Error {
  readonly entityType: string

  constructor(entityType: string) {
    super(`ismeretlen entitástípus: ${entityType}`)
    this.name = 'UnknownEntityTypeError'
    this.entityType = entityType
  }
}

export function isEntityTypeSlug(value: string): boolean {
  return ENTITY_TYPE_SLUG_RE.test(value)
}

export function isDefaultSurrogateEntityType(value: string): value is DefaultSurrogateEntityType {
  return (DEFAULT_SURROGATE_ENTITY_TYPES as readonly string[]).includes(value)
}

/** Érvényes entitástípus-slug-e (nyitott névtér). */
export function isSurrogateEntityType(value: string): boolean {
  return isEntityTypeSlug(value)
}

export function formatPrivacySourceSlot(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1) {
    throw new RangeError(`a forrás-sorszám legalább 1 legyen, kapott: ${slot}`)
  }
  return `S${slot}`
}

export function entityTypeLabel(entityType: string): string {
  if (!isEntityTypeSlug(entityType)) throw new UnknownEntityTypeError(entityType)
  if (isDefaultSurrogateEntityType(entityType)) return DEFAULT_LABEL_BY_TYPE[entityType]
  return entityType.toUpperCase()
}

function labelToEntityType(label: string): SurrogateEntityType | null {
  const fromDefault = DEFAULT_TYPE_BY_LABEL[label]
  if (fromDefault) return fromDefault
  const slug = label.toLowerCase()
  return isEntityTypeSlug(slug) ? slug : null
}

export function formatSurrogate(
  entityType: string,
  ordinal: number,
  sourceSlot?: string | null,
): string {
  if (!isEntityTypeSlug(entityType)) throw new UnknownEntityTypeError(entityType)
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new RangeError(`az álnév sorszáma legalább 1 legyen, kapott: ${ordinal}`)
  }
  const label = entityTypeLabel(entityType)
  if (sourceSlot) {
    return `[[${label}@${sourceSlot}_${ordinal}]]`
  }
  return `[[${label}_${ordinal}]]`
}

function parseSurrogateMatch(match: RegExpMatchArray): ParsedSurrogate | null {
  const entityType = labelToEntityType(match[1] ?? '')
  if (!entityType) return null
  const sourceSlot = match[2] || undefined
  return { entityType, ordinal: Number(match[3]), sourceSlot }
}

/** Az egész string egy álnév-e. Részstringre nem illeszkedik. */
export function parseSurrogate(text: string): ParsedSurrogate | null {
  const match = SURROGATE_EXACT.exec(text)
  if (!match) return null
  return parseSurrogateMatch(match)
}

export type EmbeddedSurrogate = {
  start: number
  end: number
  text: string
  parsed: ParsedSurrogate | null
}

/** Van-e a szövegben felismerhető, típusos álnév (UI jelzéshez). */
export function containsEmbeddedSurrogate(text: string): boolean {
  if (!text) return false
  return findEmbeddedSurrogates(text).some((match) => match.parsed != null)
}

/** Álnevek a szövegben, előfordulási sorrendben. Ismeretlen típusnál `parsed` null. */
export function findEmbeddedSurrogates(text: string): EmbeddedSurrogate[] {
  const found: EmbeddedSurrogate[] = []
  const re = new RegExp(SURROGATE_EMBEDDED.source, 'g')
  for (const match of text.matchAll(re)) {
    const raw = match[0]
    const start = match.index ?? 0
    found.push({
      start,
      end: start + raw.length,
      text: raw,
      parsed: parseSurrogate(raw),
    })
  }
  return found
}

/**
 * Lezáratlan álnév-prefix, amit a streamelő feloldó visszatart.
 * `[[COMP` igaz; `[[hello` hamis (kisbetű, nem lehet típuscímke).
 */
export function isSurrogatePrefix(text: string): boolean {
  if (text === '[') return true
  if (!text.startsWith('[[')) return false
  if (text.includes(']]')) return false
  const inner = text.slice(2)
  return (
    inner === '' ||
    /^[A-Z]+$/.test(inner) ||
    /^[A-Z]+_$/.test(inner) ||
    /^[A-Z]+_[1-9][0-9]*$/.test(inner) ||
    /^[A-Z]+_[1-9][0-9]*\]$/.test(inner) ||
    /^[A-Z]+@S[0-9]+$/.test(inner) ||
    /^[A-Z]+@S[0-9]+_$/.test(inner) ||
    /^[A-Z]+@S[0-9]+_[1-9][0-9]*$/.test(inner) ||
    /^[A-Z]+@S[0-9]+_[1-9][0-9]*\]$/.test(inner)
  )
}

/** Ordinal-allokáció kulcsa: entitástípus + forrásbélyeg. */
export function surrogateOrdinalKey(entityType: string, sourceSlot?: string | null): string {
  return `${entityType}\0${sourceSlot ?? ''}`
}
