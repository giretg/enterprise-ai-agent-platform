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

/**
 * Mezőszintű opcionális tartalmi (szemantikus) kapu (#45).
 * Deklaráció hiányában semmi nem fut és nem kerül semmibe.
 */
export type ContractContentCheck =
  | {
      kind: 'pattern'
      /** JS RegExp forrás. */
      regex: string
      flags?: string
      /** Alap: `match`. `notMatch` = a minta tilos (pl. személyi szám). */
      expect?: 'match' | 'notMatch'
      /** Közérthető magyarázat sértéskor. */
      message?: string
    }
  | {
      kind: 'judgment'
      /** Hétköznapi kritérium a modellnek (kapun át). */
      criterion: string
      message?: string
    }

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
  /** Opt-in tartalmi ellenőrzés (#45). */
  contentCheck?: ContractContentCheck
}

/** Contract forrás: tipizált mezőlista és/vagy legacy mezőnév-lista. */
export type ContractSource = {
  fields?: ContractField[]
  /** Régi `requiredFields` — fordításkor kötelező, nem üres szöveg. */
  requiredFields?: string[]
}

export type ContractIssue = {
  field: string
  code: 'missing' | 'empty' | 'type' | 'enum' | 'invalid' | 'content'
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
  /** Javító modellhívások becsült költsége (EUR); elsőre sikeresnél 0. */
  repairCostEstimate: number
}

export type StrictContractFailure = {
  ok: false
  errors: ContractIssue[]
  repairAttempts: number
  repairCostEstimate: number
  /** Közérthető magyar magyarázat emberi felülvizsgálathoz. */
  humanSummary: string
}

export type StrictContractResult = StrictContractSuccess | StrictContractFailure
