/**
 * Connector entity resolution szerződés (APG-17, spec §9 / §11; forrás §6.3, issue #320).
 */
import { z } from 'zod'
import { ENTITY_TYPE_SLUG_RE, type SurrogateEntityType } from '@/domain/privacy/surrogate-format'

export const ENTITY_RESOLVE_STATUSES = ['match', 'ambiguous', 'none'] as const
export type EntityResolveStatus = (typeof ENTITY_RESOLVE_STATUSES)[number]

export const ENTITY_RESOLVE_MATCH_CONFIDENCE = 0.85
export const ENTITY_RESOLVE_AMBIGUOUS_CONFIDENCE = 0.5

export const entityResolveCandidateSchema = z.object({
  source_id: z.string().min(1),
  entity_type: z.string().regex(ENTITY_TYPE_SLUG_RE),
  display_name: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
})
export type EntityResolveCandidate = z.infer<typeof entityResolveCandidateSchema>

export const entityResolveResponseSchema = z.object({
  status: z.enum(ENTITY_RESOLVE_STATUSES),
  candidates: z.array(entityResolveCandidateSchema),
})
export type EntityResolveResponse = z.infer<typeof entityResolveResponseSchema>

export type EntityResolveRequest = {
  text: string
  entityType?: SurrogateEntityType
}

export type ConnectorEntityResolver = {
  resolve(input: EntityResolveRequest): Promise<EntityResolveResponse>
}

export function parseEntityResolveResponse(raw: unknown): EntityResolveResponse {
  const parsed = entityResolveResponseSchema.safeParse(raw)
  if (!parsed.success) return { status: 'none', candidates: [] }
  return normalizeEntityResolveResponse(parsed.data)
}

export function normalizeEntityResolveResponse(response: EntityResolveResponse): EntityResolveResponse {
  const sorted = [...response.candidates].sort((a, b) => b.confidence - a.confidence)
  if (response.status === 'none' || sorted.length === 0) {
    return { status: 'none', candidates: [] }
  }
  if (response.status === 'ambiguous') return { status: 'ambiguous', candidates: sorted }
  const best = sorted[0]
  if (!best) return { status: 'none', candidates: [] }
  if (best.confidence < ENTITY_RESOLVE_AMBIGUOUS_CONFIDENCE) {
    return { status: 'none', candidates: [] }
  }
  const closeCandidates = sorted.filter(
    (candidate) => best.confidence - candidate.confidence <= 0.05,
  )
  if (best.confidence < ENTITY_RESOLVE_MATCH_CONFIDENCE || closeCandidates.length > 1) {
    return { status: 'ambiguous', candidates: sorted }
  }
  return { status: 'match', candidates: [best] }
}

export function entityResolveCandidateToRef(
  candidate: EntityResolveCandidate,
  connectorId: string,
): { entityType: SurrogateEntityType; connectorId: string; sourceId: string; displayValue: string } {
  return {
    entityType: candidate.entity_type,
    connectorId,
    sourceId: candidate.source_id,
    displayValue: candidate.display_name,
  }
}

export const SOURCE_ID_SHAPE_RE = /^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*\/.+/i

export function looksLikeSourceId(value: string): boolean {
  return SOURCE_ID_SHAPE_RE.test(value.trim())
}
