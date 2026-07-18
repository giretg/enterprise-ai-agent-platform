/**
 * Lépés-szintű outputContract következtetés a routing és inputSlots alapján.
 * Ha egy lépés nem deklarál outputContract-ot, a következő lépés `step` forrású
 * (vagy nem-config) kötelező input-réseiből következtetjük a kimeneti mezőket.
 */
import type { PlaybookSpecV2, PlaybookStep } from '@/lib/playbook-v2/spec'
import type { ContractField, ContractSource } from '@/domain/contract-runtime'

/**
 * Egy lépés happy-path következő-step céljai. A Decision Step ágai (`branches` +
 * `fallback`) is valós routing-élek (WP-8): a compiler `desugarDecision`-je ezeket
 * `onComplete`-re fordítja, ezért a kimenet-következtetésnek IS látnia kell őket —
 * különben egy döntési ág mögötti, `step`-forrású kötelező input-rés sosem kerülne
 * be a döntési lépés kimeneti kontraktusába (a folyamat csak a KÖVETKEZŐ lépésnél
 * akadna el, a döntési lépés némán `ok`-ként zárulna).
 */
function happyPathNextStepIds(step: PlaybookStep): string[] {
  const ids: string[] = []
  for (const rule of step.onComplete ?? []) {
    if (rule.nextStepId) ids.push(rule.nextStepId)
  }
  if (step.decision) {
    for (const branch of step.decision.branches) {
      if (branch.nextStepId) ids.push(branch.nextStepId)
    }
    if (step.decision.fallback?.nextStepId) ids.push(step.decision.fallback.nextStepId)
  }
  return ids
}

export function inferStepOutputFields(spec: PlaybookSpecV2): Map<string, string[]> {
  const byStep = new Map<string, Set<string>>()
  const stepById = new Map(spec.steps.map((s) => [s.id, s]))

  const addField = (fromStepId: string, fieldName: string) => {
    const set = byStep.get(fromStepId) ?? new Set<string>()
    set.add(fieldName)
    byStep.set(fromStepId, set)
  }

  for (const step of spec.steps) {
    for (const nextStepId of happyPathNextStepIds(step)) {
      const nextStep = stepById.get(nextStepId)
      if (!nextStep) continue

      for (const slot of nextStep.inputSlots ?? []) {
        if (!slot.required) continue
        if (slot.source === 'config') continue

        const fromPreviousStep =
          slot.source === 'step' ||
          (slot.source === 'trigger' && nextStepId !== spec.entryStepId)

        if (fromPreviousStep) addField(step.id, slot.name)
      }
    }
  }

  for (const transition of spec.transitions) {
    const nextStep = stepById.get(transition.toStepId)
    if (!nextStep) continue
    for (const slot of nextStep.inputSlots ?? []) {
      if (!slot.required) continue
      if (slot.source === 'config') continue
      const fromPreviousStep =
        slot.source === 'step' ||
        (slot.source === 'trigger' && transition.toStepId !== spec.entryStepId)
      if (fromPreviousStep) addField(transition.fromStepId, slot.name)
    }
  }

  return new Map([...byStep.entries()].map(([stepId, fields]) => [stepId, [...fields]]))
}

export function mergeOutputRequiredFields(
  explicit: string[] | undefined,
  inferred: string[] | undefined,
): string[] {
  return [...new Set([...(explicit ?? []), ...(inferred ?? [])])]
}

const CONTRACT_FIELD_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'date',
  'enum',
  'array',
  'object',
])

function readTypedField(raw: unknown): ContractField | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.name !== 'string' || !o.name.trim()) return null
  if (typeof o.type !== 'string' || !CONTRACT_FIELD_TYPES.has(o.type)) return null
  const field: ContractField = {
    name: o.name.trim(),
    type: o.type as ContractField['type'],
  }
  if (typeof o.required === 'boolean') field.required = o.required
  if (typeof o.description === 'string') field.description = o.description
  if (Array.isArray(o.enumValues)) {
    field.enumValues = o.enumValues.filter((v): v is string => typeof v === 'string')
  }
  if (
    typeof o.itemType === 'string' &&
    CONTRACT_FIELD_TYPES.has(o.itemType) &&
    o.itemType !== 'array' &&
    o.itemType !== 'object' &&
    o.itemType !== 'enum'
  ) {
    field.itemType = o.itemType as NonNullable<ContractField['itemType']>
  }
  if (Array.isArray(o.fields)) {
    field.fields = o.fields.map(readTypedField).filter((f): f is ContractField => f != null)
  }
  return field
}

/** Tipizált mezőlista a lazán tárolt outputContract-ból. */
export function readTypedOutputContractFields(
  outputContract?: Record<string, unknown>,
): ContractField[] {
  const fields = outputContract?.fields
  if (!Array.isArray(fields)) return []
  return fields.map(readTypedField).filter((f): f is ContractField => f != null)
}

/** Egy step `outputContract.requiredFields`-je (lazán tárolt JSON-ból, típusőrizve). */
export function readOutputContractFields(outputContract?: Record<string, unknown>): string[] {
  const typed = readTypedOutputContractFields(outputContract)
  if (typed.length > 0) {
    const required = typed.filter((f) => f.required !== false).map((f) => f.name)
    const legacy = readLegacyRequiredFields(outputContract)
    return [...new Set([...required, ...legacy])]
  }
  return readLegacyRequiredFields(outputContract)
}

function readLegacyRequiredFields(outputContract?: Record<string, unknown>): string[] {
  const fields = outputContract?.requiredFields
  if (!Array.isArray(fields)) return []
  return fields.filter((f): f is string => typeof f === 'string' && f.length > 0)
}

/** ContractSource a lépés outputContract-jából (+ routing-inferred mezőnevek). */
export function buildContractSource(
  outputContract: Record<string, unknown> | undefined,
  inferredFields: string[] | undefined,
): ContractSource {
  const typed = readTypedOutputContractFields(outputContract)
  const legacy = readLegacyRequiredFields(outputContract)
  const inferred = inferredFields ?? []
  const known = new Set([...typed.map((f) => f.name), ...legacy])
  const extraLegacy = inferred.filter((name) => !known.has(name))
  return {
    fields: typed.length > 0 ? typed : undefined,
    requiredFields: [...new Set([...legacy, ...extraLegacy])],
  }
}

import { HARD_MAX_REPAIR_ATTEMPTS } from '@/domain/contract-runtime'

/** Lépésszintű javítási próba-felülbírálás (0–2), ha a contract megadja. */
export function readMaxRepairAttempts(
  outputContract?: Record<string, unknown>,
): number | undefined {
  const raw = outputContract?.maxRepairAttempts
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined
  if (raw < 0) return 0
  return Math.min(raw, HARD_MAX_REPAIR_ATTEMPTS)
}
