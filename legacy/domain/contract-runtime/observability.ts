/**
 * Contract megfigyelhetőség (#46 / #33).
 *
 * Tiszta aggregátor: audit-szerű rekordokból arányok, javítási költség,
 * emberi kapu ok-eloszlás. A dashboard és a tesztek ugyanezt a varratot hívják.
 */

export type ContractEvaluationOutcome = 'first_pass' | 'repaired' | 'failed'

export type ContractEvaluationRecord = {
  outcome: ContractEvaluationOutcome
  repairAttempts: number
  /** Javító modellhívások becsült költsége (EUR), ha ismert. */
  repairCostEstimate: number
  stepId?: string | null
}

export type ContractHumanGateRecord = {
  stepId: string
  reasonCode: string
  reasonLabel: string
}

export type ContractObservabilitySummary = {
  totalEvaluations: number
  firstPassCount: number
  repairedCount: number
  failedCount: number
  /** null, ha még nincs értékelés. */
  firstPassRate: number | null
  /** null, ha még nincs értékelés. */
  repairRate: number | null
  repairCostEstimate: number
  humanGateReasons: Array<{ reasonCode: string; reasonLabel: string; count: number }>
  failingSteps: Array<{ stepId: string; count: number }>
  /** Lépés × ok párok — melyik lépés milyen okból akadt el. */
  stepReasonBreakdown: Array<{
    stepId: string
    reasonCode: string
    reasonLabel: string
    count: number
  }>
}

function roundEur(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** Szigorú mód eredmény → megfigyelhetőségi kimenetel. */
export function classifyContractOutcome(result: {
  ok: boolean
  repairAttempts: number
}): ContractEvaluationOutcome {
  if (!result.ok) return 'failed'
  return result.repairAttempts > 0 ? 'repaired' : 'first_pass'
}

export function summarizeContractObservability(input: {
  evaluations: ContractEvaluationRecord[]
  humanGates: ContractHumanGateRecord[]
}): ContractObservabilitySummary {
  const totalEvaluations = input.evaluations.length
  let firstPassCount = 0
  let repairedCount = 0
  let failedCount = 0
  let repairCostEstimate = 0

  for (const ev of input.evaluations) {
    if (ev.outcome === 'first_pass') firstPassCount++
    else if (ev.outcome === 'repaired') repairedCount++
    else failedCount++
    repairCostEstimate += ev.repairCostEstimate
  }

  const reasonCounts = new Map<string, { reasonCode: string; reasonLabel: string; count: number }>()
  const stepCounts = new Map<string, number>()
  const pairCounts = new Map<
    string,
    { stepId: string; reasonCode: string; reasonLabel: string; count: number }
  >()
  for (const gate of input.humanGates) {
    const existing = reasonCounts.get(gate.reasonCode)
    if (existing) existing.count++
    else {
      reasonCounts.set(gate.reasonCode, {
        reasonCode: gate.reasonCode,
        reasonLabel: gate.reasonLabel,
        count: 1,
      })
    }
    stepCounts.set(gate.stepId, (stepCounts.get(gate.stepId) ?? 0) + 1)
    const pairKey = `${gate.stepId}\0${gate.reasonCode}`
    const pair = pairCounts.get(pairKey)
    if (pair) pair.count++
    else {
      pairCounts.set(pairKey, {
        stepId: gate.stepId,
        reasonCode: gate.reasonCode,
        reasonLabel: gate.reasonLabel,
        count: 1,
      })
    }
  }

  const humanGateReasons = Array.from(reasonCounts.values()).sort((a, b) => b.count - a.count)
  const failingSteps = Array.from(stepCounts.entries())
    .map(([stepId, count]) => ({ stepId, count }))
    .sort((a, b) => b.count - a.count)
  const stepReasonBreakdown = Array.from(pairCounts.values()).sort((a, b) => b.count - a.count)

  return {
    totalEvaluations,
    firstPassCount,
    repairedCount,
    failedCount,
    firstPassRate: totalEvaluations > 0 ? firstPassCount / totalEvaluations : null,
    repairRate: totalEvaluations > 0 ? repairedCount / totalEvaluations : null,
    repairCostEstimate: roundEur(repairCostEstimate),
    humanGateReasons,
    failingSteps,
    stepReasonBreakdown,
  }
}

/** Közérthető magyar címkék a dashboardhoz. */
export const CONTRACT_OUTCOME_LABELS: Record<
  ContractEvaluationOutcome,
  { label: string; hint: string }
> = {
  first_pass: {
    label: 'Elsőre sikeres',
    hint: 'A lépés kimenete azonnal megfelelt a várt szerkezetnek — nem kellett javító modellhívás.',
  },
  repaired: {
    label: 'Javítás után sikeres',
    hint: 'Az első válasz hibás volt, de egy automatikus javító kör után elfogadható lett.',
  },
  failed: {
    label: 'Sikertelen — emberi felülvizsgálat',
    hint: 'A javítás sem sikerült, vagy kritikus lépésnél azonnal emberhez került.',
  },
}

export function humanGateReasonLabel(reasonCode: string): string {
  switch (reasonCode) {
    case 'output_contract_unmet':
      return 'Hiányzó vagy hibás kimeneti mező'
    case 'tool_denied':
      return 'Az eszközhasználat meg lett tagadva'
    case 'tool_loop_exhausted':
      return 'Az eszközhívások száma kimerült'
    default:
      return reasonCode.replace(/_/g, ' ')
  }
}

/** Csak a kimeneti-contract miatti emberi kapuk tartoznak ehhez a mérőszámhoz. */
export function isContractHumanGateReason(reasonCode: string): boolean {
  return reasonCode === 'output_contract_unmet'
}

/** Audit metadata → értékelési rekord (dashboard / tesztek). */
export function evaluationFromAuditMetadata(
  metadata: unknown,
): ContractEvaluationRecord | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const m = metadata as Record<string, unknown>
  const outcome = m.outcome
  if (outcome !== 'first_pass' && outcome !== 'repaired' && outcome !== 'failed') return null
  const repairAttempts = typeof m.repair_attempts === 'number' ? m.repair_attempts : 0
  const repairCostEstimate =
    typeof m.repair_cost_estimate === 'number' && Number.isFinite(m.repair_cost_estimate)
      ? m.repair_cost_estimate
      : 0
  const stepId = typeof m.step_id === 'string' ? m.step_id : null
  return { outcome, repairAttempts, repairCostEstimate, stepId }
}

