/**
 * Tool-boundary entity resolution — második védelmi vonal (APG-17, spec §9).
 *
 * Ha a prompt előtti resolve nem talált, de az LLM nyers nevet ad a tool callban
 * (`company="SPAR"`), a broker a connector-hívás előtt újra megkísérli a feloldást.
 * Siker → source ID megy a connector felé; a beszélgetésben surrogate képződik.
 */
import { inspectConnectorPrivacyFields } from '@/domain/privacy/connector-privacy'
import { PrivacyTransformBlockedError } from '@/domain/privacy/privacy-transform-failure'
import {
  entityResolveCandidateToRef,
  looksLikeSourceId,
  normalizeEntityResolveResponse,
  type ConnectorEntityResolver,
} from '@/domain/privacy/entity-resolve-contract'
import { stemForResolve } from '@/domain/privacy/extract-entity-candidates'
import { addSpanCategory, mergePrivacySpanCategories } from '@/domain/privacy/privacy-mode'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { parseSurrogate, type SurrogateEntityType } from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

export type ResolveToolEntityNamesInput = {
  args: unknown
  engine: SurrogateEngine
  tenantId: string
  scope: PrivacyScope
  connectorId: string
  connectorConfig: unknown
  resolver: ConnectorEntityResolver
}

export type ResolveToolEntityNamesResult = {
  args: unknown
  resolvedCount: number
  resolveAttempts: number
  byCategory: Partial<Record<SurrogateEntityType, number>>
}

export async function resolveEntityNamesInToolArgs(
  input: ResolveToolEntityNamesInput,
): Promise<ResolveToolEntityNamesResult> {
  let copy: unknown
  try {
    copy = structuredClone(input.args)
  } catch {
    return { args: input.args, resolvedCount: 0, resolveAttempts: 0, byCategory: {} }
  }

  const entityTypesByKey = entityTypeHintsFromConnectorFields(input.connectorConfig)
  const walked = await walk(copy, input, entityTypesByKey)
  return { args: copy, ...walked }
}

type WalkOk = {
  resolvedCount: number
  resolveAttempts: number
  byCategory: Partial<Record<SurrogateEntityType, number>>
}

function entityTypeHintsFromConnectorFields(config: unknown): Map<string, SurrogateEntityType> {
  const inspected = inspectConnectorPrivacyFields(config)
  if (inspected.status === 'invalid') {
    throw new PrivacyTransformBlockedError(
      'structured_field',
      new Error(`Hibás connector privacy deklaráció: ${inspected.reason}`),
    )
  }
  const fields = inspected.status === 'valid' ? inspected.fields : null
  const hints = new Map<string, SurrogateEntityType>()
  if (!fields) return hints
  for (const [name, spec] of Object.entries(fields)) {
    if (spec.privacy !== 'tokenize' || !spec.entity_type) continue
    hints.set(name, spec.entity_type)
    const short = name.replace(/_name$/, '')
    if (short !== name) hints.set(short, spec.entity_type)
  }
  return hints
}

async function walk(
  value: unknown,
  ctx: ResolveToolEntityNamesInput,
  entityTypesByKey: Map<string, SurrogateEntityType>,
  keyHint?: string,
): Promise<WalkOk> {
  if (typeof value === 'string') {
    const replaced = await replaceIfEntityName(value, ctx, entityTypesByKey, keyHint)
    return replaced.state
  }
  if (!value || typeof value !== 'object') {
    return { resolvedCount: 0, resolveAttempts: 0, byCategory: {} }
  }

  if (Array.isArray(value)) {
    let resolvedCount = 0
    let resolveAttempts = 0
    let byCategory: Partial<Record<SurrogateEntityType, number>> = {}
    for (let i = 0; i < value.length; i += 1) {
      const child = value[i]
      if (typeof child === 'string') {
        const replaced = await replaceIfEntityName(child, ctx, entityTypesByKey, keyHint)
        if (replaced.changed) value[i] = replaced.value
        resolvedCount += replaced.state.resolvedCount
        resolveAttempts += replaced.state.resolveAttempts
        byCategory = mergePrivacySpanCategories(byCategory, replaced.state.byCategory)
        continue
      }
      const nested = await walk(child, ctx, entityTypesByKey, keyHint)
      resolvedCount += nested.resolvedCount
      resolveAttempts += nested.resolveAttempts
      byCategory = mergePrivacySpanCategories(byCategory, nested.byCategory)
    }
    return { resolvedCount, resolveAttempts, byCategory }
  }

  const record = value as Record<string, unknown>
  let resolvedCount = 0
  let resolveAttempts = 0
  let byCategory: Partial<Record<SurrogateEntityType, number>> = {}
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'string') {
      const replaced = await replaceIfEntityName(child, ctx, entityTypesByKey, key)
      if (replaced.changed) record[key] = replaced.value
      resolvedCount += replaced.state.resolvedCount
      resolveAttempts += replaced.state.resolveAttempts
      byCategory = mergePrivacySpanCategories(byCategory, replaced.state.byCategory)
      continue
    }
    const nested = await walk(child, ctx, entityTypesByKey, key)
    resolvedCount += nested.resolvedCount
    resolveAttempts += nested.resolveAttempts
    byCategory = mergePrivacySpanCategories(byCategory, nested.byCategory)
  }
  return { resolvedCount, resolveAttempts, byCategory }
}

async function replaceIfEntityName(
  value: string,
  ctx: ResolveToolEntityNamesInput,
  entityTypesByKey: Map<string, SurrogateEntityType>,
  keyHint?: string,
): Promise<
  | { changed: false; state: WalkOk }
  | { changed: true; value: string; state: WalkOk }
> {
  const empty: WalkOk = { resolvedCount: 0, resolveAttempts: 0, byCategory: {} }
  if (!value.trim() || parseSurrogate(value) || looksLikeSourceId(value)) {
    return { changed: false, state: empty }
  }

  const resolveText = stemForResolve(value)
  if (resolveText.length < 2) return { changed: false, state: empty }

  const entityType = keyHint ? entityTypesByKey.get(keyHint) : undefined
  const response = normalizeEntityResolveResponse(
    await ctx.resolver.resolve({ text: resolveText, entityType }),
  )
  const state: WalkOk = { resolvedCount: 0, resolveAttempts: 1, byCategory: {} }
  if (response.status !== 'match') return { changed: false, state }
  const candidate = response.candidates[0]
  if (!candidate) return { changed: false, state }

  const ref = entityResolveCandidateToRef(candidate, ctx.connectorId)
  await ctx.engine.allocateRef({
    tenantId: ctx.tenantId,
    scope: ctx.scope,
    entityType: ref.entityType,
    connectorId: ref.connectorId,
    sourceId: ref.sourceId,
    displayValue: ref.displayValue,
    displayValueSource: 'scanner',
  })

  return {
    changed: true,
    value: ref.sourceId,
    state: {
      resolvedCount: 1,
      resolveAttempts: 1,
      byCategory: addSpanCategory({}, ref.entityType),
    },
  }
}
