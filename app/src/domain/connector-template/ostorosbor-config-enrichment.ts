import {
  normalizeConnectorConfig,
  type ConnectorConfig,
  type ProposedTool,
} from '@/domain/provisioning/connector-config'
import {
  OSTOROSBOR_CRM_PRIVACY_CAPABILITIES,
  OSTOROSBOR_CRM_PRIVACY_FIELDS,
  OSTOROSBOR_CRM_TEMPLATE_KEYS,
} from '@/domain/privacy/connector-privacy'
import { OSTOROSBOR_CRM_REQUEST_HEADERS } from './custom-template-seeds'

export const OSTOROSBOR_TEMPLATE_KEYS = OSTOROSBOR_CRM_TEMPLATE_KEYS

/** Ostoros connector API path — report query/export POST-ok itt olvasók. */
const OSTOROSBOR_CONNECTOR_API_SUFFIX = /\/api\/connector\/v1\/?$/i
const OSTOROSBOR_TRUSTED_CRM_HOSTS = new Set([
  'ostorosbor-crm--e-ai-ab8f1.europe-west4.hosted.app',
  'ostorosbor-crm--enterprise-ai-demo.europe-west4.hosted.app',
])

/**
 * Olvasó POST riportvégpontok — a következmény-kapu `risk: read` alapján
 * engedi őket HITL nélkül (az `access` POST-on továbbra is write lehet).
 */
export const OSTOROSBOR_READ_POST_REPORT_TOOLS: readonly ProposedTool[] = [
  {
    name: 'query_report',
    method: 'POST',
    path: '/reports/query',
    access: 'write',
    risk: 'read',
    description:
      'Riportlekérdezés (nem módosít). Kötelező: period.from + period.to (YYYY-MM-DD, inkluzív); plusz preset VAGY dataset+measures. Példa: {"preset":"turnover","period":{"from":"2026-01-01","to":"2026-06-30"}}',
  },
  {
    name: 'export_report',
    method: 'POST',
    path: '/reports/exports',
    access: 'write',
    risk: 'read',
    description:
      'Riportexport (nem módosít). Ugyanaz a body, mint /reports/query, plusz format: "csv"|"xlsx".',
  },
]

export function ostorosborTemplateKey(config: ConnectorConfig): string | null {
  const key = config.provenance?.templateKey ?? config.provider
  return key && OSTOROSBOR_TEMPLATE_KEYS.has(key) ? key : null
}

function isOstorosborConnectorApi(config: ConnectorConfig): boolean {
  if (ostorosborTemplateKey(config)) return true
  return OSTOROSBOR_CONNECTOR_API_SUFFIX.test(config.baseUrl)
}

/**
 * Trace-fejlécet csak a platform által ismert Ostoros CRM hostnak adunk automatikusan.
 * A self-updating kapcsolat neve és OpenAPI-ja admin által megadható, ezért ezek nem
 * elegendőek ahhoz, hogy az acting-user e-mail külső API-hoz kerülhessen.
 */
function isTrustedOstorosborCrm(config: ConnectorConfig): boolean {
  if (ostorosborTemplateKey(config)) return true
  return OSTOROSBOR_TRUSTED_CRM_HOSTS.has(new URL(config.baseUrl).hostname)
}

function toolKey(tool: Pick<ProposedTool, 'method' | 'path'>): string {
  return `${tool.method.toUpperCase()} ${tool.path}`
}

/**
 * Biztosítja, hogy a ismert olvasó report POST-ok `risk: read` legyenek.
 * Hiányzó végpontot csak a service-insight sablonra tesz be.
 */
export function enrichOstorosborReadPostReports(config: ConnectorConfig): {
  config: ConnectorConfig
  changed: boolean
} {
  if (!isOstorosborConnectorApi(config)) {
    return { config, changed: false }
  }

  const templateKey = ostorosborTemplateKey(config)
  const canAddMissing = templateKey === 'ostorosbor-crm-service-insight'
  let changed = false
  const nextTools = [...config.proposedTools]

  for (const canonical of OSTOROSBOR_READ_POST_REPORT_TOOLS) {
    const key = toolKey(canonical)
    const existingIdx = nextTools.findIndex((t) => toolKey(t) === key)
    if (existingIdx >= 0) {
      const existing = nextTools[existingIdx]
      if (existing.risk !== 'read') {
        nextTools[existingIdx] = {
          ...existing,
          risk: 'read',
          ...(existing.description ? {} : { description: canonical.description }),
        }
        changed = true
      }
      continue
    }
    if (!canAddMissing) continue
    nextTools.push({ ...canonical })
    changed = true
  }

  if (!changed) return { config, changed: false }
  return { config: { ...config, proposedTools: nextTools }, changed: true }
}

/**
 * Régi (DB-ben elavult) Ostorosbor configok kiegészítése:
 * kötelező trace fejlécek + olvasó report POST `risk` jelölés.
 */
export function enrichOstorosborTraceHeaders(config: ConnectorConfig): {
  config: ConnectorConfig
  changed: boolean
} {
  if (!isTrustedOstorosborCrm(config) || (config.requestHeaders && Object.keys(config.requestHeaders).length > 0)) {
    return { config, changed: false }
  }

  return {
    config: { ...config, requestHeaders: { ...OSTOROSBOR_CRM_REQUEST_HEADERS } },
    changed: true,
  }
}

export function enrichOstorosborPrivacy(config: ConnectorConfig): {
  config: ConnectorConfig
  changed: boolean
} {
  if (!isOstorosborConnectorApi(config)) {
    return { config, changed: false }
  }

  let changed = false
  let next = config
  if (!next.privacy) {
    next = { ...next, privacy: { ...OSTOROSBOR_CRM_PRIVACY_CAPABILITIES } }
    changed = true
  }
  if (!next.fields) {
    next = { ...next, fields: { ...OSTOROSBOR_CRM_PRIVACY_FIELDS } }
    changed = true
  }
  return { config: next, changed }
}

/**
 * A futásidő által LÁTOTT connector-config: normalizált + kiegészített. A tárolt
 * sor a kiegészítés bevezetése előtt is létrejöhetett, ezért a privacy-rétegnek
 * ugyanezt kell néznie, mint a tool-hívásnak — különben egy régebbi CRM-kapcsolat
 * hívható, de a mezői némán tokenizálatlanul mennek ki a modellhez.
 * Nem értelmezhető (nem http_api) config esetén a nyers érték megy tovább.
 */
export function effectiveConnectorRuntimeConfig(raw: unknown): unknown {
  try {
    return enrichOstorosborConnectorConfig(normalizeConnectorConfig(raw)).config
  } catch {
    return raw
  }
}

export function enrichOstorosborConnectorConfig(config: ConnectorConfig): {
  config: ConnectorConfig
  changed: boolean
} {
  let changed = false
  let next = config

  const traceHeaders = enrichOstorosborTraceHeaders(next)
  if (traceHeaders.changed) {
    next = traceHeaders.config
    changed = true
  }

  const reports = enrichOstorosborReadPostReports(next)
  if (reports.changed) {
    next = reports.config
    changed = true
  }

  const privacy = enrichOstorosborPrivacy(next)
  if (privacy.changed) {
    next = privacy.config
    changed = true
  }

  return { config: next, changed }
}
