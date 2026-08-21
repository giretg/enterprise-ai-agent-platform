/**
 * Egress-mátrix (APG-19, spec §10.2 / R4, issue #320 D9).
 *
 * A `'full'` jelentése: minden forrás-definiált entitástípus — nem csak az alapöt.
 */
import {
  DEFAULT_SURROGATE_ENTITY_TYPES,
  isEntityTypeSlug,
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

export const PRIVACY_EGRESS_MATRIX_TENANT_KEY = 'privacy.gateway.tenant_egress_matrix'

export type PrivacyEgressEntityPatch = Partial<Record<SurrogateEntityType, boolean>>
export type PrivacyEgressSurfacePatch = Partial<Record<PrivacyEgressSurface, PrivacyEgressEntityPatch>>
export type PrivacyEgressMatrixLayer = PrivacyEgressSurfacePatch

/** `'all'` = minden típus (full alapértelmezés); `'none'` = semmi; egyébként allowlista. */
export type ResolvedSurfaceEgress = 'all' | 'none' | Set<SurrogateEntityType>

export type ResolvedPrivacyEgressMatrix = Record<PrivacyEgressSurface, ResolvedSurfaceEgress>

function defaultAllowedSurface(mode: PrivacyEgressResolveMode): ResolvedSurfaceEgress {
  if (mode === 'full') return 'all'
  if (mode === 'none') return 'none'
  return new Set(mode)
}

function applyTenantRestrictPatch(
  base: ResolvedSurfaceEgress,
  patch: PrivacyEgressEntityPatch | undefined,
  knownTypes: readonly SurrogateEntityType[],
): ResolvedSurfaceEgress {
  if (!patch) return base
  if (base === 'none') return 'none'
  const typesToCheck =
    base === 'all'
      ? [...new Set([...DEFAULT_SURROGATE_ENTITY_TYPES, ...knownTypes])]
      : [...base]
  const next = base === 'all' ? new Set<SurrogateEntityType>(typesToCheck) : new Set(base)
  for (const entityType of typesToCheck) {
    if (patch[entityType] === false) next.delete(entityType)
  }
  if (next.size === 0) return 'none'
  if (base === 'all' && Object.values(patch).every((value) => value !== false)) return 'all'
  return next
}

export function resolvePrivacyEgressMatrix(layers?: {
  tenant?: PrivacyEgressMatrixLayer | null
  knownEntityTypes?: readonly SurrogateEntityType[]
}): ResolvedPrivacyEgressMatrix {
  const tenant = layers?.tenant ?? null
  const knownEntityTypes = layers?.knownEntityTypes ?? DEFAULT_SURROGATE_ENTITY_TYPES
  const resolved = {} as ResolvedPrivacyEgressMatrix
  for (const surface of PRIVACY_EGRESS_SURFACES) {
    const base = defaultAllowedSurface(DEFAULT_PRIVACY_EGRESS_MATRIX[surface])
    resolved[surface] = applyTenantRestrictPatch(base, tenant?.[surface], knownEntityTypes)
  }
  return resolved
}

export function allowsEgressResolve(
  matrix: ResolvedPrivacyEgressMatrix,
  surface: PrivacyEgressSurface,
  entityType: SurrogateEntityType,
): boolean {
  const allowed = matrix[surface]
  if (allowed === 'all') return true
  if (allowed === 'none') return false
  return allowed.has(entityType)
}

export function parsePrivacyEgressMatrixLayer(raw: unknown): PrivacyEgressMatrixLayer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PrivacyEgressMatrixLayer = {}
  for (const [surfaceKey, surfaceValue] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPrivacyEgressSurface(surfaceKey)) continue
    if (!surfaceValue || typeof surfaceValue !== 'object' || Array.isArray(surfaceValue)) continue
    const entityPatch: PrivacyEgressEntityPatch = {}
    for (const [entityKey, allowed] of Object.entries(surfaceValue as Record<string, unknown>)) {
      if (!isEntityTypeSlug(entityKey)) continue
      if (allowed === false) entityPatch[entityKey] = false
    }
    if (Object.keys(entityPatch).length > 0) out[surfaceKey] = entityPatch
  }
  return out
}

function isPrivacyEgressSurface(value: string): value is PrivacyEgressSurface {
  return (PRIVACY_EGRESS_SURFACES as readonly string[]).includes(value)
}
