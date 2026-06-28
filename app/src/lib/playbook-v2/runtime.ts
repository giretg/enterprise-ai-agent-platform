/**
 * Fázis 2 Playbook RUNTIME-mag — determinisztikus állapotgép-kiértékelő
 * (Feature-spec — Playbook §7.2, §7.3, §2.4, §2.5).
 *
 * Ez a TISZTA, DB- és LLM-mentes döntési réteg, amelyet a `TicketStateMachine`
 * (§8.3) és a `ProcessService.advance` (§8.2) hív. A motor SOHA nem a draft
 * Playbookot olvassa, hanem a pin-elt verzió `compiled_spec`-jét (§15, P9):
 *   - `evaluateTicketTransition` → engedélyezett-e a `(stepId, from→to, actor)` átmenet,
 *     blokkolja-e kötelező kapu, teljesül-e az output contract (§7.2 4–6. lépés);
 *   - `evaluateAdvance` → mi a következő step / kapu / process-vég a befejezett step
 *     `onComplete` / routing szabályai alapján (§7.3).
 *
 * KRITIKUS invariáns (§2.5, §11.3, P6): az agent kimenete SOHA nem léphet át blocking
 * kapu által zárt átmenetet. A motor a `compiled_spec` alapján dönt, nem a prompt alapján.
 */
import type { CompiledSpec, CompiledGate, CompiledRoutingRule } from '@/domain/playbook/playbook-compiler'
import type { ConditionExpression, ConditionOp } from '@/lib/playbook-v2/spec'

export type RuntimeActorType = 'user' | 'agent' | 'system'

export type RuntimeActor = {
  type: RuntimeActorType
  /** A szereplő RBAC-role kulcsai; ha megadva, a kapu requiredActorRole-ját kényszerítjük. */
  roles?: string[]
}

// --- §7.2 ticket transition enforcement -----------------------------------

export type TransitionDenyCode =
  | 'STEP_NOT_FOUND'
  | 'TRANSITION_NOT_ALLOWED'
  | 'ACTOR_NOT_ALLOWED'
  | 'GATE_BYPASS_DENIED'
  | 'GATE_ACTOR_ROLE'
  | 'GATE_EVIDENCE_REQUIRED'
  | 'OUTPUT_CONTRACT_VIOLATION'

export type TransitionDecision =
  | { allowed: true; gate?: CompiledGate; requiresOutputContract: boolean }
  | {
      allowed: false
      denyCode: TransitionDenyCode
      reason: string
      /** §13.1 / P6 — külön jelöljük a kapumegkerülési kísérletet (gate.bypass_denied audit). */
      gateBypassDenied?: boolean
      gate?: CompiledGate
      /** Output contractnál: a hiányzó kötelező mezők. */
      missingFields?: string[]
    }

export type TransitionInput = {
  stepId: string
  fromState: string
  toState: string
  actor: RuntimeActor
  outputPayload?: Record<string, unknown>
  approvalEvidence?: Record<string, unknown>
}

/**
 * §7.2 4–6. lépés DETERMINISZTIKUS magja. A tenant-scope, ticket-betöltés és
 * tranzakciós állapotváltás (1–3., 8.) a hívó `TicketStateMachine` dolga.
 */
export function evaluateTicketTransition(
  compiled: CompiledSpec,
  input: TransitionInput,
): TransitionDecision {
  const rule = compiled.ticketRules.find((r) => r.stepId === input.stepId)
  if (!rule) {
    return {
      allowed: false,
      denyCode: 'STEP_NOT_FOUND',
      reason: `Nincs compiled ticket-szabály a(z) '${input.stepId}' stephez.`,
    }
  }

  // §7.2.5 — a kötelező kaput ELŐSZÖR értékeljük: a kapumegkerülés (P6) a specifikusabb,
  // biztonsági DENY, és akkor is érvényes, ha az actor a transition-láncban amúgy nem
  // szerepelne. Az agent/system kimenete SOHA nem léphet át blocking emberi kaput (§2.5).
  const blockingGate = findBlockingGate(compiled, input.stepId, input.fromState, input.toState)
  if (blockingGate) {
    const decision = gateDecision(blockingGate, input)
    if (!decision.allowed) return decision
  }

  // §7.2.4 — a (from→to) átmenetnek szerepelnie kell a compiled state machine-ben.
  const transition = rule.allowedTransitions.find(
    (t) => t.fromState === input.fromState && t.toState === input.toState,
  )
  // Routing-kapuknál a jóváhagyási ticket a befejezett stephez tartozik, de nem
  // része az adott step normál agent-állapotláncának. Ha a blocking gate már
  // átengedte az emberi jóváhagyót, ez a gate-ticket átmenet engedélyezett.
  if (!transition && blockingGate && input.actor.type === 'user') {
    return { allowed: true, gate: blockingGate, requiresOutputContract: false }
  }
  if (!transition) {
    return {
      allowed: false,
      denyCode: 'TRANSITION_NOT_ALLOWED',
      reason: `A(z) '${input.fromState}' → '${input.toState}' átmenet nem engedélyezett a(z) '${input.stepId}' stepen.`,
    }
  }

  // §7.2.4 — actor-típus jogosultság.
  if (!transition.allowedActorTypes.includes(input.actor.type)) {
    return {
      allowed: false,
      denyCode: 'ACTOR_NOT_ALLOWED',
      reason: `A(z) '${input.actor.type}' actor nem hajthatja végre ezt az átmenetet.`,
    }
  }

  // §7.2.6 — output contract (csak ha az átmenet megköveteli).
  if (transition.requiresOutputContract && compiled.outputRequiredFields.length > 0) {
    const missing = missingOutputFields(compiled.outputRequiredFields, input.outputPayload)
    if (missing.length > 0) {
      return {
        allowed: false,
        denyCode: 'OUTPUT_CONTRACT_VIOLATION',
        reason: `Hiányzó kötelező output mezők: ${missing.join(', ')}.`,
        missingFields: missing,
      }
    }
  }

  return {
    allowed: true,
    gate: blockingGate,
    requiresOutputContract: transition.requiresOutputContract === true,
  }
}

