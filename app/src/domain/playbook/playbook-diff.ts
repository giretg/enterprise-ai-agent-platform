/**
 * PlaybookDiffService — WP-5 Risk-weighted verzió-diff + impact analysis
 * (Governed Flow Builder spec §8, D7).
 *
 * TISZTA, kanonikus `spec`-alapú (NEM layout — a layout nincs a hash-ben, D2).
 * A gate / capability / role / criticality változásokat KIEMELI (risk-weighted);
 * a puszta kozmetikai (name/description) eltérés alacsony súlyú.
 */
import type { PlaybookSpecV2, PlaybookStep, PlaybookGate, PlaybookRole } from '@/lib/playbook-v2/spec'

export type DiffRisk = 'low' | 'medium' | 'high'
export type DiffKind = 'added' | 'removed' | 'modified'
export type DiffCategory = 'step' | 'gate' | 'role' | 'routing' | 'entry' | 'output_contract'

export type PlaybookDiffChange = {
  kind: DiffKind
  category: DiffCategory
  /** Az érintett entitás azonosítója (stepId / gateId / roleKey / mező). */
  id: string
  risk: DiffRisk
  detail: string
  /** Modified esetén a megváltozott mezők nevei (risk-indoklás). */
  changedFields?: string[]
}

export type PlaybookDiff = {
  changes: PlaybookDiffChange[]
  highestRisk: DiffRisk | 'none'
  counts: Record<DiffRisk, number>
}

const RISK_ORDER: Record<DiffRisk, number> = { low: 1, medium: 2, high: 3 }

function stable(value: unknown): string {
  return JSON.stringify(canon(value))
}
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon)
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return Object.keys(o)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canon(o[k])
        return acc
      }, {})
  }
  return value
}

/** A magas-kockázatú (governance) mezők — bármelyik változása high súlyú. */
const HIGH_RISK_STEP_FIELDS = new Set(['assignedRole', 'requiredGateIds', 'requiredCapabilities'])
const HIGH_RISK_ROUTING_FIELDS = new Set(['onComplete', 'onError', 'onBlocked', 'decision'])
const HIGH_RISK_GATE_FIELDS = new Set(['criticality', 'blocking', 'type', 'requiredActorRole', 'evidenceRequired'])
const HIGH_RISK_ROLE_FIELDS = new Set(['type', 'requiredCapabilities', 'requiredPermissions'])

function changedFieldNames(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const changed: string[] = []
  for (const k of keys) {
    if (stable(a[k]) !== stable(b[k])) changed.push(k)
  }
  return changed.sort()
}

function riskFor(fields: string[], highSet: Set<string>): DiffRisk {
  if (fields.some((f) => highSet.has(f))) return 'high'
  // Csak kozmetikai (name/description) → low; egyéb strukturális → medium.
  const cosmeticOnly = fields.every((f) => f === 'name' || f === 'description')
  return cosmeticOnly ? 'low' : 'medium'
}

export function diffPlaybookSpecs(a: PlaybookSpecV2, b: PlaybookSpecV2): PlaybookDiff {
  const changes: PlaybookDiffChange[] = []

  // --- entry step ---------------------------------------------------------
  if (a.entryStepId !== b.entryStepId) {
    changes.push({
      kind: 'modified',
      category: 'entry',
      id: 'entryStepId',
      risk: 'high',
      detail: `entryStepId: '${a.entryStepId}' → '${b.entryStepId}'`,
    })
  }

  // --- global output contract --------------------------------------------
  if (stable(a.outputContract) !== stable(b.outputContract)) {
    changes.push({
      kind: 'modified',
      category: 'output_contract',
      id: 'outputContract',
      risk: 'medium',
      detail: 'A folyamat-szintű outputContract megváltozott.',
    })
  }

  diffCollection<PlaybookRole>(
    a.roles,
    b.roles,
    (r) => r.key,
    'role',
    HIGH_RISK_ROLE_FIELDS,
    changes,
  )
  diffCollection<PlaybookGate>(
    a.gates,
    b.gates,
    (g) => g.id,
    'gate',
    HIGH_RISK_GATE_FIELDS,
    changes,
  )
  diffSteps(a.steps, b.steps, changes)

  const counts: Record<DiffRisk, number> = { low: 0, medium: 0, high: 0 }
  for (const c of changes) counts[c.risk]++
  let highestRisk: DiffRisk | 'none' = 'none'
  for (const c of changes) {
    if (highestRisk === 'none' || RISK_ORDER[c.risk] > RISK_ORDER[highestRisk]) {
      highestRisk = c.risk
    }
  }
  return { changes, highestRisk, counts }
}

