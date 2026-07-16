import type { ConnectorConfig } from '@/domain/provisioning/connector-config'
import { OSTOROSBOR_CRM_REQUEST_HEADERS } from './custom-template-seeds'

export const OSTOROSBOR_TEMPLATE_KEYS = new Set([
  'ostorosbor-crm-sales-delegated',
  'ostorosbor-crm-service-insight',
])

export function ostorosborTemplateKey(config: ConnectorConfig): string | null {
  const key = config.provenance?.templateKey ?? config.provider
  return key && OSTOROSBOR_TEMPLATE_KEYS.has(key) ? key : null
}

/**
 * Régi (DB-ben elavult sablonból materializált) Ostorosbor draftok kiegészítése:
 * a CRM kötelező trace fejlécei hiányozhatnak a perzisztált configból.
 */
export function enrichOstorosborConnectorConfig(config: ConnectorConfig): {
  config: ConnectorConfig
  changed: boolean
} {
  if (!ostorosborTemplateKey(config)) {
    return { config, changed: false }
  }

  let changed = false
  const next = { ...config }

  if (!next.requestHeaders || Object.keys(next.requestHeaders).length === 0) {
    next.requestHeaders = { ...OSTOROSBOR_CRM_REQUEST_HEADERS }
    changed = true
  }

  return { config: next, changed }
}
