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
  PlaybookDeliverable,
  ConditionExpression,
  StepCompletionRule,
  RoutingTarget,
  ErrorRoutes,
  ErrorRoute,
  ErrorPolicy,
} from '@/lib/playbook-v2/spec'
import { STEP_OUTCOME_STATUS_PATH, STEP_OUTCOME_REASON_PATH } from '@/lib/playbook-v2/spec'
import {
  inferStepOutputFields,
  mergeOutputRequiredFields,
  readOutputContractFields,
} from '@/lib/playbook-v2/step-output-inference'

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
  source: 'config' | 'trigger' | 'step'
  description?: string
}

function isErrorRoutesTarget(
  target: RoutingTarget | ErrorRoutes,
): target is ErrorRoutes {
  return 'routes' in target && Array.isArray((target as ErrorRoutes).routes)
}

/**
 * Hibapolicy spec §5.2 / P2 — egy `onError`/`onBlocked` célt reason-kulcsos
 * hiba-utakra és egy opcionális catch-all célra bont szét. A catch-all a mai
 * egyszerű `RoutingTarget`-nek felel meg (`outcome.status` illeszkedés).
 */
export function normalizeErrorTarget(
  target: RoutingTarget | ErrorRoutes | undefined,
): { reasonRoutes: ErrorRoute[]; catchAll: RoutingTarget | null } {
  if (!target) return { reasonRoutes: [], catchAll: null }
  if (isErrorRoutesTarget(target)) {
    const hasCatchAll = target.nextStepId != null || target.gateId != null
    return {
      reasonRoutes: target.routes,
      catchAll: hasCatchAll ? { nextStepId: target.nextStepId, gateId: target.gateId } : null,
    }
  }
  return { reasonRoutes: [], catchAll: target }
}

/**
 * Hibapolicy spec §4.2/WP-4 — a cél (nextStepId/gateId) ténylegesen létezik-e EBBEN a
 * Playbookban. A tenant-default egy TENANT-szintű (nem hash-elt) beállítás, ezért csak akkor
 * használható fel egy adott Playbooknál, ha a hivatkozott step/gate valóban létezik benne —
 * különben csendben kimarad (a végső háló `await_human` marad), a validátor pedig warningot ad.
 */
export function isRoutingTargetResolvable(
  target: RoutingTarget | undefined,
  stepIds: ReadonlySet<string>,
  gateIds: ReadonlySet<string>,
): target is RoutingTarget {
  if (!target) return false
  if (target.nextStepId == null && target.gateId == null) return false
  if (target.nextStepId != null && !stepIds.has(target.nextStepId)) return false
  if (target.gateId != null && !gateIds.has(target.gateId)) return false
  return true
}

/** A step onError/onBlocked célja (catch-all + minden reason-route) által hivatkozott gate-id-k. */
function errorTargetGateIds(target: RoutingTarget | ErrorRoutes | undefined): string[] {
  const { reasonRoutes, catchAll } = normalizeErrorTarget(target)
  const ids: string[] = []
  if (catchAll?.gateId) ids.push(catchAll.gateId)
  for (const route of reasonRoutes) {
    if (route.gateId) ids.push(route.gateId)
  }
  return ids
}

/**
 * Hibapolicy spec §5.3 / P2 — egy step lépés-szintű `onError`/`onBlocked` céljából
 * routing-élt (éleket) bocsát ki: minden reason-kulcsos route ELŐSZÖR (magasabb
 * prioritás, mert az `evaluateAdvance` a hiba-éleket beszúrási sorrendben nézi),
 * majd a catch-all (status-alapú) él, HA a wrapper adott ilyet.
 */
function pushStepErrorRoutingRules(
  routingRules: CompiledRoutingRule[],
  stepId: string,
  target: RoutingTarget | ErrorRoutes | undefined,
  statusValue: 'failed' | 'blocked',
  edgeType: 'error' | 'blocked',
): void {
  const { reasonRoutes, catchAll } = normalizeErrorTarget(target)
  for (const route of reasonRoutes) {
    routingRules.push({
      fromStepId: stepId,
      toStepId: route.nextStepId,
      gateId: route.gateId,
      trigger: 'step.completed',
      condition: route.reason
        ? { field: STEP_OUTCOME_REASON_PATH, op: '==', value: route.reason }
        : { field: STEP_OUTCOME_STATUS_PATH, op: '==', value: statusValue },
      edgeType,
      outcome: route.reason ?? statusValue,
      errorRouteSource: 'step',
    })
  }
  if (catchAll) {
    routingRules.push({
      fromStepId: stepId,
      toStepId: catchAll.nextStepId,
      gateId: catchAll.gateId,
      trigger: 'step.completed',
      condition: { field: STEP_OUTCOME_STATUS_PATH, op: '==', value: statusValue },
      edgeType,
      outcome: statusValue,
      errorRouteSource: 'step',
    })
  }
}