function diffCollection<T extends Record<string, unknown>>(
  aItems: T[],
  bItems: T[],
  idOf: (t: T) => string,
  category: DiffCategory,
  highSet: Set<string>,
  changes: PlaybookDiffChange[],
) {
  const aMap = new Map(aItems.map((t) => [idOf(t), t]))
  const bMap = new Map(bItems.map((t) => [idOf(t), t]))
  for (const [id, aItem] of aMap) {
    const bItem = bMap.get(id)
    if (!bItem) {
      changes.push({
        kind: 'removed',
        category,
        id,
        risk: 'high',
        detail: `${category} '${id}' törölve.`,
      })
      continue
    }
    if (stable(aItem) !== stable(bItem)) {
      const fields = changedFieldNames(aItem, bItem)
      changes.push({
        kind: 'modified',
        category,
        id,
        risk: riskFor(fields, highSet),
        detail: `${category} '${id}' módosult: ${fields.join(', ')}.`,
        changedFields: fields,
      })
    }
  }
  for (const [id] of bMap) {
    if (!aMap.has(id)) {
      changes.push({
        kind: 'added',
        category,
        id,
        risk: 'medium',
        detail: `${category} '${id}' hozzáadva.`,
      })
    }
  }
}

/** A stepeknél a routing-mezőket (onComplete/decision/onError) külön, high súllyal jelöljük. */
function diffSteps(aSteps: PlaybookStep[], bSteps: PlaybookStep[], changes: PlaybookDiffChange[]) {
  const aMap = new Map(aSteps.map((s) => [s.id, s]))
  const bMap = new Map(bSteps.map((s) => [s.id, s]))
  for (const [id, aStep] of aMap) {
    const bStep = bMap.get(id)
    if (!bStep) {
      changes.push({ kind: 'removed', category: 'step', id, risk: 'high', detail: `step '${id}' törölve.` })
      continue
    }
    if (stable(aStep) === stable(bStep)) continue
    const fields = changedFieldNames(
      aStep as unknown as Record<string, unknown>,
      bStep as unknown as Record<string, unknown>,
    )
    const routingFields = fields.filter((f) => HIGH_RISK_ROUTING_FIELDS.has(f))
    const otherFields = fields.filter((f) => !HIGH_RISK_ROUTING_FIELDS.has(f))
    if (routingFields.length > 0) {
      changes.push({
        kind: 'modified',
        category: 'routing',
        id,
        risk: 'high',
        detail: `step '${id}' routing/elágazás módosult: ${routingFields.join(', ')}.`,
        changedFields: routingFields,
      })
    }
    if (otherFields.length > 0) {
      changes.push({
        kind: 'modified',
        category: 'step',
        id,
        risk: riskFor(otherFields, HIGH_RISK_STEP_FIELDS),
        detail: `step '${id}' módosult: ${otherFields.join(', ')}.`,
        changedFields: otherFields,
      })
    }
  }
  for (const [id] of bMap) {
    if (!aMap.has(id)) {
      changes.push({ kind: 'added', category: 'step', id, risk: 'medium', detail: `step '${id}' hozzáadva.` })
    }
  }
}

// --- Impact analysis (WP-5 §8) — mely fogyasztók pinelnek a verzióra ---------

export type PlaybookVersionPin = {
  kind: 'process_definition' | 'assignment' | 'trigger'
  id: string
  name?: string
  tenantId?: string | null
}

export type ImpactReport = {
  affectedCount: number
  byKind: Record<PlaybookVersionPin['kind'], number>
  pins: PlaybookVersionPin[]
}

/** Tiszta aggregáció: a DB-ből betöltött pin-lista összegzése a publish-dialógushoz. */
export function summarizeImpact(pins: PlaybookVersionPin[]): ImpactReport {
  const byKind: Record<PlaybookVersionPin['kind'], number> = {
    process_definition: 0,
    assignment: 0,
    trigger: 0,
  }
  for (const p of pins) byKind[p.kind]++
  return { affectedCount: pins.length, byKind, pins }
}
