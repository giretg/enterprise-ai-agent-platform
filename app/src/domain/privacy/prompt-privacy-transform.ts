/**
 * Prompt-privacy transzformáció (APG-12, spec §2).
 *
 * A gateway a modellhívás előtt, az osztályozó ELŐTT futtatja: a `tokenize`
 * kategóriájú, felismerhető értékek álnevet kapnak, a maradékon dönt a
 * sensitivity-router. Így egy pszeudonimizált e-mail nem billenti `sensitive`-be
 * a beszélgetést (redesign-spec P5).
 *
 * Csak `user` / `assistant` / `tool` szöveget nyúl meg — a `system` prefix
 * közös cache-szegmens (APG-15). A bemenetet nem mutálja.
 */
import { collectSensitivityMatchSpans } from '@/domain/gateway/sensitivity-router'
import {
  actionForPrivacyCategory,
  canonicalPrivacyCategory,
  type PrivacyCategoryAction,
  type ResolvedPrivacyCategoryPolicy,
} from '@/domain/privacy/privacy-category-policy'
import type { PrivacyGatewayMode, PrivacySpan } from '@/domain/privacy/privacy-mode'
import {
  runPrivacyTransformLayer,
  type PrivacyTransformFailureAudit,
} from '@/domain/privacy/privacy-transform-failure'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { isSurrogateEntityType, type SurrogateEntityType } from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

/** Stabil vault-identitás a szabad-szöveges scannernek (UUID, nem connector-sor). */
export const PROMPT_SCANNER_CONNECTOR_ID = '00000000-0000-4000-8000-0000000000e1'

const TRANSFORM_ROLES = new Set(['user', 'assistant', 'tool'])

export type PromptPrivacyMessage = {
  role: string
  content?: string | null
}

export type PromptPrivacyTransformInput<T extends PromptPrivacyMessage> = {
  messages: T[]
  mode: PrivacyGatewayMode
  policy: ResolvedPrivacyCategoryPolicy | ((category: string) => PrivacyCategoryAction | Promise<PrivacyCategoryAction>)
  engine: SurrogateEngine
  tenantId: string
  scope: PrivacyScope
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
  const pending: Array<{
    messageIndex: number
    start: number
    end: number
    entityType: SurrogateEntityType
    value: string
  }> = []

  let scanFailure: PrivacyTransformFailureAudit | undefined
  try {
    for (const [messageIndex, message] of input.messages.entries()) {
      if (!TRANSFORM_ROLES.has(message.role)) continue
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
        mode: input.mode,
        work: async () => {
          throw error
        },
        onFailOpen: () => null,
      })
      scanFailure = degraded.failure
    }
  }

  const spans: PrivacySpan[] = pending.map((slot) => ({
    entityType: slot.entityType,
    field: 'prompt',
  }))

  if (pending.length === 0) {
    return { messages: input.messages, spans, applied: false, failure: scanFailure }
  }

  if (input.mode !== 'enforce') {
    return { messages: input.messages, spans, applied: false, failure: scanFailure }
  }

  const surrogates = await runPrivacyTransformLayer({
    layer: 'vault',
    mode: input.mode,
    work: async () =>
      input.engine.allocateRefs(
        pending.map((slot) => ({
          tenantId: input.tenantId,
          scope: input.scope,
          entityType: slot.entityType,
          connectorId: PROMPT_SCANNER_CONNECTOR_ID,
          sourceId: slot.value,
          displayValue: slot.value,
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

  const messages = input.messages.map((message, index) => {
    const replacements = byMessage.get(index)
    if (!replacements || replacements.length === 0) return message
    const text = message.content ?? ''
    return { ...message, content: applyReplacements(text, replacements) }
  })

  return { messages, spans, applied: true, failure: scanFailure }
}

function resolver(
  policy: ResolvedPrivacyCategoryPolicy | ((category: string) => PrivacyCategoryAction | Promise<PrivacyCategoryAction>),
): (category: string) => Promise<PrivacyCategoryAction> {
  if (typeof policy === 'function') {
    return async (category) => policy(category)
  }
  return async (category) => actionForPrivacyCategory(policy, category)
}

function applyReplacements(
  text: string,
  replacements: Array<{ start: number; end: number; surrogate: string }>,
): string {
  const sorted = [...replacements].sort((a, b) => b.start - a.start || b.end - a.end)
  let out = text
  let cut = out.length
  for (const slot of sorted) {
    if (slot.end > cut) continue
    out = out.slice(0, slot.start) + slot.surrogate + out.slice(slot.end)
    cut = slot.start
  }
  return out
}
