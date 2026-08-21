/**
 * Privacy Gateway üzemmód és kill-switch hierarchia (APG-09, spec §13).
 *
 * platform master → tenant default → agent override. A beállított szintek
 * legszigorúbbika érvényesül (OFF < OBSERVE < ENFORCE): bármelyik lefelé
 * kapcsolhat, egyik sem oldhatja fel a szülő tiltását.
 *
 * Ebben a jegyben OFF és OBSERVE a rollout-alap; az ENFORCE érték tárolható
 * és érvényesül (APG-04 út). Az admin UI: APG-14. Platform-alapértelmezés: OBSERVE.
 *
 * A TAJ / adószám / kártya mintaszűrő **nem** ez a réteg — lásd
 * `domain/gateway/sensitivity-mode.ts`. Az OBSERVE itt csak az álnévcserét
 * némítja, a mintaszűrőt nem.
 */
import type { SurrogateEntityType } from '@/domain/privacy/surrogate-format'

export const PRIVACY_GATEWAY_MODES = ['off', 'observe', 'enforce'] as const
export type PrivacyGatewayMode = (typeof PRIVACY_GATEWAY_MODES)[number]

export const DEFAULT_PRIVACY_GATEWAY_MODE: PrivacyGatewayMode = 'observe'

/** PlatformSetting kulcs: `{ mode, updatedById?, updatedAt? }`. */
export const PRIVACY_GATEWAY_CONTROLS_KEY = 'privacy.gateway.controls'

/** Tenant-bucket: `{ [tenantId]: { mode | null, updatedById?, updatedAt? } }`. */
export const PRIVACY_GATEWAY_TENANT_CONTROLS_KEY = 'privacy.gateway.tenant_controls'

/** Agent-bucket: `{ [agentId]: { mode | null, updatedById?, updatedAt? } }`. */
export const PRIVACY_GATEWAY_AGENT_CONTROLS_KEY = 'privacy.gateway.agent_controls'

const RANK: Record<PrivacyGatewayMode, number> = {
  off: 0,
  observe: 1,
  enforce: 2,
}

export function isPrivacyGatewayMode(value: unknown): value is PrivacyGatewayMode {
  return value === 'off' || value === 'observe' || value === 'enforce'
}

export function parsePrivacyGatewayMode(raw: unknown): PrivacyGatewayMode | null {
  return isPrivacyGatewayMode(raw) ? raw : null
}

/**
 * Összevonás: a beállított szintek **legszigorúbbika** (OFF < OBSERVE < ENFORCE).
 * Bármelyik szint lefelé kapcsolhat; egyik sem oldhatja fel a szülő tiltását.
 * Hiányzó platform → OBSERVE (rollout-alap, nem ENFORCE).
 */
export function resolvePrivacyGatewayMode(layers: {
  platform?: PrivacyGatewayMode | null
  tenant?: PrivacyGatewayMode | null
  agent?: PrivacyGatewayMode | null
}): PrivacyGatewayMode {
  const modes: PrivacyGatewayMode[] = [layers.platform ?? DEFAULT_PRIVACY_GATEWAY_MODE]
  if (layers.tenant) modes.push(layers.tenant)
  if (layers.agent) modes.push(layers.agent)
  return modes.reduce((strictest, next) => (RANK[next] < RANK[strictest] ? next : strictest))
}

export type PrivacySpan = {
  entityType: SurrogateEntityType
  field: string
}

export type PrivacySpanSummary = {
  spanCount: number
  categories: SurrogateEntityType[]
  byCategory: Partial<Record<SurrogateEntityType, number>>
}

export function summarizePrivacySpans(spans: readonly PrivacySpan[]): PrivacySpanSummary {
  const byCategory: Partial<Record<SurrogateEntityType, number>> = {}
  for (const span of spans) {
    byCategory[span.entityType] = (byCategory[span.entityType] ?? 0) + 1
  }
  const categories = (Object.keys(byCategory) as SurrogateEntityType[]).sort()
  return { spanCount: spans.length, categories, byCategory }
}

export function addSpanCategory(
  byCategory: Partial<Record<SurrogateEntityType, number>>,
  entityType: SurrogateEntityType,
  count = 1,
): Partial<Record<SurrogateEntityType, number>> {
  return { ...byCategory, [entityType]: (byCategory[entityType] ?? 0) + count }
}

export function mergePrivacySpanCategories(
  left: Partial<Record<SurrogateEntityType, number>>,
  right: Partial<Record<SurrogateEntityType, number>>,
): Partial<Record<SurrogateEntityType, number>> {
  let merged = left
  for (const [key, count] of Object.entries(right)) {
    if (typeof count === 'number') {
      merged = addSpanCategory(merged, key as SurrogateEntityType, count)
    }
  }
  return merged
}

export type PrivacyModeResolver = (ctx: {
  tenantId: string | null
  agentId: string
}) => Promise<PrivacyGatewayMode>
