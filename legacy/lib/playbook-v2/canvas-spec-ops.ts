/**
 * Governed Flow Builder — canvas → spec mutáló műveletek (WP-2, D1).
 *
 * Minden szerkesztő-művelet (paletta, drag-connect, törlés) a kanonikus `spec`-et írja,
 * hogy a canvas mindig a valós, verziózható/hash-elhető szerkezetet állítsa elő. A node
 * ARRÉBB HÚZÁSA nem itt történik — az csak `layout` (D2), a spec-et nem érinti.
 */
import type { RawGate, RawStep } from '@/components/playbooks/playbook-flow-graph'
import type { PlaybookDraftSpec } from '@/components/playbooks/playbook-spec-shared'
import { syncPlaybookSpecInputSlots } from '@/components/playbooks/playbook-spec-shared'
import { upsertRoleType } from '@/lib/playbook-v2/role-sync'
import { uniqueId, START_NODE_ID, END_NODE_ID } from '@/lib/playbook-v2/canvas-mapping'
import type { PlaybookRole } from '@/lib/playbook-v2/spec'

function clone(spec: PlaybookDraftSpec): PlaybookDraftSpec {
  return structuredClone(spec)
}

function allNodeIds(spec: PlaybookDraftSpec): string[] {
  return [
    ...(spec.steps ?? []).map((s) => s.id).filter(Boolean),
    ...(spec.gates ?? []).map((g) => g.id).filter(Boolean),
  ] as string[]
}

export type AddResult = { spec: PlaybookDraftSpec; id: string }

/** Új agent- vagy ember-lépés a specbe (a hozzá tartozó role-t is felveszi). */
export function addStep(
  spec: PlaybookDraftSpec,
  kind: 'agent' | 'human' | 'decision',
): AddResult {
  const next = clone(spec)
  next.steps = next.steps ?? []
  next.roles = next.roles ?? []

  const id = uniqueId(kind === 'decision' ? 'decision' : kind === 'human' ? 'human_task' : 'step', allNodeIds(next))
  const roleKey = uniqueId(
    kind === 'human' ? 'reviewer' : kind === 'decision' ? 'classifier' : 'worker',
    (next.roles as PlaybookRole[]).map((r) => r.key),
  )
  const roleType = kind === 'human' ? 'human_role' : 'agent_role'

  const step: RawStep =
    kind === 'human'
      ? {
          id,
          name: 'Emberi feladat',
          ticketType: 'human_task',
          assignedRole: roleKey,
          allowedStates: ['awaiting_human', 'approved'],
        }
      : kind === 'decision'
        ? {
            id,
            name: 'Döntési lépés',
            ticketType: 'agent_task',
            assignedRole: roleKey,
            outputContract: { requiredFields: ['decision', 'confidence', 'evidence'] },
          }
        : {
            id,
            name: 'Új lépés',
            ticketType: 'agent_task',
            assignedRole: roleKey,
          }

  next.steps.push(step)
  next.roles = upsertRoleType(next.roles as PlaybookRole[], roleKey, roleType)

  // Ha ez az első lépés, legyen a belépő.
  if (!next.entryStepId && next.steps.length === 1) {
    ;(next as { entryStepId?: string }).entryStepId = id
  }
  return { spec: next, id }
}

/** Új jóváhagyási kapu a specbe. */
export function addGate(spec: PlaybookDraftSpec): AddResult {
  const next = clone(spec)
  next.gates = next.gates ?? []
  const id = uniqueId('approval', allNodeIds(next))
  const gate: RawGate = {
    id,
    type: 'human_approval',
    blocking: true,
  }
  next.gates.push(gate)
  return { spec: next, id }
}

/**
 * StepTemplate-fragment beszúrása (WP-3): a `__PLACEHOLDER__` id-t egyedivé teszi, a
 * `__ROLE__` placeholder role-t felveszi (a felhasználónak kell valós role-hoz kötnie),
 * az opcionális gate-et is beszúrja. A template SOHA nem ad tool-jogot (D3).
 */
