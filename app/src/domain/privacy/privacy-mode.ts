/**
 * Privacy Gateway üzemmód (APG-09, spec §13, issue #320 D9).
 *
 * Tenant default → agent override. Egyszerű felülírás: az agent értéke nyer,
 * ha van; különben a tenant; különben az új tenant kezdőérték (OBSERVE).
 */
import type { SurrogateEntityType } from '@/domain/privacy/surrogate-format'

export const PRIVACY_GATEWAY_MODES = ['off', 'observe', 'enforce'] as const
export type PrivacyGatewayMode = (typeof PRIVACY_GATEWAY_MODES)[number]

export const DEFAULT_PRIVACY_GATEWAY_MODE: PrivacyGatewayMode = 'observe'

/** @deprecated Platform-szint megszűnt (#320). Csak migráció olvassa. */
export const PRIVACY_GATEWAY_CONTROLS_KEY = 'privacy.gateway.controls'

export const PRIVACY_GATEWAY_TENANT_CONTROLS_KEY = 'privacy.gateway.tenant_controls'
export const PRIVACY_GATEWAY_AGENT_CONTROLS_KEY = 'privacy.gateway.agent_controls'

export function isPrivacyGatewayMode(value: unknown): value is PrivacyGatewayMode {
  return value === 'off' || value === 'observe' || value === 'enforce'
}

export function parsePrivacyGatewayMode(raw: unknown): PrivacyGatewayMode | null {
  return isPrivacyGatewayMode(raw) ? raw : null
}

/** Felülírás-lánc: agent → tenant → default (OBSERVE). */
export function resolvePrivacyGatewayMode(layers: {
  platform?: PrivacyGatewayMode | null
  tenant?: PrivacyGatewayMode | null
  agent?: PrivacyGatewayMode | null
}): PrivacyGatewayMode {
  if (layers.agent) return layers.agent
  if (layers.tenant) return layers.tenant
  if (layers.platform) return layers.platform
  return DEFAULT_PRIVACY_GATEWAY_MODE
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
  const categories = Object.keys(byCategory).sort()
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
      merged = addSpanCategory(merged, key, count)
    }
  }
  return merged
}

export type PrivacyModeResolver = (ctx: {
  tenantId: string | null
  agentId: string
}) => Promise<PrivacyGatewayMode>
