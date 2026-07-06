/**
 * Lépés-szintű outputContract következtetés a routing és inputSlots alapján.
 * Ha egy lépés nem deklarál outputContract-ot, a következő lépés `step` forrású
 * (vagy nem-config) kötelező input-réseiből következtetjük a kimeneti mezőket.
 */
import type { PlaybookSpecV2, PlaybookStep } from '@/lib/playbook-v2/spec'

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

/** Egy step `outputContract.requiredFields`-je (lazán tárolt JSON-ból, típusőrizve). */
export function readOutputContractFields(outputContract?: Record<string, unknown>): string[] {
  const fields = outputContract?.requiredFields
  if (!Array.isArray(fields)) return []
  return fields.filter((f): f is string => typeof f === 'string' && f.length > 0)
}
