/**
 * Known-value substitution (spec §8/2) — APG-16 bővíti magyar toldalék-tűréssel.
 *
 * APG-13: a hibapolicy itt érvényesül. Strukturált mezőből ismert érték
 * hibája fail-closed; egyéb forrás fail-open + audit.
 */
import type { PrivacyGatewayMode } from '@/domain/privacy/privacy-mode'
import {
  runPrivacyTransformLayer,
  type PrivacyTransformFailureAudit,
} from '@/domain/privacy/privacy-transform-failure'

export type KnownValueReplacement = {
  needle: string
  surrogate: string
  /** Strukturált mezőből származik-e a needle (§8/2 fail-closed ág). */
  fromStructuredField: boolean
}

export type KnownValueSubstitutionResult = {
  text: string
  appliedCount: number
  failure?: PrivacyTransformFailureAudit
}

/** Exact match cserék — APG-16 után toldalék-tűrő illesztésre cserélendő. */
export function applyKnownValueReplacements(
  text: string,
  replacements: KnownValueReplacement[],
): string {
  let out = text
  for (const slot of replacements) {
    if (!slot.needle || !out.includes(slot.needle)) continue
    out = out.split(slot.needle).join(slot.surrogate)
  }
  return out
}

/**
 * Egy known-value lépés §15 policy-vel. Tesztekben a `work()` hibát injektálhat.
 */
export async function runKnownValueSubstitution(input: {
  text: string
  fromStructuredField: boolean
  mode: PrivacyGatewayMode
  work: () => Promise<string>
}): Promise<KnownValueSubstitutionResult> {
  const original = input.text
  const result = await runPrivacyTransformLayer({
    layer: 'known_value',
    mode: input.mode,
    knownValueFromStructuredField: input.fromStructuredField,
    work: input.work,
    onFailOpen: () => original,
  })
  return {
    text: result.value,
    appliedCount: result.value === original ? 0 : 1,
    failure: result.failure,
  }
}

export async function substituteKnownValuesInText(input: {
  text: string
  replacements: KnownValueReplacement[]
  mode: PrivacyGatewayMode
}): Promise<KnownValueSubstitutionResult> {
  const original = input.text
  const result = await runKnownValueSubstitution({
    text: original,
    fromStructuredField: input.replacements.some((slot) => slot.fromStructuredField),
    mode: input.mode,
    work: async () => applyKnownValueReplacements(original, input.replacements),
  })
  if (result.failure) return result
  const appliedCount = input.replacements.filter(
    (slot) => original.includes(slot.needle) && result.text.includes(slot.surrogate),
  ).length
  return { text: result.text, appliedCount }
}
