/**
 * PlaybookSimulator — WP-4 Symbolic Simulation / dry-run
 * (Governed Flow Builder spec §7, D4).
 *
 * TISZTA, DB- és LLM-MENTES. A `compiledSpec` állapotgépén sétál végig HAMIS
 * step-outputokkal (a `outputContract` alapján generált placeholder), a routing-
 * feltételeket kiértékeli, és futás ELŐTTI bizonyosságot ad éles hívás nélkül:
 *   - hiányzó role binding (a ProcessDefinition.roleBindings-hoz képest),
 *   - hiányzó connector grant / tool capability mismatch,
 *   - approval-gate-ek helye és escalation-út,
 *   - HEURISZTIKUS token/költség-becslés (per-step modell-konfig × becsült token),
 *   - várható út (expected path).
 *
 * A költség NEM valós mérés (D4); a tarifa a `model.pricing` platform-settingből jön (D11).
 */
import type { PlaybookSpecV2 } from '@/lib/playbook-v2/spec'
import type { CompiledSpec } from '@/domain/playbook/playbook-compiler'
import { evaluateAdvance } from '@/lib/playbook-v2/runtime'

export type SimulationFindingCategory =
  | 'missing_role'
  | 'missing_capability'
  | 'approval_gate'
  | 'unreachable_step'
  | 'no_fallback'

export type SimulationSeverity = 'error' | 'warning' | 'info'

export type SimulationFinding = {
  category: SimulationFindingCategory
  severity: SimulationSeverity
  stepId?: string
  gateId?: string
  message: string
}

/** Per-capability modell-ár (EUR / 1M token), a `model.pricing` platform-settinghez igazítva. */
export type ModelPricing = Record<string, { inputPerMTokens: number; outputPerMTokens: number }>

export type SimulateInput = {
  spec: PlaybookSpecV2
  compiled: CompiledSpec
  /** role.key → kötött agent/user id (ProcessDefinition.roleBindings). Üres → hiányzó kötés. */
  roleBindings: Record<string, string | null | undefined>
  /** role.key → a role ténylegesen elérhető capability-i (grant-ok). */
  roleCapabilities: Record<string, string[]>
  sampleInput: Record<string, unknown>
  /** Opcionális tarifa a heurisztikus költségbecsléshez (D11). */
  pricing?: ModelPricing
}

export type SimulationReport = {
  findings: SimulationFinding[]
  /** A szimbolikus alapértelmezett úton bejárt step-id-k sorrendben. */
  expectedPath: string[]
  /** A bejárás közben elért blocking gate-ek (escalation-pontok). */
  encounteredGates: string[]
  /** Heurisztikus becsült költség EUR-ban (0, ha nincs pricing / nincs agent-lépés). */
  estimatedCostEur: number
  /** Heurisztikus becsült futásidő percben (agent-lépés + emberi kapu SLA). */
  estimatedDurationMinutes: number
}

// Heurisztikus token-modell egy agent-lépésre (D4 — becslés, nem mérés).
const HEURISTIC_INPUT_TOKENS = 1500
const HEURISTIC_OUTPUT_TOKENS = 500
const DEFAULT_STEP_MINUTES = 5
const DEFAULT_GATE_MINUTES = 60