export function insertTemplateFragment(
  spec: PlaybookDraftSpec,
  fragment: { step?: Record<string, unknown>; suggestedGate?: Record<string, unknown> | null },
): AddResult {
  const next = clone(spec)
  next.steps = next.steps ?? []
  next.gates = next.gates ?? []
  next.roles = next.roles ?? []

  const rawStep = { ...(fragment.step ?? {}) } as RawStep & { requiredCapabilities?: string[] }
  const baseId = typeof rawStep.name === 'string' ? rawStep.name : 'step'
  const stepId = uniqueId(String(baseId), allNodeIds(next))
  rawStep.id = stepId

  // Role placeholder feloldása: felveszünk egy egyedi role-kulcsot, agent típussal.
  const suggestedCaps = Array.isArray(rawStep.requiredCapabilities) ? rawStep.requiredCapabilities : undefined
  const roleKey = uniqueId(`${stepId}_role`, (next.roles as PlaybookRole[]).map((r) => r.key))
  rawStep.assignedRole = roleKey
  delete rawStep.requiredCapabilities
  next.roles = upsertRoleType(next.roles as PlaybookRole[], roleKey, 'agent_role', suggestedCaps)

  // Ajánlott gate → egyedi id, a step requiredGateIds-jébe kötve.
  if (fragment.suggestedGate) {
    const rawGate = { ...(fragment.suggestedGate as Record<string, unknown>) } as RawGate
    const gateId = uniqueId(String(rawGate.id ?? `${stepId}_gate`), allNodeIds(next))
    rawGate.id = gateId
    next.gates.push(rawGate)
    rawStep.requiredGateIds = [...(rawStep.requiredGateIds ?? []), gateId]
  }

  next.steps.push(rawStep)
  if (!next.entryStepId && next.steps.length === 1) {
    ;(next as { entryStepId?: string }).entryStepId = stepId
  }
  return { spec: syncPlaybookSpecInputSlots(next), id: stepId }
}

/**
 * Drag-connect: él húzása két node között.
 * - start → step: belépő lépés beállítása.
 * - step → step: default onComplete routing (nextStepId).
 * - step → gate: kötelező kapu (requiredGateIds).
 * - bármi → end: nincs spec-hatás (vizuális nyelő).
 */
export function connectNodes(
  spec: PlaybookDraftSpec,
  source: string,
  target: string,
): PlaybookDraftSpec {
  if (target === END_NODE_ID || target === START_NODE_ID) return spec
  const next = clone(spec)
  const steps = next.steps ?? []
  const gates = next.gates ?? []
  const isStep = (id: string) => steps.some((s) => s.id === id)
  const isGate = (id: string) => gates.some((g) => g.id === id)

  if (source === START_NODE_ID) {
    if (isStep(target)) (next as { entryStepId?: string }).entryStepId = target
    return next
  }

  const src = steps.find((s) => s.id === source)
  if (!src) return spec

  if (isGate(target)) {
    src.requiredGateIds = [...new Set([...(src.requiredGateIds ?? []), target])]
    return next
  }

  if (isStep(target)) {
    src.onComplete = src.onComplete ?? []
    const exists = src.onComplete.some(
      (r) => r.nextStepId === target && (r.condition == null || r.condition === 'default'),
    )
    if (!exists) src.onComplete.push({ condition: 'default', nextStepId: target })
    return next
  }
  return spec
}

/** Egy él törlése a spec-ből a származása (provenance) alapján. */
export function deleteEdgeFromSpec(
  spec: PlaybookDraftSpec,
  edge: { source: string; kind: string; ruleIndex?: number; transitionIndex?: number; fromRequiredGate?: boolean; target: string },
): PlaybookDraftSpec {
  const next = clone(spec)
  if (edge.kind === 'entry' || edge.kind === 'end') return spec

  if (edge.fromRequiredGate || edge.kind === 'requires') {
    const src = (next.steps ?? []).find((s) => s.id === edge.source)
    if (src) src.requiredGateIds = (src.requiredGateIds ?? []).filter((g) => g !== edge.target)
    return next
  }

  if (edge.transitionIndex != null) {
    const transitions = Array.isArray(next.transitions) ? (next.transitions as unknown[]) : []
    next.transitions = transitions.filter((_, i) => i !== edge.transitionIndex)
    return next
  }

  if (edge.ruleIndex != null) {
    const src = (next.steps ?? []).find((s) => s.id === edge.source)
    if (src && src.onComplete) {
      src.onComplete = src.onComplete.filter((_, i) => i !== edge.ruleIndex)
      if (src.onComplete.length === 0) delete src.onComplete
    }
    return next
  }
  return spec
}

