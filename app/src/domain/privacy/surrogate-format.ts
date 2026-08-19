/**
 * Típusos álnév formátuma (AI Privacy Gateway spec §5, D1, R9, R16).
 *
 * Alak: `[[COMPANY_1]]` — entitástípus nagybetűvel + beszélgetésen belüli 1-alapú
 * sorszám. A HMAC **nem** része a szövegnek: a hitelesség a vault-rekordé, nem az
 * álnév alakjáé. A modell által kitalált, jól formázott álnév ezért önmagában
 * semmit nem old fel.
 *
 * Névtér (spec §11): `company`, `person`, `email`, `phone`, `account`.
 */
export const SURROGATE_ENTITY_TYPES = ['company', 'person', 'email', 'phone', 'account'] as const

export type SurrogateEntityType = (typeof SURROGATE_ENTITY_TYPES)[number]

const LABEL_BY_TYPE: Record<SurrogateEntityType, string> = {
  company: 'COMPANY',
  person: 'PERSON',
  email: 'EMAIL',
  phone: 'PHONE',
  account: 'ACCOUNT',
}

const TYPE_BY_LABEL: Record<string, SurrogateEntityType> = Object.fromEntries(
  SURROGATE_ENTITY_TYPES.map((entityType) => [LABEL_BY_TYPE[entityType], entityType]),
) as Record<string, SurrogateEntityType>

/** Teljes álnév: `[[TYPE_N]]`, N ≥ 1, vezető nulla nélkül. */
const SURROGATE_EXACT = /^\[\[([A-Z]+)_([1-9][0-9]*)\]\]$/

export type ParsedSurrogate = {
  entityType: SurrogateEntityType
  ordinal: number
}

export class UnknownEntityTypeError extends Error {
  readonly entityType: string

  constructor(entityType: string) {
    super(`ismeretlen entitástípus: ${entityType}`)
    this.name = 'UnknownEntityTypeError'
    this.entityType = entityType
  }
}

export function isSurrogateEntityType(value: string): value is SurrogateEntityType {
  return (SURROGATE_ENTITY_TYPES as readonly string[]).includes(value)
}

export function formatSurrogate(entityType: string, ordinal: number): string {
  if (!isSurrogateEntityType(entityType)) throw new UnknownEntityTypeError(entityType)
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new RangeError(`az álnév sorszáma legalább 1 legyen, kapott: ${ordinal}`)
  }
  return `[[${LABEL_BY_TYPE[entityType]}_${ordinal}]]`
}

/** Az egész string egy álnév-e. Részstringre nem illeszkedik. */
export function parseSurrogate(text: string): ParsedSurrogate | null {
  const match = SURROGATE_EXACT.exec(text)
  if (!match) return null
  const entityType = TYPE_BY_LABEL[match[1] ?? '']
  if (!entityType) return null
  return { entityType, ordinal: Number(match[2]) }
}
