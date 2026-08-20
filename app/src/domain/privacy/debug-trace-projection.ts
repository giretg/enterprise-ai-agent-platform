/**
 * Debug-trace pszeudonimizált projection (APG-21, spec §12).
 *
 * A trusted zónában nyers log marad; a debugging AI felé trace-scoped álnevekkel
 * megy ki a tartalom, hogy a modell követni tudja az eseményláncot anélkül, hogy
 * nyers entitásértéket kapna.
 */
import { collectSensitivityMatchSpans } from '@/domain/gateway/sensitivity-router'
import {
  actionForPrivacyCategory,
  canonicalPrivacyCategory,
  type ResolvedPrivacyCategoryPolicy,
} from '@/domain/privacy/privacy-category-policy'
import type { PrivacyGatewayMode } from '@/domain/privacy/privacy-mode'
import { findKnownValueMatches } from '@/domain/privacy/known-value-matcher'
import {
  PROMPT_SCANNER_CONNECTOR_ID,
} from '@/domain/privacy/prompt-privacy-transform'
import { runPrivacyTransformLayer } from '@/domain/privacy/privacy-transform-failure'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { isSurrogateEntityType, parseSurrogate, type SurrogateEntityType } from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'
import { privacyScopeForTrace } from '@/domain/privacy/privacy-scope'

export type DebugTraceRawBundle = Record<string, unknown> & {
  traceId: string
  agentTurnId: string
  conversationId: string
}

export type DebugTraceToolOutput = {
  traceId: string
  agentTurnId: string
  conversationId: string
  projection: Record<string, unknown>
}

export type DebugTraceProjectionInput = {
  trace: DebugTraceRawBundle
  tenantId: string
  traceId: string
  /** A beszélgetésben már ismert entitások forrása (known-value illesztéshez). */
  knownValueScope?: PrivacyScope | null
  mode: PrivacyGatewayMode
  policy: ResolvedPrivacyCategoryPolicy
  engine: SurrogateEngine
}

const TEXT_FIELD_HINTS = new Set([
  'content',
  'detail',
  'partialtext',
  'partialText',
  'title',
  'message',
  'error',
  'reason',
  'summary',
  'text',
  'body',
])

