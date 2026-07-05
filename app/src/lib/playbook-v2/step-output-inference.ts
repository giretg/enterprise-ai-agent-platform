/**
 * Lépés-szintű outputContract következtetés a routing és inputSlots alapján.
 * Ha egy lépés nem deklarál outputContract-ot, a következő lépés `step` forrású
 * (vagy nem-config) kötelező input-réseiből következtetjük a kimeneti mezőket.
 */
import type { PlaybookSpecV2 } from '@/lib/playbook-v2/spec'

export function inferStepOutputFields(spec: PlaybookSpecV2): Map<string, string[]> {
  const byStep = new Map<string, Set<string>>()
  const stepById = new Map(spec.steps.map((s) => [s.id, s]))

  const addField = (fromStepId: string, fieldName: string) => {
    const set = byStep.get(fromStepId) ?? new Set<string>()
    set.add(fieldName)
    byStep.set(fromStepId, set)
  }

  for (const step of spec.steps) {
    for (const rule of step.onComplete ?? []) {
      if (!rule.nextStepId) continue
      const nextStep = stepById.get(rule.nextStepId)
      if (!nextStep) continue

      for (const slot of nextStep.inputSlots ?? []) {
        if (!slot.required) continue
        if (slot.source === 'config') continue

        const fromPreviousStep =
          slot.source === 'step' ||
          (slot.source === 'trigger' && rule.nextStepId !== spec.entryStepId)

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
