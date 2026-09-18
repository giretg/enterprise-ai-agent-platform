import type { Prisma } from '@prisma/client'

/**
 * Self-updating connectors are DEFER. KEEP runtime uses the stored canonical
 * config and fail-closes `self_updating` until that phase extracts a pin.
 */
export function pinnedRuntimeConfig(
  connectorMode: 'fixed' | 'self_updating',
  fixedConfig: unknown,
): Prisma.JsonValue | null {
  if (connectorMode === 'self_updating') return null
  return fixedConfig as Prisma.JsonValue
}

export function isConnectorAssignableToAgent(
  connectorMode: 'fixed' | 'self_updating',
): boolean {
  return connectorMode === 'fixed'
}
