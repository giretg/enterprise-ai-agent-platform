/**
 * Egress-mátrix (APG-19, spec §10.2 / R4).
 *
 * A trusted UI nem az egyetlen kimenet: Telegram, platform e-mail, export/riport,
 * debug-log stb. külön szabályt kap. A tenant csak szigoríthat (entitástípus
 * kikapcsolása), lazítani nem tud az alapértelmezésnél.
 */
import {
  SURROGATE_ENTITY_TYPES,
  type SurrogateEntityType,
} from '@/domain/privacy/surrogate-format'

export const PRIVACY_EGRESS_SURFACES = [
  'web_ui',
  'external_channel',
  'platform_email',
  'export_report',
  'debug_log',
  'audit_log',
  'model_calls',
] as const

export type PrivacyEgressSurface = (typeof PRIVACY_EGRESS_SURFACES)[number]

/** `full` = minden entitástípus; `none` = semmi; egyébként explicit allowlista. */
export type PrivacyEgressResolveMode = 'full' | 'none' | readonly SurrogateEntityType[]

export const DEFAULT_PRIVACY_EGRESS_MATRIX: Record<
  PrivacyEgressSurface,
  PrivacyEgressResolveMode
> = {
  web_ui: 'full',
  external_channel: ['company'],
  platform_email: 'none',
  export_report: ['company'],
  debug_log: 'none',
  audit_log: 'none',
  model_calls: 'none',
}

export const PRIVACY_EGRESS_MATRIX_KEY = 'privacy.gateway.egress_matrix'
export const PRIVACY_EGRESS_MATRIX_TENANT_KEY = 'privacy.gateway.tenant_egress_matrix'

export const PRIVACY_EGRESS_EXPORT_RESOLVED_ACTION = 'privacy.egress.export_resolved' as const

export type PrivacyEgressEntityPatch = Partial<Record<SurrogateEntityType, boolean>>
export type PrivacyEgressSurfacePatch = Partial<Record<PrivacyEgressSurface, PrivacyEgressEntityPatch>>
export type PrivacyEgressMatrixLayer = PrivacyEgressSurfacePatch

export type ResolvedPrivacyEgressMatrix = Record<PrivacyEgressSurface, Set<SurrogateEntityType>>

function defaultAllowedSet(mode: PrivacyEgressResolveMode): Set<SurrogateEntityType> {
  if (mode === 'full') return new Set(SURROGATE_ENTITY_TYPES)
  if (mode === 'none') return new Set()
  return new Set(mode)
}

function applyTenantRestrictPatch(
  base: Set<SurrogateEntityType>,
  patch: PrivacyEgressEntityPatch | undefined,
): Set<SurrogateEntityType> {
  if (!patch) return base
  const next = new Set(base)
  for (const entityType of SURROGATE_ENTITY_TYPES) {
    if (patch[entityType] === false) next.delete(entityType)
  }
  return next
}

export function resolvePrivacyEgressMatrix(layers?: {
  tenant?: PrivacyEgressMatrixLayer | null
}): ResolvedPrivacyEgressMatrix {
  const tenant = layers?.tenant ?? null
  const resolved = {} as ResolvedPrivacyEgressMatrix
  for (const surface of PRIVACY_EGRESS_SURFACES) {
    const base = defaultAllowedSet(DEFAULT_PRIVACY_EGRESS_MATRIX[surface])
    resolved[surface] = applyTenantRestrictPatch(base, tenant?.[surface])
  }
  return resolved
}

export function allowsEgressResolve(
  matrix: ResolvedPrivacyEgressMatrix,
  surface: PrivacyEgressSurface,
  entityType: SurrogateEntityType,
): boolean {
  return matrix[surface].has(entityType)
}

export function parsePrivacyEgressMatrixLayer(raw: unknown): PrivacyEgressMatrixLayer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PrivacyEgressMatrixLayer = {}
  for (const [surfaceKey, surfaceValue] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPrivacyEgressSurface(surfaceKey)) continue
    if (!surfaceValue || typeof surfaceValue !== 'object' || Array.isArray(surfaceValue)) continue
    const entityPatch: PrivacyEgressEntityPatch = {}
    for (const [entityKey, allowed] of Object.entries(surfaceValue as Record<string, unknown>)) {
      if (!isSurrogateEntityType(entityKey)) continue
      if (allowed === false) entityPatch[entityKey] = false
    }
    if (Object.keys(entityPatch).length > 0) out[surfaceKey] = entityPatch
  }
  return out
}

function isPrivacyEgressSurface(value: string): value is PrivacyEgressSurface {
  return (PRIVACY_EGRESS_SURFACES as readonly string[]).includes(value)
}

function isSurrogateEntityType(value: string): value is SurrogateEntityType {
  return (SURROGATE_ENTITY_TYPES as readonly string[]).includes(value)
}
