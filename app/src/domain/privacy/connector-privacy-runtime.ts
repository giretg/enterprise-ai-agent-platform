/**
 * A privacy-admin és a futásidő ugyanazt a connector-configot lássa:
 * önfrissítő kapcsolatnál a pinned snapshotot, ne a tárolt üres `config`-ot.
 */
import { pinnedRuntimeConfig } from '@/domain/connector/runtime-config'
import { effectiveConnectorRuntimeConfig } from '@/domain/connector-template/ostorosbor-config-enrichment'
import { connectorHasPrivacyMetadata } from '@/domain/privacy/connector-privacy'

export function connectorRowHasPrivacyMetadata(row: {
  connectorMode: 'fixed' | 'self_updating'
  config: unknown
  capabilitySet?: unknown | null
}): boolean {
  const pinned = pinnedRuntimeConfig(row.connectorMode, row.config, row.capabilitySet)
  if (!pinned) return false
  return connectorHasPrivacyMetadata(effectiveConnectorRuntimeConfig(pinned))
}