/**
 * process.blocked audit metadata → emberi kapu rekord.
 * Csak `output_contract_unmet` (contract-sértés) kerül be — más blocked okok nem.
 */
export function humanGateFromBlockedMetadata(
  metadata: unknown,
): ContractHumanGateRecord | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const m = metadata as Record<string, unknown>
  const reasonCode =
    typeof m.outcome_reason === 'string'
      ? m.outcome_reason
      : typeof m.reason === 'string'
        ? m.reason
        : null
  if (!reasonCode || !isContractHumanGateReason(reasonCode)) return null
  const stepId =
    typeof m.completed_step_id === 'string'
      ? m.completed_step_id
      : typeof m.step_id === 'string'
        ? m.step_id
        : 'ismeretlen'
  return {
    stepId,
    reasonCode,
    reasonLabel: humanGateReasonLabel(reasonCode),
  }
}

/** Audit metadata a `contract.evaluate` eseményhez (#46). */
export function buildContractEvaluateAuditMetadata(input: {
  outcome: ContractEvaluationOutcome
  repairAttempts: number
  repairCostEstimate: number
  stepId?: string | null
  playbookRef?: string | null
  errorCodes?: string[]
}): Record<string, unknown> {
  return {
    outcome: input.outcome,
    repair_attempts: input.repairAttempts,
    repair_cost_estimate: roundEur(input.repairCostEstimate),
    step_id: input.stepId ?? null,
    playbook_ref: input.playbookRef ?? null,
    error_codes: input.errorCodes ?? [],
  }
}
