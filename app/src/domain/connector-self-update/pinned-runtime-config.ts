import type { Prisma } from '@prisma/client'
import { parseCapabilitySet } from './capability-set'

/**
 * A3 broker-kapu: fixed connectornál a meglévő config marad; self_updating módban
 * kizárólag az aktív, sémával validált capability snapshotból készülhet runtime config.
 * `null` = fail-closed, a repository nem adja vissza a connectort az agentnek.
 */
export function pinnedRuntimeConfig(
  connectorMode: 'fixed' | 'self_updating',
  fixedConfig: unknown,
  activeCapabilitySet: unknown,
): Prisma.JsonValue | null {
  if (connectorMode === 'fixed') return fixedConfig as Prisma.JsonValue
  const set = parseCapabilitySet(activeCapabilitySet)
  if (!set) return null
  return { ...set, restrictToEndpoints: true, selfUpdatingPinned: true } as Prisma.JsonValue
}
