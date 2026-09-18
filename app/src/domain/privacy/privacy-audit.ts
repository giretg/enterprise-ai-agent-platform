/**
 * Privacy-audit payload (APG-09, spec §15).
 *
 * Hash-láncolt esemény: kategória, akció, érintett spanek száma, scope —
 * soha a nyers entitásérték. A builder allowlist-eli a mezőket; extra kulcs
 * (`displayValue`, `rawValue`, `sourceId`, tool-args) nem kerül a láncba.
 */
import { isSurrogateEntityType, parseSurrogate, type SurrogateEntityType } from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'
import type { PrivacyGatewayMode, PrivacySpanSummary } from '@/domain/privacy/privacy-mode'

export const PRIVACY_TRANSFORM_ACTIONS = [
  'privacy.transform.applied',
  'privacy.transform.observed',
  'privacy.transform.failed',
] as const
export const PRIVACY_RESOLVE_ACTIONS = [
  'privacy.resolve.applied',
  'privacy.resolve.denied',
  'privacy.surrogate.unknown',
] as const
export const PRIVACY_GATEWAY_AUDIT_ACTIONS = [
  ...PRIVACY_TRANSFORM_ACTIONS,
  ...PRIVACY_RESOLVE_ACTIONS,
] as const

export type PrivacyTransformAuditAction = (typeof PRIVACY_TRANSFORM_ACTIONS)[number]
export type PrivacyResolveAuditAction = (typeof PRIVACY_RESOLVE_ACTIONS)[number]
export type PrivacyGatewayAuditAction = (typeof PRIVACY_GATEWAY_AUDIT_ACTIONS)[number]

export const PRIVACY_GATEWAY_MODE_SET_ACTION = 'privacy.gateway.mode.set' as const
export const PRIVACY_CATEGORY_POLICY_SET_ACTION = 'privacy.gateway.category_policy.set' as const

const METADATA_ALLOWLIST = new Set([
  'category',
  'categories',
  'action',
  'spanCount',
  'byCategory',
  'scopeType',
  'mode',
  'reason',
])

export type PrivacyAuditMetadata = {
  category?: SurrogateEntityType
  categories: SurrogateEntityType[]
  action: 'tokenize' | 'resolve'
  spanCount: number
  byCategory: Partial<Record<SurrogateEntityType, number>>
  scopeType: PrivacyScope['type']
  mode?: PrivacyGatewayMode
  reason?: string
}

export type PrivacyGatewayAuditInput = {
  action: PrivacyGatewayAuditAction
  tenantId: string
  scope: PrivacyScope
  summary: PrivacySpanSummary
  mode?: PrivacyGatewayMode
  reason?: string
  /** Álnév — nem nyers érték. Csak denied/unknown ágon. */
  surrogate?: string
  actorType?: 'system' | 'human' | 'agent'
  actorId?: string | null
  ticketId?: string | null
}

/**
 * Allowlist-elt metadata. Ismeretlen kulcsot eldob; a nyers értéket a típus
 * eleve nem fogadja. A kimenet JSON-osítható, és a payload-guardon is átmegy.
 */
export function buildPrivacyAuditMetadata(
  input: PrivacyAuditMetadata & Record<string, unknown>,
): PrivacyAuditMetadata {
  const byCategory: Partial<Record<SurrogateEntityType, number>> = {}
  if (input.byCategory && typeof input.byCategory === 'object') {
    for (const [key, count] of Object.entries(input.byCategory)) {
      if (isSurrogateEntityType(key) && typeof count === 'number' && Number.isFinite(count) && count > 0) {
        byCategory[key] = count
      }
    }
  }
  const categories = Array.isArray(input.categories)
    ? input.categories.filter(isSurrogateEntityType)
    : []
  const metadata: PrivacyAuditMetadata = {
    categories,
    action: input.action === 'resolve' ? 'resolve' : 'tokenize',
    spanCount: typeof input.spanCount === 'number' && Number.isFinite(input.spanCount) ? input.spanCount : 0,
    byCategory,
    scopeType: input.scopeType === 'trace' ? 'trace' : 'conversation',
  }
  if (typeof input.category === 'string' && isSurrogateEntityType(input.category)) {
    metadata.category = input.category
  }
  if (input.mode === 'off' || input.mode === 'observe' || input.mode === 'enforce') {
    metadata.mode = input.mode
  }
  if (typeof input.reason === 'string') metadata.reason = input.reason

  for (const key of Object.keys(metadata)) {
    if (!METADATA_ALLOWLIST.has(key)) delete (metadata as Record<string, unknown>)[key]
  }
  return metadata
}

export function summaryFromSurrogate(surrogate: string): PrivacySpanSummary {
  const parsed = parseSurrogate(surrogate)
  if (!parsed) return { spanCount: 0, categories: [], byCategory: {} }
  return {
    spanCount: 1,
    categories: [parsed.entityType],
    byCategory: { [parsed.entityType]: 1 },
  }
}

export async function recordPrivacyGatewayAudit(
  _input: PrivacyGatewayAuditInput,
): Promise<void> {
  // Phase B has no AuditLog table.
}

/** Teszt-segéd: a serializált audit-ágban megjelenik-e bármely nyers entitásérték. */
export function findRawEntityLeak(payload: unknown, rawValues: readonly string[]): string | null {
  const serialized = JSON.stringify(payload)
  if (serialized == null) return null
  for (const raw of rawValues) {
    if (raw.length > 0 && serialized.includes(raw)) return raw
  }
  return null
}