/**
 * WP-8 §11.2b — a Decision Step sugar-blokk desugarolása `onComplete`-szabályokká.
 * A `branches[]` konkrét feltételes ágakká (`field == outcome`), a `fallback`
 * `default` ággá fordul. Ha nincs `decision`, a nyers `onComplete` marad (visszafelé
 * kompatibilis; ha MINDKETTŐ van, a decision-szabályok kerülnek a nyers onComplete elé).
 */
export function desugarDecision(step: PlaybookStep): StepCompletionRule[] {
  if (!step.decision) return step.onComplete ?? []
  const field = step.decision.field ?? 'decision'
  const rules: StepCompletionRule[] = step.decision.branches.map((b) => ({
    condition: { field, op: '==' as const, value: b.outcome },
    nextStepId: b.nextStepId,
    gateId: b.gateId,
  }))
  if (step.decision.fallback) {
    rules.push({
      condition: 'default',
      nextStepId: step.decision.fallback.nextStepId,
      gateId: step.decision.fallback.gateId,
    })
  }
  // A kézzel írt onComplete-szabályok a decision után (ritka; a decision az elsődleges).
  return [...rules, ...(step.onComplete ?? [])]
}

/** A step effektív happy-path routing-szabályai (decision desugar VAGY nyers onComplete). */
function effectiveOnComplete(step: PlaybookStep): StepCompletionRule[] {
  return desugarDecision(step)
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
  /** Lépés szintű kötelező kimeneti mezők (outputContract + routing-következtetés). */
  outputRequiredFields: string[]
  /** §4.7b — a lépés valódi fájl-deliverable-t termel; undefined, ha nem. */
  deliverable?: PlaybookDeliverable
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

/** Egy routing-él fajtája — trace/simulation/audit olvashatósághoz (WP-7/WP-8). */
export type RoutingEdgeType = 'happy' | 'default' | 'decision' | 'error' | 'blocked' | 'transition'

/** Hiba-él (error/blocked) forrása — hibakezelési policy spec §9 audit-mező. */
export type ErrorRouteSource = 'step' | 'playbook_default' | 'tenant_default'

export type CompiledRoutingRule = {
  fromStepId: string
  toStepId?: string
  gateId?: string
  trigger: string
  condition?: ConditionExpression
  /** Az él fajtája (happy/decision/hiba-él). Alap: 'happy'. */
  edgeType?: RoutingEdgeType
  /** A kiválasztott üzleti kimenet címkéje (decision-érték vagy 'failed'/'blocked') — audithoz. */
  outcome?: string
  /** Csak error/blocked éleken: lépés-szintű explicit vagy Playbook-default (hibapolicy spec §9). */
  errorRouteSource?: ErrorRouteSource
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

/**
 * Alapértelmezett állapot-ABC, ha a step nem ad `allowedStates`-t.
 * A Prisma `TicketState` enumhoz igazítva (nincs 'failed' állapot — a terminális
 * negatív állapot 'rejected').
 */
const DEFAULT_STATES_AGENT = ['ready', 'in_progress', 'done', 'rejected'] as const
const DEFAULT_STATES_HUMAN = ['ready', 'in_progress', 'awaiting_human', 'done', 'rejected'] as const

export class PlaybookCompiler {
  compile(
    spec: PlaybookSpecV2,
    opts: {
      playbookVersionId?: string | null
      /**
       * Hibapolicy spec §4.2/WP-4 — publish-időben feloldott tenant-szintű alapértelmezés.
       * NEM a hash-elt spec része (a `defaultErrorPolicy`-val ellentétben); a hívó
       * (`PlaybookV2Service.publishPlaybookVersion`) tölti a `PlatformSettingsService`-ből.
       * Csak azokon az ágakon lép életbe, ahol a Playbooknak SEM lépés-, SEM Playbook-szintű
       * defaultja nincs, és csak ha a célja ténylegesen létezik ebben a Playbookban.
       */
      tenantDefaultErrorPolicy?: ErrorPolicy
    } = {},
  ): CompiledSpec {
    const roleByKey = new Map(spec.roles.map((r) => [r.key, r]))
    const gateById = new Map(spec.gates.map((g) => [g.id, g]))
    const stepIds = new Set(spec.steps.map((s) => s.id))
    const gateIds = new Set(spec.gates.map((g) => g.id))
    const inferredOutputs = inferStepOutputFields(spec)

    /**
     * A lépés effektív default hiba-ága (P1 Playbook-default ELŐBB, mint a WP-4
     * tenant-default), csak akkor, ha a lépésnek NINCS saját onError/onBlocked-je.
     * `null`, ha se lépés-, se Playbook-, se (érvényes) tenant-default nincs — ekkor a
     * runtime a beégetett `await_human` végső hálóra esik (TE-3, változatlan).
     */
    const effectiveDefault = (
      ownTarget: RoutingTarget | ErrorRoutes | undefined,
      playbookDefault: RoutingTarget | undefined,
      tenantDefault: RoutingTarget | undefined,
    ): { target: RoutingTarget; source: ErrorRouteSource } | null => {
      if (ownTarget) return null
      if (playbookDefault) return { target: playbookDefault, source: 'playbook_default' }
      if (isRoutingTargetResolvable(tenantDefault, stepIds, gateIds)) {
        return { target: tenantDefault, source: 'tenant_default' }
      }
      return null
    }

    const ticketRules: CompiledTicketRule[] = spec.steps.map((step) => {
      const stepGateIds = [
        ...(step.requiredGateIds ?? []),
        ...effectiveOnComplete(step).flatMap((r) => (r.gateId ? [r.gateId] : [])),
        ...errorTargetGateIds(step.onError),
        ...errorTargetGateIds(step.onBlocked),
      ]
      const hasGate = stepGateIds.length > 0
      return {
      stepId: step.id,
      stepName: step.name,
      ticketType: step.ticketType,
      assignedRole: step.assignedRole,
      allowedTransitions: this.compileTransitions(
        step,
        roleByKey,
        hasGate,
        mergeOutputRequiredFields(
          readOutputContractFields(step.outputContract),
          inferredOutputs.get(step.id),
        ),
        readOutputContractFields(spec.outputContract),
      ),
      instructionTemplate: step.instructionTemplate,
      inputSlots: (step.inputSlots ?? []).map((slot) => ({
        name: slot.name,
        type: slot.type,
        required: slot.required,
        source: slot.source,
        description: slot.description,
      })),
      outputRequiredFields: mergeOutputRequiredFields(
        readOutputContractFields(step.outputContract),
        inferredOutputs.get(step.id),
      ),
      deliverable: step.deliverable,
      }
    })

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
      const effectiveRules = effectiveOnComplete(step)
      for (const gateId of step.requiredGateIds ?? []) {
        addCompiledGate(gateId, step.id)
      }
      for (const rule of effectiveRules) {
        if (rule.gateId) addCompiledGate(rule.gateId, step.id)
      }
      // WP-7 §10.2 / hibapolicy spec §5.2 — az onError/onBlocked (catch-all ÉS
      // reason-kulcsos route-ok) hiba-él gate-céljai is compiled gate-ek.
      for (const target of [step.onError, step.onBlocked]) {
        for (const gateId of errorTargetGateIds(target)) addCompiledGate(gateId, step.id)
      }
      // Hibapolicy spec §4.3 / P1 + §4.2 / WP-4 — Playbook- ill. tenant-default hiba-él
      // gate-célja, csak ha a lépésnek NINCS saját onError/onBlocked (lépés-szint elsőbbséget
      // élvez, a Playbook-default pedig a tenant-default előtt).
      const errDefault = effectiveDefault(
        step.onError,
        spec.defaultErrorPolicy?.onError,
        opts.tenantDefaultErrorPolicy?.onError,
      )
      if (errDefault?.target.gateId) addCompiledGate(errDefault.target.gateId, step.id)
      const blockedDefault = effectiveDefault(
        step.onBlocked,
        spec.defaultErrorPolicy?.onBlocked,
        opts.tenantDefaultErrorPolicy?.onBlocked,
      )
      if (blockedDefault?.target.gateId) addCompiledGate(blockedDefault.target.gateId, step.id)
    }

    const routingRules: CompiledRoutingRule[] = []
    for (const step of spec.steps) {
      // WP-7 §10.2 / hibapolicy spec §5.3 — a hiba-élek ELŐSZÖR (magasabb prioritás az
      // evaluateAdvance-ban): reason-specifikus → status catch-all → Playbook-default.
      if (step.onError) {
        pushStepErrorRoutingRules(routingRules, step.id, step.onError, 'failed', 'error')
      } else {
        // Hibapolicy spec §4.3 / P1 + §4.2 / WP-4 — Playbook-default ELŐBB, tenant-default
        // csak ha se lépés-, se Playbook-default nincs (a beszúrási sorrend biztosítja, hogy
        // a runtime evaluateAdvance-ja ELŐSZÖR a lépés-szintűt találná, ha lenne).
        const def = effectiveDefault(undefined, spec.defaultErrorPolicy?.onError, opts.tenantDefaultErrorPolicy?.onError)
        if (def) {
          routingRules.push({
            fromStepId: step.id,
            toStepId: def.target.nextStepId,
            gateId: def.target.gateId,
            trigger: 'step.completed',
            condition: { field: STEP_OUTCOME_STATUS_PATH, op: '==', value: 'failed' },
            edgeType: 'error',
            outcome: 'failed',
            errorRouteSource: def.source,
          })
        }
      }
      if (step.onBlocked) {
        pushStepErrorRoutingRules(routingRules, step.id, step.onBlocked, 'blocked', 'blocked')
      } else {
        const def = effectiveDefault(undefined, spec.defaultErrorPolicy?.onBlocked, opts.tenantDefaultErrorPolicy?.onBlocked)
        if (def) {
          routingRules.push({
            fromStepId: step.id,
            toStepId: def.target.nextStepId,
            gateId: def.target.gateId,
            trigger: 'step.completed',
            condition: { field: STEP_OUTCOME_STATUS_PATH, op: '==', value: 'blocked' },
            edgeType: 'blocked',
            outcome: 'blocked',
            errorRouteSource: def.source,
          })
        }
      }
      // WP-8 §11.2b — decision-blokk desugar; egyébként a nyers onComplete.
      const decisionOutcomes = new Set((step.decision?.branches ?? []).map((b) => b.outcome))
      for (const rule of effectiveOnComplete(step)) {
        const isFallback = rule.condition === 'default'
        const outcome =
          step.decision && rule.condition !== 'default' && rule.condition.field === (step.decision.field ?? 'decision')
            ? String(rule.condition.value)
            : undefined
        routingRules.push({
          fromStepId: step.id,
          toStepId: rule.nextStepId,
          gateId: rule.gateId,
          trigger: 'step.completed',
          condition: rule.condition,
          edgeType: isFallback ? 'default' : step.decision ? 'decision' : 'happy',
          outcome: outcome && decisionOutcomes.has(outcome) ? outcome : undefined,
        })
      }
    }
    // Explicit transitions, amelyeket nem fed le onComplete-ág
    for (const t of spec.transitions) {
      const alreadyCovered = routingRules.some(
        (r) => r.fromStepId === t.fromStepId && r.toStepId === t.toStepId,
      )
      if (!alreadyCovered) {
        routingRules.push({
          fromStepId: t.fromStepId,
          toStepId: t.toStepId,
          trigger: t.trigger,
          edgeType: 'transition',
        })
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
    hasGate = false,
    stepOutputFields: string[] = [],
    globalOutputFields: string[] = [],
  ): CompiledTransition[] {
    const role = roleByKey.get(step.assignedRole)
    const isHumanRole = role?.type === 'human_role'
    const actorTypes: Array<'user' | 'agent' | 'system'> = isHumanRole ? ['user'] : ['agent', 'system']
    // Agent-lépéseknél az awaiting_human csak akkor kerül be az alapértelmezett
    // láncba, ha a lépéshez gate van rendelve (emberi jóváhagyás szükséges).
    const needsAwaitingHuman = isHumanRole || hasGate
    const defaultStates = needsAwaitingHuman ? [...DEFAULT_STATES_HUMAN] : [...DEFAULT_STATES_AGENT]
    const states = step.allowedStates?.length ? step.allowedStates : defaultStates

    const transitions: CompiledTransition[] = []
    for (let i = 0; i < states.length - 1; i++) {
      const fromState = states[i]
      const toState = states[i + 1]
      // Az output contractot a process terminál-írása (`done`) köti; a `approved`
      // emberi jóváhagyás kapuval védett, nem output-termelő átmenet (§7.1 példa).
      const isTerminalWrite = toState === 'done'
      const outputFields =
        stepOutputFields.length > 0 ? stepOutputFields : globalOutputFields
      transitions.push({
        fromState,
        toState,
        allowedActorTypes: actorTypes,
        requiresOutputContract:
          isTerminalWrite && outputFields.length > 0 ? true : undefined,
      })
    }
    return transitions
  }
}
