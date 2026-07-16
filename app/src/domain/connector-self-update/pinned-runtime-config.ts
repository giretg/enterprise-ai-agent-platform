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

/**
 * Agenthez rendelhető-e a connector. Ugyanaz a fail-closed szabály, mint a runtime
 * listázásnál: self_updating connector aktív, sémával validált snapshot nélkül
 * futásidőben láthatatlan lenne — ezért hozzárendelni sem szabad.
 */
export function isConnectorAssignableToAgent(
  connectorMode: 'fixed' | 'self_updating',
  activeCapabilitySet: unknown,
): boolean {
  if (connectorMode === 'fixed') return true
  return pinnedRuntimeConfig('self_updating', {}, activeCapabilitySet) !== null
}
