/**
 * Strukturált kimenet / Contract Runtime (#33).
 *
 * Provider-agnosztikus modul: contract-fordítás, validáció, laza kinyerés,
 * és szigorú mód javító hurokkal a modell-kapun át.
 */
export type ContractFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'enum'
  | 'array'
  | 'object'

/** Tipizált contract-mező a folyamat-definícióból. */
export type ContractField = {
  name: string
  type: ContractFieldType
  required?: boolean
  description?: string
  /** `enum` típusnál az érvényes értékek. */
  enumValues?: string[]
  /** `array` típusnál az elemek típusa (alap: string). */
  itemType?: Exclude<ContractFieldType, 'array' | 'object' | 'enum'>
  /** Beágyazott mezők `object` típusnál. */
  fields?: ContractField[]
}

/** Contract forrás: tipizált mezőlista és/vagy legacy mezőnév-lista. */
export type ContractSource = {
  fields?: ContractField[]
  /** Régi `requiredFields` — fordításkor kötelező, nem üres szöveg. */
  requiredFields?: string[]
}

export type ContractIssue = {
  field: string
  code: 'missing' | 'empty' | 'type' | 'enum' | 'invalid'
  message: string
}

export type ValidationSuccess = {
  ok: true
  value: Record<string, unknown>
}

export type ValidationFailure = {
  ok: false
  errors: ContractIssue[]
}

export type ValidationResult = ValidationSuccess | ValidationFailure

export type CompiledContract = {
  /** Mezőnevek (prompt / missing lista). */
  fieldNames: string[]
  /** Belső Zod-séma — a hívó ne függjön tőle közvetlenül. */
  schema: import('zod').ZodType<Record<string, unknown>>
  fields: ContractField[]
}

export type CriticalityLevel = 'L0' | 'L1' | 'L2' | 'L3'

/** Kemény felső korlát a javító próbákra (#33). */
export const HARD_MAX_REPAIR_ATTEMPTS = 2
/** Alapértelmezett javító próbaszám (L0–L2). */
export const DEFAULT_REPAIR_ATTEMPTS = 1

export type StrictContractSuccess = {
  ok: true
  value: Record<string, unknown>
  repairAttempts: number
}

export type StrictContractFailure = {
  ok: false
  errors: ContractIssue[]
  repairAttempts: number
  /** Közérthető magyar magyarázat emberi felülvizsgálathoz. */
  humanSummary: string
}

export type StrictContractResult = StrictContractSuccess | StrictContractFailure
