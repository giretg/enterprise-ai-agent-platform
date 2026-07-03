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

/** Egy lépés tipizált input-rése a compiled specben (Folyamat-feature-spec §5, §7). */
export type CompiledInputSlot = {
  name: string
  type: string
  required: boolean
  source: 'config' | 'trigger'
  description?: string
}

export type CompiledTicketRule = {
  stepId: string
  stepName: string
  ticketType: string
  assignedRole: string
  allowedTransitions: CompiledTransition[]
  /** §4.7 sablonos lépés-utasítás; undefined, ha a lépés nem ad meg sablont. */
  instructionTemplate?: string
  /** §4.7 tipizált rések; üres tömb, ha a lépés nem deklarál rést. */
  inputSlots: CompiledInputSlot[]
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
      stepName: step.name,
      ticketType: step.ticketType,
      assignedRole: step.assignedRole,
      allowedTransitions: this.compileTransitions(step, roleByKey),
      instructionTemplate: step.instructionTemplate,
      inputSlots: (step.inputSlots ?? []).map((slot) => ({
        name: slot.name,
        type: slot.type,
        required: slot.required,
        source: slot.source,
        description: slot.description,
      })),
    }))

    const gates: CompiledGate[] = []
    const addCompiledGate = (gateId: string, stepId: string) => {
      const gate = gateById.get(gateId)
      if (!gate) return
      if (gates.some((g) => g.gateId === gate.id && g.stepId === stepId)) return
      gates.push({
        gateId: gate.id,
        stepId,
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

    for (const step of spec.steps) {
      for (const gateId of step.requiredGateIds ?? []) {
        addCompiledGate(gateId, step.id)
      }
      for (const rule of step.onComplete ?? []) {
        if (rule.gateId) addCompiledGate(rule.gateId, step.id)
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
