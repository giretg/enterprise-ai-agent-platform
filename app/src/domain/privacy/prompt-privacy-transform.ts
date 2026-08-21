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
import type { ResolvedPrivacyCategoryPolicy } from '@/domain/privacy/privacy-category-policy'
import type { PrivacyGatewayMode, PrivacySpan } from '@/domain/privacy/privacy-mode'
import { substituteKnownValuesInText } from '@/domain/privacy/known-value-substitution'
import { findKnownValueMatches } from '@/domain/privacy/known-value-matcher'
import type { PrivacyTransformFailureAudit } from '@/domain/privacy/privacy-transform-failure'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import {
  parseSurrogate,
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
  /** Megmaradt a hívói kompatibilitásért; a vak regex-tokenizálás kivezetve (#320 D6). */
  policy?: ResolvedPrivacyCategoryPolicy
  engine: SurrogateEngine
  tenantId: string
  scope: PrivacyScope
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

  const boundary = cacheBoundaryIndex(input.messages)
  let messages = input.messages
  let knownApplied = false
  let knownFailure: PrivacyTransformFailureAudit | undefined
  const knownSpans: PrivacySpan[] = []
  const knownReplacements = await input.engine.loadKnownValueReplacements(
    input.tenantId,
    input.scope,
  )
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

  const spans: PrivacySpan[] = [...knownSpans, ...entitySpans]

  return {
    messages,
    spans,
    applied: knownApplied || entityApplied,
    failure: knownFailure ?? entityFailure,
  }
}