/** A stephez tartozó, az adott átmenetet záró blocking kapu (ha van). */
function findBlockingGate(
  compiled: CompiledSpec,
  stepId: string,
  fromState: string,
  toState: string,
): CompiledGate | undefined {
  return compiled.gates.find(
    (g) =>
      g.stepId === stepId &&
      g.blocking &&
      g.blocksTransition?.fromState === fromState &&
      g.blocksTransition?.toState === toState,
  )
}

/** Kapu-engedélyezés: csak emberi, megfelelő role-ú, (ha kell) bizonyítékot adó actor mehet át. */
function gateDecision(gate: CompiledGate, input: TransitionInput): TransitionDecision {
  // §2.5 / §11.3 / P6 — agent vagy system SOHA nem léphet át emberi/kötelező kaput.
  if (input.actor.type !== 'user') {
    return {
      allowed: false,
      denyCode: 'GATE_BYPASS_DENIED',
      reason: `A(z) '${gate.gateId}' kötelező kaput csak ember hagyhatja jóvá; '${input.actor.type}' actor nem.`,
      gateBypassDenied: true,
      gate,
    }
  }

  // §6 / §11.1 / P8 — ha ismert a kapu requiredActorRole-ja és az actor role-jai, kötelező az egyezés.
  if (gate.requiredActorRole && input.actor.roles && !input.actor.roles.includes(gate.requiredActorRole)) {
    return {
      allowed: false,
      denyCode: 'GATE_ACTOR_ROLE',
      reason: `A jóváhagyáshoz '${gate.requiredActorRole}' role kell.`,
      gate,
    }
  }

  // §11.2 — evidenceRequired esetén bizonyíték kötelező.
  if (gate.evidenceRequired && !hasEvidence(input.approvalEvidence)) {
    return {
      allowed: false,
      denyCode: 'GATE_EVIDENCE_REQUIRED',
      reason: `A(z) '${gate.gateId}' kapuhoz jóváhagyási bizonyíték szükséges.`,
      gate,
    }
  }

  return { allowed: true, gate, requiresOutputContract: false }
}

function hasEvidence(evidence?: Record<string, unknown>): boolean {
  return evidence != null && Object.keys(evidence).length > 0
}

function missingOutputFields(required: string[], payload?: Record<string, unknown>): string[] {
  const data = payload ?? {}
  return required.filter((field) => {
    const value = readPath(data, field)
    return value === undefined || value === null
  })
}

// --- §7.3 process advance routing -----------------------------------------

export type AdvanceDecision =
  | { kind: 'next_step'; toStepId: string; rule: CompiledRoutingRule }
  | { kind: 'await_gate'; gateId: string; rule: CompiledRoutingRule }
  | { kind: 'complete' }

/**
 * §7.3 — a befejezett step `onComplete` / routing szabályaiból DETERMINISZTIKUSAN
 * kiválasztja a következő lépést. A feltételes ágakat a `result_payload` ellen
 * értékeli; a `default` (vagy feltétel nélküli) ág a végső fallback. Ha egyik ág
 * sem illeszkedik és nincs fallback, a folyamat befejezett (terminál step).
 */
export function evaluateAdvance(
  compiled: CompiledSpec,
  completedStepId: string,
  resultPayload: Record<string, unknown> = {},
): AdvanceDecision {
  const rules = compiled.routingRules.filter((r) => r.fromStepId === completedStepId)
  if (rules.length === 0) {
    return { kind: 'complete' }
  }

  // Először a konkrét feltételes ágak, utoljára a default/feltétel nélküli fallback.
  const conditional = rules.filter((r) => r.condition != null && r.condition !== 'default')
  const fallbacks = rules.filter((r) => r.condition == null || r.condition === 'default')

  for (const rule of conditional) {
    if (evaluateCondition(rule.condition!, resultPayload)) {
      return toDecision(rule)
    }
  }
  if (fallbacks.length > 0) {
    return toDecision(fallbacks[0])
  }

  // Volt feltételes ág, de egyik sem illeszkedett és nincs fallback → nincs továbblépés.
  return { kind: 'complete' }
}