/** Node (step vagy gate) törlése minden ráhivatkozó referenciával együtt. */
export function deleteNodeFromSpec(spec: PlaybookDraftSpec, id: string): PlaybookDraftSpec {
  if (id === START_NODE_ID || id === END_NODE_ID) return spec
  const next = clone(spec)
  const wasStep = (next.steps ?? []).some((s) => s.id === id)

  next.steps = (next.steps ?? []).filter((s) => s.id !== id)
  next.gates = (next.gates ?? []).filter((g) => g.id !== id)

  // Referenciák tisztítása
  for (const s of next.steps) {
    s.requiredGateIds = (s.requiredGateIds ?? []).filter((g) => g !== id)
    if (s.requiredGateIds.length === 0) delete s.requiredGateIds
    if (s.onComplete) {
      s.onComplete = s.onComplete.filter((r) => r.nextStepId !== id && r.gateId !== id)
      if (s.onComplete.length === 0) delete s.onComplete
    }
  }
  const transitions = Array.isArray(next.transitions)
    ? (next.transitions as Array<{ fromStepId?: string; toStepId?: string }>)
    : []
  next.transitions = transitions.filter((t) => t.fromStepId !== id && t.toStepId !== id)

  // Belépő újraválasztása, ha a törölt step volt a belépő.
  if (wasStep && (next as { entryStepId?: string }).entryStepId === id) {
    ;(next as { entryStepId?: string }).entryStepId = next.steps[0]?.id
  }
  return next
}

function isStepId(spec: PlaybookDraftSpec, id: string): boolean {
  return (spec.steps ?? []).some((s) => s.id === id)
}
function isGateId(spec: PlaybookDraftSpec, id: string): boolean {
  return (spec.gates ?? []).some((g) => g.id === id)
}

/**
 * Új lépés BESZÚRÁSA a kiválasztott node UTÁN (D: "insert after selected").
 * - afterId = Start: az új lesz a belépő, a korábbi belépő az új default folytatása lesz.
 * - afterId = step: az új beékelődik a step default (step-célú) folytatása ELÉ
 *   (step → új → korábbi-cél), így nem a Vége elé lóg, hanem a láncba kerül.
 * - afterId = gate / ismeretlen / null: nincs láncolás (árva node, régi viselkedés).
 */
export function addStepAfter(
  spec: PlaybookDraftSpec,
  kind: 'agent' | 'human' | 'decision',
  afterId: string | null | undefined,
): AddResult {
  const res = addStep(spec, kind)
  if (!afterId) return res
  return { spec: linkNewStepAfter(res.spec, afterId, res.id), id: res.id }
}

function linkNewStepAfter(spec: PlaybookDraftSpec, afterId: string, newId: string): PlaybookDraftSpec {
  const next = clone(spec)
  const steps = next.steps ?? []
  const newStep = steps.find((s) => s.id === newId)
  if (!newStep) return next

  // Start után: az új a belépő, a korábbi belépő az új default folytatása.
  if (afterId === START_NODE_ID) {
    const prevEntry = (next as { entryStepId?: string }).entryStepId
    ;(next as { entryStepId?: string }).entryStepId = newId
    if (prevEntry && prevEntry !== newId && steps.some((s) => s.id === prevEntry)) {
      newStep.onComplete = [{ condition: 'default', nextStepId: prevEntry }]
    }
    return next
  }

  const src = steps.find((s) => s.id === afterId)
  if (!src) return next // gate vagy ismeretlen → árva

  src.onComplete = src.onComplete ?? []
  // "default step-rule": feltétel nélküli, step-célú folytatás (gate-célút nem bántjuk).
  const def = src.onComplete.find(
    (r) => (r.condition == null || r.condition === 'default') && r.nextStepId && !r.gateId,
  )
  if (def) {
    const oldTarget = def.nextStepId
    def.nextStepId = newId
    if (oldTarget && oldTarget !== newId && steps.some((s) => s.id === oldTarget)) {
      newStep.onComplete = [{ condition: 'default', nextStepId: oldTarget }]
    }
  } else {
    src.onComplete.push({ condition: 'default', nextStepId: newId })
  }
  return next
}

