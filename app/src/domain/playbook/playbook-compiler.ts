/**
 * PlaybookCompiler (Feature-spec — Playbook §7.1).
 *
 * A publish-tranzakció hívja: a verziózott `spec`-ből DETERMINISZTIKUS `compiled_spec`-et
 * állít elő, amelyet a runtime (`TicketStateMachine`, `ProcessService`) használ. A state
 * machine SOHA nem a draft Playbookot olvassa, hanem a pin-elt verzió compiled specjét (§15).
 *
 * A compiler nem validál — feltételezi, hogy a spec már átment a PlaybookValidatoron.
 */
import type {
  PlaybookSpecV2,
  PlaybookStep,
  ConditionExpression,
} from '@/lib/playbook-v2/spec'

export type CompiledTransition = {
  fromState: string
  toState: string
  allowedActorTypes: Array<'user' | 'agent' | 'system'>
  requiresOutputContract?: boolean
}

export type CompiledTicketRule = {
  stepId: string
  ticketType: string
  assignedRole: string
  allowedTransitions: CompiledTransition[]
}

export type CompiledGate = {
  gateId: string
  stepId: string
  type: string
  blocking: boolean
  blocksTransition?: { fromState: string; toState: string }
  requiredActorRole?: string
  approvalMode: 'single' | 'four_eyes' | 'multi_level'
  criticality?: string
  evidenceRequired: boolean
}

export type CompiledRoutingRule = {
  fromStepId: string
  toStepId?: string
  gateId?: string
  trigger: string
  condition?: ConditionExpression
}

export type CompiledSpec = {
  schemaVersion: string
  playbookVersionId: string | null
  entryStepId: string
  outputRequiredFields: string[]
  ticketRules: CompiledTicketRule[]
  gates: CompiledGate[]
  routingRules: CompiledRoutingRule[]
}

/** Alapértelmezett állapot-ABC, ha a step nem ad `allowedStates`-t. */
const DEFAULT_STATES = ['ready', 'in_progress', 'awaiting_human', 'done', 'failed'] as const

export class PlaybookCompiler {
  compile(spec: PlaybookSpecV2, opts: { playbookVersionId?: string | null } = {}): CompiledSpec {
    const roleByKey = new Map(spec.roles.map((r) => [r.key, r]))
    const gateById = new Map(spec.gates.map((g) => [g.id, g]))

    const ticketRules: CompiledTicketRule[] = spec.steps.map((step) => ({
      stepId: step.id,
      ticketType: step.ticketType,
      assignedRole: step.assignedRole,
      allowedTransitions: this.compileTransitions(step, roleByKey),
    }))

    const gates: CompiledGate[] = []
    for (const step of spec.steps) {
      for (const gateId of step.requiredGateIds ?? []) {
        const gate = gateById.get(gateId)
        if (!gate) continue
        gates.push({
          gateId: gate.id,
          stepId: step.id,
          type: gate.type,
          blocking: gate.blocking,
          // A blocking gate az emberi jóváhagyási átmenetet zárja (awaiting_human → approved)
          blocksTransition: gate.blocking
            ? { fromState: 'awaiting_human', toState: 'approved' }
            : undefined,
          requiredActorRole: gate.requiredActorRole,
          approvalMode: gate.approvalMode ?? 'single',
          criticality: gate.criticality,
          evidenceRequired: gate.evidenceRequired ?? false,
        })
      }
    }

    const routingRules: CompiledRoutingRule[] = []
    for (const step of spec.steps) {
      for (const rule of step.onComplete ?? []) {
        routingRules.push({
          fromStepId: step.id,
          toStepId: rule.nextStepId,
          gateId: rule.gateId,
          trigger: 'step.completed',
          condition: rule.condition,
        })
      }
    }
    // Explicit transitions, amelyeket nem fed le onComplete-ág
    for (const t of spec.transitions) {
      const alreadyCovered = routingRules.some(
        (r) => r.fromStepId === t.fromStepId && r.toStepId === t.toStepId,
      )
      if (!alreadyCovered) {
        routingRules.push({ fromStepId: t.fromStepId, toStepId: t.toStepId, trigger: t.trigger })
      }
    }

    return {
      schemaVersion: spec.schemaVersion,
      playbookVersionId: opts.playbookVersionId ?? null,
      entryStepId: spec.entryStepId,
      outputRequiredFields: spec.outputContract?.requiredFields ?? [],
      ticketRules,
      gates,
      routingRules,
    }
  }

  /**
   * A step `allowedStates`-éből lineáris állapot-láncot épít. Az agent role-os step
   * átmeneteit agent+system, a human role-osét user végezheti. A `done`/`approved`
   * felé tartó átmenet megköveteli az output contractot.
   */
  private compileTransitions(
    step: PlaybookStep,
    roleByKey: Map<string, { type: string }>,
  ): CompiledTransition[] {
    const states = step.allowedStates?.length ? step.allowedStates : [...DEFAULT_STATES]
    const role = roleByKey.get(step.assignedRole)
    const actorTypes: Array<'user' | 'agent' | 'system'> =
      role?.type === 'human_role' ? ['user'] : ['agent', 'system']

    const transitions: CompiledTransition[] = []
    for (let i = 0; i < states.length - 1; i++) {
      const fromState = states[i]
      const toState = states[i + 1]
      // Az output contractot a process terminál-írása (`done`) köti; a `approved`
      // emberi jóváhagyás kapuval védett, nem output-termelő átmenet (§7.1 példa).
      const isTerminalWrite = toState === 'done'
      transitions.push({
        fromState,
        toState,
        allowedActorTypes: actorTypes,
        requiresOutputContract: isTerminalWrite || undefined,
      })
    }
    return transitions
  }
}
