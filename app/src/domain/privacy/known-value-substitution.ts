/**
 * Known-value substitution (spec §8/2) — APG-16 magyar toldalék-tűrő illesztéssel.
 *
 * APG-13: a hibapolicy itt érvényesül. Strukturált mezőből ismert érték
 * hibája fail-closed; egyéb forrás fail-open + audit.
 */
import type { PrivacyGatewayMode } from '@/domain/privacy/privacy-mode'
import {
  applyKnownValueMatches,
  findKnownValueMatches,
} from '@/domain/privacy/known-value-matcher'
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

/** Toldalék-tűrő szótár-illesztés (Aho–Corasick, spec §8/2). */
export function applyKnownValueReplacements(
  text: string,
  replacements: KnownValueReplacement[],
): string {
  const matches = findKnownValueMatches(text, replacements)
  return applyKnownValueMatches(text, matches)
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
  if (input.mode !== 'enforce') {
    return { text: original, appliedCount: 0 }
  }
  const result = await runPrivacyTransformLayer({
    layer: 'known_value',
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
  /** Magasabb prioritású scanner-spanok (pl. teljes e-mail); ezek belsejében ne illesszünk nevet. */
  protectedSpans?: ReadonlyArray<{ start: number; end: number }>
}): Promise<KnownValueSubstitutionResult> {
  const original = input.text
  const matches = findKnownValueMatches(original, input.replacements).filter(
    (match) =>
      !input.protectedSpans?.some(
        (span) => match.start < span.end && match.end > span.start,
      ),
  )
  const result = await runKnownValueSubstitution({
    text: original,
    fromStructuredField: input.replacements.some((slot) => slot.fromStructuredField),
    mode: input.mode,
    work: async () => applyKnownValueMatches(original, matches),
  })
  if (result.failure) return result
  if (input.mode !== 'enforce') {
    return { text: result.text, appliedCount: 0 }
  }
  const appliedCount = new Set(matches.map((m) => m.surrogate)).size
  return { text: result.text, appliedCount }
}