export class PlaybookSimulator {
  simulate(input: SimulateInput): SimulationReport {
    const findings: SimulationFinding[] = []
    const roleByKey = new Map(input.spec.roles.map((r) => [r.key, r]))

    // --- 1. hiányzó role binding + capability mismatch --------------------
    for (const role of input.spec.roles) {
      const bound = input.roleBindings[role.key]
      if (bound == null || bound === '') {
        findings.push({
          category: 'missing_role',
          severity: 'error',
          message: `A(z) '${role.key}' role-hoz nincs kötés (roleBindings).`,
        })
      }
      if (role.type === 'agent_role') {
        const available = new Set(input.roleCapabilities[role.key] ?? [])
        for (const cap of role.requiredCapabilities ?? []) {
          if (!available.has(cap)) {
            findings.push({
              category: 'missing_capability',
              severity: 'error',
              message: `A(z) '${role.key}' role-nak hiányzik a(z) '${cap}' capability-je (connector grant / tool broker).`,
            })
          }
        }
      }
    }

    // --- 2. approval-gate-ek + escalation-út -----------------------------
    for (const gate of input.compiled.gates) {
      if (!gate.blocking) continue
      findings.push({
        category: 'approval_gate',
        severity: 'info',
        gateId: gate.gateId,
        stepId: gate.stepId,
        message: `Blocking ${gate.type} kapu a(z) '${gate.stepId}' lépésnél${
          gate.requiredActorRole ? ` — jóváhagyó: '${gate.requiredActorRole}'` : ''
        }.`,
      })
    }

    // --- 3. szimbolikus séta a state machine-en --------------------------
    const walk = this.walk(input)
    for (const stepId of walk.path) {
      if (!input.compiled.ticketRules.some((r) => r.stepId === stepId)) {
        findings.push({
          category: 'unreachable_step',
          severity: 'warning',
          stepId,
          message: `A(z) '${stepId}' lépéshez nincs compiled ticket-szabály.`,
        })
      }
    }

    // --- 4. heurisztikus költség + időbecslés ----------------------------
    let cost = 0
    let minutes = 0
    for (const stepId of walk.path) {
      const rule = input.compiled.ticketRules.find((r) => r.stepId === stepId)
      if (!rule) continue
      const role = roleByKey.get(rule.assignedRole)
      minutes += DEFAULT_STEP_MINUTES
      if (role?.type !== 'agent_role') continue
      const rate = this.pickRate(role.requiredCapabilities ?? [], input.pricing)
      cost +=
        (HEURISTIC_INPUT_TOKENS * rate.inputPerMTokens) / 1_000_000 +
        (HEURISTIC_OUTPUT_TOKENS * rate.outputPerMTokens) / 1_000_000
    }
    minutes += walk.gates.length * DEFAULT_GATE_MINUTES

    return {
      findings,
      expectedPath: walk.path,
      encounteredGates: walk.gates,
      estimatedCostEur: Math.round(cost * 10000) / 10000,
      estimatedDurationMinutes: minutes,
    }
  }

  /**
   * Szimbolikus séta: a decision-lépéseknél az ELSŐ branch outcome-ját injektálja,
   * minden outputContract-mezőt placeholder-rel tölt, `outcome.status='ok'`. Ciklus-
   * védett (visited). await_gate/await_human/complete zárja a sétát.
   */
  private walk(input: SimulateInput): { path: string[]; gates: string[] } {
    const path: string[] = []
    const gates: string[] = []
    const visited = new Set<string>()
    let currentStepId: string | null = input.compiled.entryStepId

    while (currentStepId && !visited.has(currentStepId)) {
      visited.add(currentStepId)
      path.push(currentStepId)
      const step = input.spec.steps.find((s) => s.id === currentStepId)
      const rule = input.compiled.ticketRules.find((r) => r.stepId === currentStepId)
      const payload: Record<string, unknown> = { outcome: { status: 'ok' } }
      for (const field of rule?.outputRequiredFields ?? []) {
        payload[field] = `«${field}»`
      }
      if (step?.decision) {
        const field = step.decision.field ?? 'decision'
        payload[field] = step.decision.branches[0]?.outcome ?? '«decision»'
      }
      const decision = evaluateAdvance(input.compiled, currentStepId, payload)
      if (decision.kind === 'next_step') {
        currentStepId = decision.toStepId
      } else if (decision.kind === 'await_gate') {
        gates.push(decision.gateId)
        currentStepId = null
      } else {
        currentStepId = null
      }
    }
    return { path, gates }
  }

  /** A role capability-i közül a `model:` prefixűre keres tarifát; fallback nulla. */
  private pickRate(
    capabilities: string[],
    pricing?: ModelPricing,
  ): { inputPerMTokens: number; outputPerMTokens: number } {
    const zero = { inputPerMTokens: 0, outputPerMTokens: 0 }
    if (!pricing) return zero
    const modelCap = capabilities.find((c) => c.startsWith('model:'))
    if (modelCap && pricing[modelCap]) return pricing[modelCap]!
    if (pricing['model:standard']) return pricing['model:standard']!
    const first = Object.values(pricing)[0]
    return first ?? zero
  }
}
