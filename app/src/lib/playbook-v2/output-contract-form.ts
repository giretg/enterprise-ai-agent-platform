/**
 * Közérthető kimeneti-contract szerkesztő form-állapota (#44 / #45).
 * Tiszta függvények: form ↔ tipizált tárolási alak (#37).
 */
import type {
  ContractContentCheck,
  ContractField,
  ContractFieldType,
} from '@/domain/contract-runtime'
import { HARD_MAX_REPAIR_ATTEMPTS } from '@/domain/contract-runtime'
import type { PlaybookSpecV2 } from '@/lib/playbook-v2/spec'
import {
  inferStepOutputFields,
  readTypedOutputContractFields,
} from '@/lib/playbook-v2/step-output-inference'

/** Következő lépés igényei alapján javasolt kimeneti mezőnevek (#44). */
export function suggestedOutputFieldsForStep(
  spec: PlaybookSpecV2 | Record<string, unknown>,
  stepId: string | undefined | null,
): string[] {
  if (!stepId) return []
  try {
    return inferStepOutputFields(spec as PlaybookSpecV2).get(stepId) ?? []
  } catch {
    return []
  }
}

const FIELD_TYPES = new Set<ContractFieldType>([
  'string',
  'number',
  'boolean',
  'date',
  'enum',
  'array',
  'object',
])

const SCALAR_ITEM_TYPES = new Set(['string', 'number', 'boolean', 'date'] as const)

export type ContentCheckKind = 'none' | 'pattern' | 'judgment'

export type OutputContractFormField = {
  name: string
  type: ContractFieldType
  required: boolean
  description: string
  /** Enum értékek vesszővel elválasztva a UI-ban. */
  enumValuesText: string
  itemType: Exclude<ContractFieldType, 'array' | 'object' | 'enum'>
  nestedFields: OutputContractFormField[]
  /** #45 — tartalmi kapu opt-in. */
  contentCheckKind: ContentCheckKind
  contentPattern: string
  contentExpect: 'match' | 'notMatch'
  contentCriterion: string
  contentMessage: string
}

export type OutputContractFormMeta = {
  maxRepairAttempts?: number
}

/** Típuscímkék + példák a közérthető szerkesztőhöz. */
export const CONTRACT_FIELD_TYPE_OPTIONS: Array<{
  value: ContractFieldType
  label: string
  example: string
}> = [
  { value: 'string', label: 'Szöveg', example: 'pl. szállító neve' },
  { value: 'number', label: 'Szám', example: 'pl. ár forintban' },
  { value: 'boolean', label: 'Igen / nem', example: 'pl. jóváhagyva?' },
  { value: 'date', label: 'Dátum', example: 'pl. határidő' },
  {
    value: 'enum',
    label: 'Választás listából',
    example: 'pl. jóváhagyva / elutasítva',
  },
  { value: 'array', label: 'Lista', example: 'pl. tételek listája' },
  { value: 'object', label: 'Összetett adat', example: 'pl. szállító adatai együtt' },
]

export function emptyOutputContractFormField(
  partial?: Partial<OutputContractFormField>,
): OutputContractFormField {
  return {
    name: '',
    type: 'string',
    required: true,
    description: '',
    enumValuesText: '',
    itemType: 'string',
    nestedFields: [],
    contentCheckKind: 'none',
    contentPattern: '',
    contentExpect: 'notMatch',
    contentCriterion: '',
    contentMessage: '',
    ...partial,
  }
}

function contentCheckToForm(check: ContractContentCheck | undefined): Pick<
  OutputContractFormField,
  'contentCheckKind' | 'contentPattern' | 'contentExpect' | 'contentCriterion' | 'contentMessage'
> {
  if (!check) {
    return {
      contentCheckKind: 'none',
      contentPattern: '',
      contentExpect: 'notMatch',
      contentCriterion: '',
      contentMessage: '',
    }
  }
  if (check.kind === 'pattern') {
    return {
      contentCheckKind: 'pattern',
      contentPattern: check.regex,
      contentExpect: check.expect ?? 'match',
      contentCriterion: '',
      contentMessage: check.message ?? '',
    }
  }
  return {
    contentCheckKind: 'judgment',
    contentPattern: '',
    contentExpect: 'notMatch',
    contentCriterion: check.criterion,
    contentMessage: check.message ?? '',
  }
}

function formContentCheck(field: OutputContractFormField): ContractContentCheck | undefined {
  if (field.contentCheckKind === 'pattern') {
    const regex = field.contentPattern.trim()
    if (!regex) return undefined
    const check: ContractContentCheck = {
      kind: 'pattern',
      regex,
      expect: field.contentExpect,
    }
    const message = field.contentMessage.trim()
    if (message) check.message = message
    return check
  }
  if (field.contentCheckKind === 'judgment') {
    const criterion = field.contentCriterion.trim()
    if (!criterion) return undefined
    const check: ContractContentCheck = { kind: 'judgment', criterion }
    const message = field.contentMessage.trim()
    if (message) check.message = message
    return check
  }
  return undefined
}

function typedFieldToForm(field: ContractField): OutputContractFormField {
  return {
    name: field.name,
    type: FIELD_TYPES.has(field.type) ? field.type : 'string',
    required: field.required !== false,
    description: field.description ?? '',
    enumValuesText: (field.enumValues ?? []).join(', '),
    itemType:
      field.itemType && SCALAR_ITEM_TYPES.has(field.itemType) ? field.itemType : 'string',
    nestedFields: (field.fields ?? []).map(typedFieldToForm),
    ...contentCheckToForm(field.contentCheck),
  }
}