function shouldTransformField(field: string | undefined, value: string): boolean {
  if (!field) return value.length > 0
  const normalized = field.replace(/[_-]/g, '').toLowerCase()
  if (TEXT_FIELD_HINTS.has(normalized)) return true
  if (normalized.endsWith('text')) return true
  if (normalized.endsWith('content')) return true
  return value.includes('@') || value.includes(' ')
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

async function transformDebugTraceText(input: {
  text: string
  tenantId: string
  scope: PrivacyScope
  knownValueScope?: PrivacyScope | null
  mode: PrivacyGatewayMode
  policy: ResolvedPrivacyCategoryPolicy
  engine: SurrogateEngine
}): Promise<string> {
  if (input.mode === 'off' || !input.text) return input.text

  let text = input.text
  const knownScope = input.knownValueScope ?? input.scope
  const knownReplacements = input.engine.listKnownValueReplacements(input.tenantId, knownScope)
  if (knownReplacements.length > 0) {
    const matches = findKnownValueMatches(text, knownReplacements)
    if (matches.length > 0) {
      const pending: Array<{ start: number; end: number; entityType: SurrogateEntityType; sourceId: string; displayValue: string }> = []
      for (const match of matches) {
        const parsed = parseSurrogate(match.surrogate)
        if (!parsed) continue
        const resolved = await input.engine.peekRef({
          tenantId: input.tenantId,
          scope: knownScope,
          surrogate: match.surrogate,
          requester: { tenantId: input.tenantId, userId: null },
        })
        pending.push({
          start: match.start,
          end: match.end,
          entityType: parsed.entityType,
          sourceId: resolved.ok ? resolved.record.sourceId : match.matchedText,
          displayValue: match.matchedText,
        })
      }
      if (pending.length > 0) {
        const surrogates = await runPrivacyTransformLayer({
          layer: 'vault',
          work: async () =>
            input.engine.allocateRefs(
              pending.map((slot) => ({
                tenantId: input.tenantId,
                scope: input.scope,
                entityType: slot.entityType,
                connectorId: PROMPT_SCANNER_CONNECTOR_ID,
                sourceId: slot.sourceId,
                displayValue: slot.displayValue,
                displayValueSource: 'structured_field' as const,
              })),
            ),
          onFailOpen: () => [],
        }).then((result) => result.value)
        text = applyReplacements(
          text,
          pending.flatMap((slot, index) => {
            const surrogate = surrogates[index]
            return surrogate ? [{ start: slot.start, end: slot.end, surrogate }] : []
          }),
        )
      }
    }
  }

  const pending: Array<{ start: number; end: number; entityType: SurrogateEntityType; value: string }> = []
  for (const span of collectSensitivityMatchSpans(text)) {
    const category = canonicalPrivacyCategory(span.category)
    const action = actionForPrivacyCategory(input.policy, category)
    // Debug-trace LLM egress: a local_only kategóriák is pszeudonimizálódnak, nem nyersen mennek ki.
    if (action !== 'tokenize' && action !== 'local_only') continue
    if (!isSurrogateEntityType(category)) continue
    pending.push({
      start: span.start,
      end: span.end,
      entityType: category,
      value: span.value,
    })
  }

  if (pending.length === 0) return text

  const surrogates = await runPrivacyTransformLayer({
    layer: 'vault',
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
  }).then((result) => result.value)

  const replacements = pending.flatMap((slot, index) => {
    const surrogate = surrogates[index]
    return surrogate ? [{ start: slot.start, end: slot.end, surrogate }] : []
  })
  return applyReplacements(text, replacements)
}

async function projectDebugTraceValue(
  value: unknown,
  ctx: {
    tenantId: string
    scope: PrivacyScope
    knownValueScope?: PrivacyScope | null
    mode: PrivacyGatewayMode
    policy: ResolvedPrivacyCategoryPolicy
    engine: SurrogateEngine
    field?: string
  },
): Promise<unknown> {
  if (typeof value === 'string') {
    if (!shouldTransformField(ctx.field, value)) return value
    return transformDebugTraceText({
      text: value,
      tenantId: ctx.tenantId,
      scope: ctx.scope,
      knownValueScope: ctx.knownValueScope,
      mode: ctx.mode,
      policy: ctx.policy,
      engine: ctx.engine,
    })
  }

  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) {
      out.push(await projectDebugTraceValue(item, ctx))
    }
    return out
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = await projectDebugTraceValue(child, { ...ctx, field: key })
    }
    return out
  }

  return value
}

export async function projectDebugTraceBundle(
  input: DebugTraceProjectionInput,
): Promise<Record<string, unknown>> {
  const scope = privacyScopeForTrace(input.traceId)
  const projected = await projectDebugTraceValue(input.trace, {
    tenantId: input.tenantId,
    scope,
    knownValueScope: input.knownValueScope ?? { type: 'conversation', id: input.trace.conversationId },
    mode: input.mode,
    policy: input.policy,
    engine: input.engine,
  })
  return projected as Record<string, unknown>
}

/** A `get_debug_trace` tool LLM-bound kimenete. */
export async function projectDebugTraceToolOutput(
  input: DebugTraceProjectionInput,
): Promise<DebugTraceToolOutput> {
  const projection = await projectDebugTraceBundle(input)
  const { traceId, agentTurnId, conversationId, ...rest } = projection
  return {
    traceId: String(traceId ?? input.traceId),
    agentTurnId: String(agentTurnId ?? input.trace.agentTurnId),
    conversationId: String(conversationId ?? input.trace.conversationId),
    projection: rest,
  }
}