/** Új kapu a kiválasztott node után: step esetén a step kötelező kapujaként köti be. */
export function addGateAfter(spec: PlaybookDraftSpec, afterId: string | null | undefined): AddResult {
  const res = addGate(spec)
  if (afterId && isStepId(res.spec, afterId)) {
    const next = clone(res.spec)
    const src = (next.steps ?? []).find((s) => s.id === afterId)
    if (src) src.requiredGateIds = [...new Set([...(src.requiredGateIds ?? []), res.id])]
    return { spec: next, id: res.id }
  }
  return res
}

/**
 * Egy meglévő él ÁTKÖTÉSE másik célpontra (jobb oldali él-szerkesztő).
 * A newTarget = End a routing törlését jelenti (a lépés terminálissá válik).
 */
export function retargetEdge(
  spec: PlaybookDraftSpec,
  edge: { source: string; kind: string; ruleIndex?: number; transitionIndex?: number; fromRequiredGate?: boolean; target: string },
  newTarget: string,
): PlaybookDraftSpec {
  if (edge.kind === 'entry' || edge.kind === 'end') return spec
  if (newTarget === edge.target) return spec
  if (newTarget === END_NODE_ID) return deleteEdgeFromSpec(spec, edge)

  const next = clone(spec)

  if (edge.fromRequiredGate || edge.kind === 'requires') {
    if (!isGateId(next, newTarget)) return spec // requires csak kapura mutathat
    const src = (next.steps ?? []).find((s) => s.id === edge.source)
    if (src) {
      src.requiredGateIds = [
        ...new Set((src.requiredGateIds ?? []).map((g) => (g === edge.target ? newTarget : g))),
      ]
    }
    return next
  }

  if (edge.transitionIndex != null) {
    const transitions = Array.isArray(next.transitions)
      ? (next.transitions as Array<{ toStepId?: string }>)
      : []
    const t = transitions[edge.transitionIndex]
    if (t && isStepId(next, newTarget)) t.toStepId = newTarget
    return next
  }

  if (edge.ruleIndex != null) {
    const src = (next.steps ?? []).find((s) => s.id === edge.source)
    const rule = src?.onComplete?.[edge.ruleIndex]
    if (rule) {
      if (isGateId(next, newTarget)) {
        rule.gateId = newTarget
        delete rule.nextStepId
      } else if (isStepId(next, newTarget)) {
        rule.nextStepId = newTarget
        delete rule.gateId
      }
    }
    return next
  }
  return spec
}

/** Egy él megfordítása: törli, majd a fordított irányban újraköti (source ⇄ target). */
export function reverseEdge(
  spec: PlaybookDraftSpec,
  edge: { source: string; kind: string; ruleIndex?: number; transitionIndex?: number; fromRequiredGate?: boolean; target: string },
): PlaybookDraftSpec {
  if (edge.kind === 'entry' || edge.kind === 'end') return spec
  if (edge.target === END_NODE_ID || edge.target === START_NODE_ID) return spec
  const deleted = deleteEdgeFromSpec(spec, edge)
  return connectNodes(deleted, edge.target, edge.source)
}

/** Egy step teljes cseréje (inspector-mentés) id szerint. */
export function replaceStep(spec: PlaybookDraftSpec, stepId: string, patch: RawStep): PlaybookDraftSpec {
  const next = clone(spec)
  next.steps = (next.steps ?? []).map((s) => (s.id === stepId ? patch : s))
  return next
}

/** Egy gate teljes cseréje (inspector-mentés) id szerint. */
export function replaceGate(spec: PlaybookDraftSpec, gateId: string, patch: RawGate): PlaybookDraftSpec {
  const next = clone(spec)
  next.gates = (next.gates ?? []).map((g) => (g.id === gateId ? patch : g))
  return next
}