function readLegacyRequiredNames(outputContract?: Record<string, unknown>): string[] {
  const fields = outputContract?.requiredFields
  if (!Array.isArray(fields)) return []
  return fields.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
}

/** Lazán tárolt outputContract → szerkesztő form-sorok. */
export function outputContractToFormFields(
  outputContract?: Record<string, unknown>,
): OutputContractFormField[] {
  const typed = readTypedOutputContractFields(outputContract)
  if (typed.length > 0) return typed.map(typedFieldToForm)

  return readLegacyRequiredNames(outputContract).map((name) =>
    emptyOutputContractFormField({ name, type: 'string', required: true }),
  )
}

export function readOutputContractFormMeta(
  outputContract?: Record<string, unknown>,
): OutputContractFormMeta {
  const raw = outputContract?.maxRepairAttempts
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return {}
  if (raw < 0) return { maxRepairAttempts: 0 }
  return { maxRepairAttempts: Math.min(raw, HARD_MAX_REPAIR_ATTEMPTS) }
}

function parseEnumValues(text: string): string[] | undefined {
  const values = text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  return values.length > 0 ? values : undefined
}

function formFieldToTyped(field: OutputContractFormField): ContractField | null {
  const name = field.name.trim()
  if (!name) return null
  const typed: ContractField = {
    name,
    type: FIELD_TYPES.has(field.type) ? field.type : 'string',
    required: field.required,
  }
  const description = field.description.trim()
  if (description) typed.description = description
  if (typed.type === 'enum') {
    typed.enumValues = parseEnumValues(field.enumValuesText)
  }
  if (typed.type === 'array') {
    typed.itemType = SCALAR_ITEM_TYPES.has(field.itemType) ? field.itemType : 'string'
  }
  if (typed.type === 'object') {
    const nested = field.nestedFields
      .map(formFieldToTyped)
      .filter((f): f is ContractField => f != null)
    if (nested.length > 0) typed.fields = nested
  }
  const contentCheck = formContentCheck(field)
  if (contentCheck) typed.contentCheck = contentCheck
  return typed
}

/** Form-sorok → tipizált tárolási alak (#37). Üres mezőlista → undefined. */
export function formFieldsToOutputContract(
  fields: OutputContractFormField[],
  meta?: OutputContractFormMeta,
): Record<string, unknown> | undefined {
  const typed = fields.map(formFieldToTyped).filter((f): f is ContractField => f != null)
  if (typed.length === 0 && meta?.maxRepairAttempts == null) return undefined

  const out: Record<string, unknown> = {}
  if (typed.length > 0) out.fields = typed
  if (meta?.maxRepairAttempts != null) {
    const capped = Math.min(Math.max(0, meta.maxRepairAttempts), HARD_MAX_REPAIR_ATTEMPTS)
    out.maxRepairAttempts = capped
  }
  return out
}

/** Form → JSON string a lépés-form `outputContractJson` mezőjébe. */
export function formFieldsToOutputContractJson(
  fields: OutputContractFormField[],
  meta?: OutputContractFormMeta,
): string {
  const stored = formFieldsToOutputContract(fields, meta)
  if (!stored) return ''
  return JSON.stringify(stored, null, 2)
}

export function suggestedOutputFieldNames(
  fields: OutputContractFormField[],
  inferredNames: string[] | undefined,
): string[] {
  const known = new Set(fields.map((f) => f.name.trim()).filter(Boolean))
  const out: string[] = []
  for (const name of inferredNames ?? []) {
    const trimmed = name.trim()
    if (!trimmed || known.has(trimmed) || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

export function applySuggestedOutputFields(
  fields: OutputContractFormField[],
  names: string[],
): OutputContractFormField[] {
  const next = [...fields]
  const known = new Set(next.map((f) => f.name.trim()).filter(Boolean))
  for (const name of names) {
    const trimmed = name.trim()
    if (!trimmed || known.has(trimmed)) continue
    known.add(trimmed)
    next.push(emptyOutputContractFormField({ name: trimmed, type: 'string', required: true }))
  }
  return next
}

function parseOutputContractJson(json: string): Record<string, unknown> | null {
  const trimmed = json.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Nyers JSON string → objektum, vagy null ha üres/hibás. */
export function tryParseOutputContractJson(json: string): Record<string, unknown> | null {
  return parseOutputContractJson(json)
}

export function outputContractHasField(
  outputContract: Record<string, unknown> | null | undefined,
  fieldName: string,
): boolean {
  if (!outputContract || !fieldName.trim()) return false
  const name = fieldName.trim()
  const typed = readTypedOutputContractFields(outputContract)
  if (typed.some((f) => f.name === name)) return true
  return readLegacyRequiredNames(outputContract).includes(name)
}

export function outputContractJsonHasField(json: string, fieldName: string): boolean {
  return outputContractHasField(parseOutputContractJson(json) ?? {}, fieldName)
}

/** Döntési mező biztosítása tipizált `fields` listában (nem csak legacy requiredFields). */
export function ensureFieldInOutputContractJson(json: string, fieldName: string): string {
  const name = fieldName.trim() || 'decision'
  const existing = parseOutputContractJson(json) ?? {}
  if (outputContractHasField(existing, name)) {
    return json.trim() ? json : formFieldsToOutputContractJson([emptyOutputContractFormField({ name })])
  }

  const formFields = outputContractToFormFields(existing)
  const meta = readOutputContractFormMeta(existing)
  const next = applySuggestedOutputFields(formFields, [name])
  return formFieldsToOutputContractJson(next, meta)
}
