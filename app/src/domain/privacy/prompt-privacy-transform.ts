/**
 * Prompt-privacy transzformáció (APG-12, spec §2).
 *
 * A gateway a modellhívás előtt, az osztályozó ELŐTT futtatja: a `tokenize`
 * kategóriájú, felismerhető értékek álnevet kapnak, a maradékon dönt a
 * sensitivity-router. Így egy pszeudonimizált e-mail nem billenti `sensitive`-be
 * a beszélgetést (redesign-spec P5).
 *
 * Alapértelmezetten `user` / `assistant` / `tool` szöveget nyúl meg. A cache-elt
 * `system` prefix (APG-15) érintetlen; a cache-határ **utáni** `system` üzenetek
 * (pl. Project memory context adat-blokk, APG-20) ugyanazon a transzformáción
 * mennek át. A bemenetet nem mutálja.
 */
import { collectSensitivityMatchSpans } from '@/domain/gateway/sensitivity-router'
import { applySurrogateReplacements } from '@/domain/privacy/apply-replacements'
import {
  actionForPrivacyCategory,
  canonicalPrivacyCategory,
  type PrivacyCategoryAction,
  type ResolvedPrivacyCategoryPolicy,
} from '@/domain/privacy/privacy-category-policy'
import type { PrivacyGatewayMode, PrivacySpan } from '@/domain/privacy/privacy-mode'
import { substituteKnownValuesInText } from '@/domain/privacy/known-value-substitution'
import { findKnownValueMatches } from '@/domain/privacy/known-value-matcher'
import {
  runPrivacyTransformLayer,
  type PrivacyTransformFailureAudit,
} from '@/domain/privacy/privacy-transform-failure'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import {
  isSurrogateEntityType,
  parseSurrogate,
  type SurrogateEntityType,
} from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'
import {
  resolveUserInputEntities,
  type UserInputEntityResolution,
} from '@/domain/privacy/user-input-resolver'

/** Stabil vault-identitás a szabad-szöveges scannernek (UUID, nem connector-sor). */
export const PROMPT_SCANNER_CONNECTOR_ID = '00000000-0000-4000-8000-0000000000e1'

const BASE_TRANSFORM_ROLES = new Set(['user', 'assistant', 'tool'])

export type PromptPrivacyMessage = {
  role: string
  content?: string | null
  cacheBoundary?: boolean
}

function cacheBoundaryIndex(messages: readonly PromptPrivacyMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.cacheBoundary) return i
  }
  return -1
}

/** APG-15 + APG-20: csak a cache-határ utáni system üzenetek transzformálhatók. */
function shouldTransformPromptMessage(
  message: PromptPrivacyMessage,
  index: number,
  boundary: number,
): boolean {
  if (BASE_TRANSFORM_ROLES.has(message.role)) return true
  if (message.role !== 'system') return false
  return boundary >= 0 && index > boundary
}

export type PromptPrivacyTransformInput<T extends PromptPrivacyMessage> = {
  messages: T[]
  mode: PrivacyGatewayMode
  policy: ResolvedPrivacyCategoryPolicy | ((category: string) => PrivacyCategoryAction | Promise<PrivacyCategoryAction>)
  engine: SurrogateEngine
  tenantId: string
  scope: PrivacyScope
  /** APG-17 — connector `resolve()` a user üzenetekben (best-effort). */
  entityResolution?: UserInputEntityResolution
}

export type PromptPrivacyTransformResult<T extends PromptPrivacyMessage> = {
  messages: T[]
  spans: PrivacySpan[]
  applied: boolean
  failure?: PrivacyTransformFailureAudit
}

