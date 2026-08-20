/**
 * User-input entity resolver (APG-17, spec §9).
 *
 * Best-effort: candidate extraction + connector `resolve()`. Sikertelen / többértelmű
 * felismerés → a nyers név marad (fail-open + audit a scanner rétegen).
 */
import type { PrivacyGatewayMode, PrivacySpan } from '@/domain/privacy/privacy-mode'
import {
  entityResolveCandidateToRef,
  normalizeEntityResolveResponse,
  type ConnectorEntityResolver,
  type EntityResolveResponse,
} from '@/domain/privacy/entity-resolve-contract'
import {
  extractEntityCandidates,
  normalizeResolveQuery,
  type EntityCandidateSpan,
} from '@/domain/privacy/extract-entity-candidates'
import {
  runPrivacyTransformLayer,
  type PrivacyTransformFailureAudit,
} from '@/domain/privacy/privacy-transform-failure'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import type { SurrogateEntityType } from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

export type UserInputEntityResolution = {
  connectorId: string
  resolver: ConnectorEntityResolver
  entityTypeHint?: SurrogateEntityType
}

export type ResolveUserInputEntitiesResult = {
  text: string
  applied: boolean
  spans: PrivacySpan[]
  failure?: PrivacyTransformFailureAudit
  resolveAttempts: number
}

export async function resolveUserInputEntities(input: {
  text: string
  mode: PrivacyGatewayMode
  engine: SurrogateEngine
  tenantId: string
  scope: PrivacyScope
  resolution: UserInputEntityResolution
}): Promise<ResolveUserInputEntitiesResult> {
  const original = input.text
  if (input.mode !== 'enforce' || !original.trim()) {
    return { text: original, applied: false, spans: [], resolveAttempts: 0 }
  }

  const candidates = extractEntityCandidates(original)
  if (candidates.length === 0) {
    return { text: original, applied: false, spans: [], resolveAttempts: 0 }
  }

  const result = await runPrivacyTransformLayer({
    layer: 'scanner',
    work: async () => applyResolvedCandidates(original, candidates, input),
    onFailOpen: () => ({
      text: original,
      applied: false,
      spans: [],
      resolveAttempts: candidates.length,
    }),
  })

  if (result.failure) {
    return {
      text: result.value.text,
      applied: result.value.applied,
      spans: result.value.spans,
      failure: result.failure,
      resolveAttempts: result.value.resolveAttempts,
    }
  }
  return result.value
}

async function applyResolvedCandidates(
  original: string,
  candidates: EntityCandidateSpan[],
  input: {
    engine: SurrogateEngine
    tenantId: string
    scope: PrivacyScope
    resolution: UserInputEntityResolution
  },
): Promise<ResolveUserInputEntitiesResult> {
  const replacements: Array<{ start: number; end: number; surrogate: string; entityType: SurrogateEntityType }> =
    []
  const spans: PrivacySpan[] = []
  const queried = new Set<string>()
  let resolveAttempts = 0

  for (const candidate of candidates) {
    const queryKey = normalizeResolveQuery(candidate.resolveText)
    if (!queryKey || queried.has(queryKey)) continue
    queried.add(queryKey)

    const response = await input.resolution.resolver.resolve({
      text: candidate.resolveText,
      entityType: input.resolution.entityTypeHint,
    })
    resolveAttempts += 1
    const normalized = normalizeEntityResolveResponse(response)
    const applied = pickMatch(normalized)
    if (!applied) continue

    const ref = entityResolveCandidateToRef(applied, input.resolution.connectorId)
    const surrogate = await input.engine.allocateRef({
      tenantId: input.tenantId,
      scope: input.scope,
      entityType: ref.entityType,
      connectorId: ref.connectorId,
      sourceId: ref.sourceId,
      displayValue: ref.displayValue,
      displayValueSource: 'scanner',
    })
    replacements.push({
      start: candidate.start,
      end: candidate.end,
      surrogate,
      entityType: ref.entityType,
    })
    spans.push({ entityType: ref.entityType, field: 'user_input_resolve' })
  }

  if (replacements.length === 0) {
    return { text: original, applied: false, spans, resolveAttempts }
  }

  return {
    text: applyReplacements(original, replacements),
    applied: true,
    spans,
    resolveAttempts,
  }
}

function pickMatch(response: EntityResolveResponse) {
  if (response.status !== 'match') return null
  return response.candidates[0] ?? null
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
