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
  categorySupportsTokenize,
  isSourceCatalogPrivacyCategory,
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

/**
 * A kategória-akció forrása: kész, feloldott policy vagy agent-szintű feloldó.
 * A gateway az agent overlay-t adja, a tesztek a feloldott dokumentumot.
 */
export type PromptPrivacyPolicy =
  | ResolvedPrivacyCategoryPolicy
  | ((category: string) => PrivacyCategoryAction | Promise<PrivacyCategoryAction>)

export type PromptPrivacyTransformInput<T extends PromptPrivacyMessage> = {
  messages: T[]
  mode: PrivacyGatewayMode
  /**
   * Hiányában a szabad szöveges minta-réteg kimarad (nincs mi eldöntse az
   * akciót). Cégre/személyre SOHA nem fut: azok a forrás katalógusából
   * tokenizálódnak (#320 D6), a mintakeresőnek nincs is rájuk mintája.
   */
  policy?: PromptPrivacyPolicy
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

  // Szabad szöveges minta-réteg: e-mail / telefon / bankszámla. Ezeknek van
  // álnév-típusuk és megbízható mintájuk, ezért a policy `tokenize` döntése
  // itt teljesül. A cég- és személynév NEM ide tartozik (#320 D6): azok a
  // forrás katalógusából, stabil source_id mellett kapnak álnevet.
  const scanner = await tokenizeFreeTextPatterns(messages, {
    boundary,
    policy: input.policy,
    mode: input.mode,
    engine: input.engine,
    tenantId: input.tenantId,
    scope: input.scope,
  })
  messages = scanner.messages

  const spans: PrivacySpan[] = [...knownSpans, ...entitySpans, ...scanner.spans]

  return {
    messages,
    spans,
    applied: knownApplied || entityApplied || scanner.applied,
    failure: knownFailure ?? entityFailure ?? scanner.failure,
  }
}

function policyResolver(
  policy: PromptPrivacyPolicy,
): (category: string) => Promise<PrivacyCategoryAction> {
  if (typeof policy === 'function') return async (category) => policy(category)
  return async (category) => actionForPrivacyCategory(policy, category)
}

/**
 * A mintakereső találataiból csak az kaphat álnevet, aminek van álnév-típusa.
 * A PAN / IBAN / TAJ / adószám / titok kategóriákat a routing-policy és a
 * redakció kezeli — álnév-típusuk nincs, ezért `tokenize` esetén sem cseréljük.
 */
function tokenizableScannerCategory(category: string): SurrogateEntityType | null {
  const canonical = canonicalPrivacyCategory(category)
  if (isSourceCatalogPrivacyCategory(canonical)) return null
  return categorySupportsTokenize(canonical) ? canonical : null
}

async function tokenizeFreeTextPatterns<T extends PromptPrivacyMessage>(
  messages: T[],
  ctx: {
    boundary: number
    policy?: PromptPrivacyPolicy
    mode: PrivacyGatewayMode
    engine: SurrogateEngine
    tenantId: string
    scope: PrivacyScope
  },
): Promise<{
  messages: T[]
  spans: PrivacySpan[]
  applied: boolean
  failure?: PrivacyTransformFailureAudit
}> {
  if (!ctx.policy) return { messages, spans: [], applied: false }
  const actionOf = policyResolver(ctx.policy)

  const pending: Array<{
    messageIndex: number
    start: number
    end: number
    entityType: SurrogateEntityType
    value: string
  }> = []

  let failure: PrivacyTransformFailureAudit | undefined
  try {
    for (const [messageIndex, message] of messages.entries()) {
      if (!shouldTransformPromptMessage(message, messageIndex, ctx.boundary)) continue
      const text = message.content ?? ''
      if (!text) continue
      for (const span of collectSensitivityMatchSpans(text)) {
        const entityType = tokenizableScannerCategory(span.category)
        if (!entityType) continue
        if ((await actionOf(entityType)) !== 'tokenize') continue
        pending.push({
          messageIndex,
          start: span.start,
          end: span.end,
          entityType,
          value: span.value,
        })
      }
    }
  } catch (error) {
    if (ctx.mode !== 'enforce') return { messages, spans: [], applied: false }
    const degraded = await runPrivacyTransformLayer({
      layer: 'scanner',
      work: async () => {
        throw error
      },
      onFailOpen: () => null,
    })
    failure = degraded.failure
  }

  const spans: PrivacySpan[] = pending.map((slot) => ({
    entityType: slot.entityType,
    field: 'prompt',
  }))
  // OBSERVE: a fedettség mérhető, de a modell a nyers szöveget kapja.
  if (pending.length === 0 || ctx.mode !== 'enforce') {
    return { messages, spans, applied: false, failure }
  }

  // A szabad szöveges találat VAL-surrogate-ot kap: a nyers e-mail/telefon
  // titkosítva kerül a vaultba, a `source_id` csak a hash. Ref-sorként a nyers
  // érték kulcsként, olvashatóan maradna ott, és a beszélgetés törlése
  // (crypto-shredding) sem érné el — második, örökké élő PII-példány.
  const surrogates = await runPrivacyTransformLayer({
    layer: 'vault',
    work: async () =>
      ctx.engine.allocateVals(
        pending.map((slot) => ({
          tenantId: ctx.tenantId,
          scope: ctx.scope,
          entityType: slot.entityType,
          plaintext: slot.value,
        })),
      ),
    onFailOpen: () => [],
  })
  failure ??= surrogates.failure

  const byMessage = new Map<number, Array<{ start: number; end: number; surrogate: string }>>()
  pending.forEach((slot, index) => {
    const surrogate = surrogates.value[index]
    if (!surrogate) return
    const list = byMessage.get(slot.messageIndex) ?? []
    list.push({ start: slot.start, end: slot.end, surrogate })
    byMessage.set(slot.messageIndex, list)
  })
  if (byMessage.size === 0) return { messages, spans, applied: false, failure }

  return {
    messages: messages.map((message, index) => {
      const replacements = byMessage.get(index)
      if (!replacements || replacements.length === 0) return message
      return { ...message, content: applySurrogateReplacements(message.content ?? '', replacements) }
    }),
    spans,
    applied: true,
    failure,
  }
}