export async function transformPromptMessages<T extends PromptPrivacyMessage>(
  input: PromptPrivacyTransformInput<T>,
): Promise<PromptPrivacyTransformResult<T>> {
  if (input.mode === 'off') {
    return { messages: input.messages, spans: [], applied: false }
  }

  const actionOf = resolver(input.policy)
  const boundary = cacheBoundaryIndex(input.messages)
  let messages = input.messages
  let knownApplied = false
  let knownFailure: PrivacyTransformFailureAudit | undefined
  const knownSpans: PrivacySpan[] = []
  const knownReplacements = input.engine.listKnownValueReplacements(input.tenantId, input.scope)
  if (knownReplacements.length > 0) {
    const transformed: T[] = []
    for (const [index, message] of messages.entries()) {
      const text = message.content ?? ''
      if (!shouldTransformPromptMessage(message, index, boundary) || !text) {
        transformed.push(message)
        continue
      }
      const protectedSpans = collectSensitivityMatchSpans(text)
      for (const match of findKnownValueMatches(text, knownReplacements).filter(
        (candidate) =>
          !protectedSpans.some(
            (span) => candidate.start < span.end && candidate.end > span.start,
          ),
      )) {
        const parsed = parseSurrogate(match.surrogate)
        if (parsed) knownSpans.push({ entityType: parsed.entityType, field: 'prompt_known_value' })
      }
      const result = await substituteKnownValuesInText({
        text,
        replacements: knownReplacements,
        mode: input.mode,
        protectedSpans,
      })
      knownApplied ||= result.appliedCount > 0
      knownFailure ??= result.failure
      transformed.push(result.text === text ? message : { ...message, content: result.text })
    }
    messages = transformed
  }

  let entityApplied = false
  let entityFailure: PrivacyTransformFailureAudit | undefined
  const entitySpans: PrivacySpan[] = []
  if (input.entityResolution) {
    const transformed: T[] = []
    for (const message of messages) {
      const text = message.content ?? ''
      if (message.role !== 'user' || !text) {
        transformed.push(message)
        continue
      }
      const result = await resolveUserInputEntities({
        text,
        mode: input.mode,
        engine: input.engine,
        tenantId: input.tenantId,
        scope: input.scope,
        resolution: input.entityResolution,
      })
      entityApplied ||= result.applied
      entityFailure ??= result.failure
      entitySpans.push(...result.spans)
      transformed.push(result.text === text ? message : { ...message, content: result.text })
    }
    messages = transformed
  }

  const pending: Array<{
    messageIndex: number
    start: number
    end: number
    entityType: SurrogateEntityType
    value: string
  }> = []

  let scanFailure: PrivacyTransformFailureAudit | undefined
  try {
    for (const [messageIndex, message] of messages.entries()) {
      if (!shouldTransformPromptMessage(message, messageIndex, boundary)) continue
      const text = message.content ?? ''
      if (!text) continue
      for (const span of collectSensitivityMatchSpans(text)) {
        const category = canonicalPrivacyCategory(span.category)
        if ((await actionOf(category)) !== 'tokenize') continue
        if (!isSurrogateEntityType(category)) continue
        pending.push({
          messageIndex,
          start: span.start,
          end: span.end,
          entityType: category,
          value: span.value,
        })
      }
    }
  } catch (error) {
    if (input.mode === 'enforce') {
      const degraded = await runPrivacyTransformLayer({
        layer: 'scanner',
        work: async () => {
          throw error
        },
        onFailOpen: () => null,
      })
      scanFailure = degraded.failure
    }
  }

  const spans: PrivacySpan[] = [
    ...knownSpans,
    ...entitySpans,
    ...pending.map((slot) => ({
      entityType: slot.entityType,
      field: 'prompt',
    })),
  ]

  if (pending.length === 0) {
    return {
      messages,
      spans,
      applied: knownApplied || entityApplied,
      failure: knownFailure ?? entityFailure ?? scanFailure,
    }
  }

  if (input.mode !== 'enforce') {
    return { messages, spans, applied: false, failure: knownFailure ?? entityFailure ?? scanFailure }
  }

  // D2 — szabad szöveges találat VAL-surrogate-ot kap: a nyers e-mail/telefon
  // titkosítva kerül a vaultba, a `source_id` csak a hash. Ref-sorként a nyers
  // érték kulcsként, olvashatóan maradna ott, és a beszélgetés törlése
  // (crypto-shredding) sem érné el — második, örökké élő PII-példány.
  const surrogates = await runPrivacyTransformLayer({
    layer: 'vault',
    work: async () =>
      input.engine.allocateVals(
        pending.map((slot) => ({
          tenantId: input.tenantId,
          scope: input.scope,
          entityType: slot.entityType,
          plaintext: slot.value,
        })),
      ),
    onFailOpen: () => [],
  }).then((r) => r.value)

  const byMessage = new Map<number, Array<{ start: number; end: number; surrogate: string }>>()
  pending.forEach((slot, index) => {
    const surrogate = surrogates[index]
    if (!surrogate) return
    const list = byMessage.get(slot.messageIndex) ?? []
    list.push({ start: slot.start, end: slot.end, surrogate })
    byMessage.set(slot.messageIndex, list)
  })

  const resolvedMessages = messages.map((message, index) => {
    const replacements = byMessage.get(index)
    if (!replacements || replacements.length === 0) return message
    const text = message.content ?? ''
    return { ...message, content: applySurrogateReplacements(text, replacements) }
  })

  return {
    messages: resolvedMessages,
    spans,
    applied: true,
    failure: knownFailure ?? entityFailure ?? scanFailure,
  }
}

function resolver(
  policy: ResolvedPrivacyCategoryPolicy | ((category: string) => PrivacyCategoryAction | Promise<PrivacyCategoryAction>),
): (category: string) => Promise<PrivacyCategoryAction> {
  if (typeof policy === 'function') {
    return async (category) => policy(category)
  }
  return async (category) => actionForPrivacyCategory(policy, category)
}