function toDecision(rule: CompiledRoutingRule): AdvanceDecision {
  if (rule.gateId) {
    return { kind: 'await_gate', gateId: rule.gateId, rule }
  }
  if (rule.toStepId) {
    return { kind: 'next_step', toStepId: rule.toStepId, rule }
  }
  return { kind: 'complete' }
}

// --- Feltétel-kiértékelés (§5 ConditionExpression) ------------------------

/** Determinisztikus feltétel-kiértékelés a payload ellen. `default` → mindig igaz. */
export function evaluateCondition(
  condition: ConditionExpression,
  payload: Record<string, unknown>,
): boolean {
  if (condition === 'default') return true
  const actual = readPath(payload, condition.field)
  return compare(actual, condition.op, condition.value)
}

function compare(actual: unknown, op: ConditionOp, expected: string | number | boolean): boolean {
  switch (op) {
    case '==':
      return actual === expected
    case '!=':
      return actual !== expected
    case '>=':
    case '<=':
    case '>':
    case '<': {
      if (typeof actual !== 'number' || typeof expected !== 'number') return false
      if (op === '>=') return actual >= expected
      if (op === '<=') return actual <= expected
      if (op === '>') return actual > expected
      return actual < expected
    }
    default:
      return false
  }
}

/** Pont-elérési útvonal olvasása (`a.b.c`); a sima mezőnevek is működnek. */
function readPath(obj: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path]
  let current: unknown = obj
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

// --- §13 / P12 actual flow rekonstrukció ------------------------------------

export type ActualFlowEdge = {
  fromStepId: string
  toStepId: string
  fromActorType: string
  /** Szerepel-e a szándékolt compiled_spec routingban (P12 összehasonlítás). */
  inIntended: boolean
}

export type ActualFlowStep = {
  stepId: string
  status: string
  /** Szerepel-e a szándékolt compiled_spec ticketRules-ban. */
  inIntended: boolean
}

export type ActualFlowDeviation = {
  type: 'UNEXPECTED_EDGE' | 'UNEXPECTED_STEP'
  detail: string
}

export type ActualFlowResult = {
  actualEdges: ActualFlowEdge[]
  executedSteps: ActualFlowStep[]
  deviations: ActualFlowDeviation[]
  /** True ha az összes él és step a szándékolt compiled_spec-ben van (auditból reprodukálható, P12). */
  reproducible: boolean
}

/**
 * §13 / P12 — a ténylegesen lefutott folyamatot (delegation_edge-ek + step-státuszok)
 * összehasonlítja a pin-elt compiled_spec szándékolt routingával.
 *
 * A hívónak a pin-elt `compiled_spec`-et kell átadni (NEM a draftot), hogy a
 * historikus összehasonlítás a futás pillanatában érvényes Playbookkal történjen.
 */
export function reconstructActualFlow(
  steps: Array<{ stepId: string; status: string; assignedRole?: string }>,
  delegations: Array<{ fromStepId: string; toStepId: string; fromActorType: string }>,
  compiled: CompiledSpec,
): ActualFlowResult {
  const intendedRoutes = new Set(
    compiled.routingRules
      .filter((r) => r.toStepId)
      .map((r) => `${r.fromStepId}→${r.toStepId}`),
  )
  const intendedStepIds = new Set(compiled.ticketRules.map((r) => r.stepId))

  const actualEdges: ActualFlowEdge[] = delegations.map((d) => ({
    fromStepId: d.fromStepId,
    toStepId: d.toStepId,
    fromActorType: d.fromActorType,
    inIntended: intendedRoutes.has(`${d.fromStepId}→${d.toStepId}`),
  }))

  const executedSteps: ActualFlowStep[] = steps.map((s) => ({
    stepId: s.stepId,
    status: s.status,
    inIntended: intendedStepIds.has(s.stepId),
  }))

  const deviations: ActualFlowDeviation[] = []
  for (const edge of actualEdges) {
    if (!edge.inIntended) {
      deviations.push({
        type: 'UNEXPECTED_EDGE',
        detail: `Nem tervezett átmenet: ${edge.fromStepId} → ${edge.toStepId} (${edge.fromActorType})`,
      })
    }
  }
  for (const step of executedSteps) {
    if (!step.inIntended) {
      deviations.push({
        type: 'UNEXPECTED_STEP',
        detail: `Nem tervezett lépés futott: ${step.stepId}`,
      })
    }
  }

  return {
    actualEdges,
    executedSteps,
    deviations,
    reproducible: deviations.length === 0,
  }
}
