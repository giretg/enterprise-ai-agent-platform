import type { Prisma } from '@prisma/client'
import { parseCapabilitySet } from './capability-set'
import { enrichOstorosborConnectorConfig } from '@/domain/connector-template/ostorosbor-config-enrichment'

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
  const runtimeConfig = enrichOstorosborConnectorConfig(set).config
  return {
    ...runtimeConfig,
    ...privacyDeclarationFromConfig(fixedConfig),
    restrictToEndpoints: true,
    selfUpdatingPinned: true,
  } as Prisma.JsonValue
}

/**
 * A forrás privacy-katalógusa (issue #320) a `connectors.config`-ba szinkronizálódik,
 * a rögzített capability-snapshot viszont a jóváhagyott spec-verzióból jön. A
 * mezőjelölés NEM képesség: nem tágít hívási felületet, csak azt mondja meg, mit
 * kell álnévre cserélni. Ezért a frissebb jelölés a pinned configra is ráíródik —
 * enélkül egy önfrissítő kapcsolat a hónapokkal korábbi snapshot jelölésével
 * tokenizálna, a friss katalógus mezői pedig nyersen mennének a modellhez.
 * Az endpoint-allowlist és minden más továbbra is a snapshotból származik.
 */
function privacyDeclarationFromConfig(fixedConfig: unknown): Record<string, unknown> {
  if (!fixedConfig || typeof fixedConfig !== 'object' || Array.isArray(fixedConfig)) return {}
  const config = fixedConfig as Record<string, unknown>
  const slice: Record<string, unknown> = {}
  for (const key of ['fields', 'privacy', 'entity_types', 'unlisted_default', 'catalog_version']) {
    if (config[key] !== undefined) slice[key] = config[key]
  }
  return slice
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
