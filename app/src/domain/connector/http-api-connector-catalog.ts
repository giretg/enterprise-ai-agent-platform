/**
 * HTTP API connector katalógus MCP-hez és checkout-hoz.
 * A belső chat tool-loop ugyanezt a szerződést adta a modellnek; titkot nem tartalmaz.
 */
import type { Connector, ConnectorAccessMode } from '@prisma/client'
import type { AgentConnectorBinding } from '@/repositories/interfaces'
import { pinnedRuntimeConfig } from '@/domain/connector/runtime-config'
import { effectiveConnectorRuntimeConfig } from '@/domain/connector-template/ostorosbor-config-enrichment'
import {
  parseHttpApiConfig,
  resolveHttpApiEndpointRisk,
  type HttpApiConfig,
  type HttpApiEndpoint,
  type HttpApiRisk,
} from '@/domain/connector/http-api-client'
import {
  buildHttpApiEfficiencyGuidance,
  formatHttpApiEndpointCatalogSuffix,
  type HttpApiCatalogEndpoint,
} from '@/domain/connector/http-api-prompt'

export type ConnectorCatalogEndpoint = {
  method: string
  path: string
  name?: string
  description?: string
  risk: HttpApiRisk
  callable: boolean
  queryParams?: HttpApiCatalogEndpoint['queryParams']
  pathParams?: HttpApiCatalogEndpoint['pathParams']
  headerParams?: HttpApiCatalogEndpoint['headerParams']
}

export type ConnectorCatalogEntry = {
  connectorId: string
  name: string
  type: string
  accessMode: ConnectorAccessMode
  baseUrl?: string
  description?: string
  restrictToEndpoints?: boolean
  endpoints: ConnectorCatalogEndpoint[]
  /** Emberi nyelvű blokk — ugyanaz, mint a korábbi belső chat spec. */
  guide: string
}

export type AgentConnectorCatalog = {
  summary: string
  connectors: ConnectorCatalogEntry[]
}

export type ConnectorCatalogBinding = {
  connector: {
    id: string
    name: string
    type: string
    config?: unknown
    connectorMode?: 'fixed' | 'self_updating'
  }
  accessMode: ConnectorAccessMode
  activeCapabilitySet?: unknown
}

function asCatalogEndpoint(
  endpoint: HttpApiEndpoint,
  parsed: HttpApiConfig,
  writeAllowed: boolean,
): ConnectorCatalogEndpoint {
  const method = String(endpoint.method ?? 'GET').toUpperCase()
  const risk = resolveHttpApiEndpointRisk(endpoint, method, parsed.defaultRisk)
  return {
    method,
    path: endpoint.path,
    ...(endpoint.description ? { description: endpoint.description } : {}),
    risk,
    callable: writeAllowed || risk === 'read',
    ...(endpoint.queryParams ? { queryParams: endpoint.queryParams } : {}),
    ...(endpoint.pathParams ? { pathParams: endpoint.pathParams } : {}),
    ...(endpoint.headerParams ? { headerParams: endpoint.headerParams } : {}),
  }
}

function resolveRuntimeConfig(binding: ConnectorCatalogBinding): HttpApiConfig | null {
  const pinned = pinnedRuntimeConfig(
    binding.connector.connectorMode ?? 'fixed',
    binding.connector.config ?? {},
    binding.activeCapabilitySet,
  )
  if (!pinned) return null
  try {
    return parseHttpApiConfig(effectiveConnectorRuntimeConfig(pinned))
  } catch {
    return null
  }
}

function renderHttpApiGuide(input: {
  name: string
  connectorId: string
  accessMode: ConnectorAccessMode
  config: HttpApiConfig
  endpoints: ConnectorCatalogEndpoint[]
}): string {
  const writeAllowed = input.accessMode === 'write'
  const lines = [`### ${input.name}`, `connectorId: ${input.connectorId}`]
  lines.push(`Hozzáférés: ${writeAllowed ? 'olvasás + írás' : 'csak olvasás'}`)
  if (!writeAllowed) {
    lines.push(
      'ÍRÁSJOG NINCS: ezen a connectoron a http_api_request (POST/PUT/PATCH/DELETE) TILOS. Csak http_api_get / http_api_get_all (GET) hívható.',
    )
  }
  if (input.config.baseUrl) lines.push(`Base URL: ${input.config.baseUrl}`)
  if (input.config.description) lines.push(input.config.description)
  if (input.config.defaultRisk) lines.push(`Alap kockázat (defaultRisk): ${input.config.defaultRisk}`)
  if (input.endpoints.length > 0) {
    lines.push('Endpointok:')
    for (const endpoint of input.endpoints) {
      const riskHint = ` [risk=${endpoint.risk}]`
      const unavailable = !endpoint.callable ? ' — NEM HÍVHATÓ (nincs írásjog)' : ''
      const desc = endpoint.description ? ` — ${endpoint.description}` : ''
      const catalogSuffix = formatHttpApiEndpointCatalogSuffix(endpoint)
      lines.push(
        `- ${endpoint.method} ${endpoint.path}${riskHint}${desc}${catalogSuffix}${unavailable}`,
      )
    }
    if (input.config.restrictToEndpoints === true) {
      lines.push(
        'Csak az itt felsorolt végpontok hívhatók — minden más hívást a rendszer elutasít (endpoint_not_allowed), mielőtt a külső rendszert megkeresné.',
      )
    }
    if (writeAllowed) {
      lines.push(
        'Író / danger végpont (risk=write|danger) vagy listán kívüli path → http_api_request emberi jóváhagyást kér.',
      )
    } else {
      lines.push(
        'Olvasó (risk=read / GET) végpont → http_api_get vagy lapozott listához http_api_get_all. A „NEM HÍVHATÓ” végpontokat ne próbáld http_api_request-tel.',
      )
    }
  }
  return lines.join('\n')
}

function renderNonHttpGuide(binding: ConnectorCatalogBinding): ConnectorCatalogEntry {
  const { connector, accessMode } = binding
  const writeAllowed = accessMode === 'write'
  const lines = [`### ${connector.name}`, `connectorId: ${connector.id}`, `Típus: ${connector.type}`]
  lines.push(`Hozzáférés: ${writeAllowed ? 'olvasás + írás' : 'csak olvasás'}`)
  if (connector.type === 'gmail') {
    lines.push('Gmail: gmail_search → gmail_get_message. OAuth szükséges, ha authorizationUrl jön vissza.')
  } else if (connector.type === 'google_drive') {
    lines.push(
      'Google Drive: google_drive_search → google_drive_read_file. Írás (mappa, feltöltés, sheet) jóváhagyást kér.',
    )
  } else if (connector.type === 'knowledge_base') {
    lines.push('Tudásbázis: kb_search, kb_list_index, kb_get_page, kb_ingest.')
  }
  return {
    connectorId: connector.id,
    name: connector.name,
    type: connector.type,
    accessMode,
    endpoints: [],
    guide: lines.join('\n'),
  }
}

export function buildHttpApiConnectorCatalogEntry(
  binding: ConnectorCatalogBinding,
): ConnectorCatalogEntry | null {
  if (binding.connector.type !== 'http_api') return null
  const parsed = resolveRuntimeConfig(binding)
  if (!parsed) return null
  const writeAllowed = binding.accessMode === 'write'
  const endpoints = (parsed.endpoints ?? []).map((endpoint) =>
    asCatalogEndpoint(endpoint, parsed, writeAllowed),
  )
  return {
    connectorId: binding.connector.id,
    name: binding.connector.name,
    type: binding.connector.type,
    accessMode: binding.accessMode,
    baseUrl: parsed.baseUrl,
    ...(parsed.description ? { description: parsed.description } : {}),
    ...(parsed.restrictToEndpoints ? { restrictToEndpoints: true } : {}),
    endpoints,
    guide: renderHttpApiGuide({
      name: binding.connector.name,
      connectorId: binding.connector.id,
      accessMode: binding.accessMode,
      config: parsed,
      endpoints,
    }),
  }
}

export function buildAgentConnectorCatalog(
  bindings: ConnectorCatalogBinding[],
): AgentConnectorCatalog {
  const sorted = [...bindings].sort(
    (a, b) =>
      a.connector.name.localeCompare(b.connector.name) ||
      a.connector.id.localeCompare(b.connector.id),
  )
  const connectors: ConnectorCatalogEntry[] = []
  for (const binding of sorted) {
    if (binding.connector.type === 'http_api') {
      const entry = buildHttpApiConnectorCatalogEntry(binding)
      if (entry) connectors.push(entry)
      continue
    }
    connectors.push(renderNonHttpGuide(binding))
  }

  const httpCount = connectors.filter((row) => row.type === 'http_api').length
  const summaryParts = [
    'Külső rendszerek MCP-n: http_api_get / http_api_get_all / http_api_request (path a connector Base URL-hez relatív; auth és trace fejlécek a szerveren maradnak).',
    'A path és query paramétereket a connectorCatalog.endpoints[] szerződésből vedd — ne találj ki végpontot (/orders, /sales stb.), ha nincs a listában.',
    buildHttpApiEfficiencyGuidance(),
  ]
  if (httpCount > 0) {
    summaryParts.unshift(
      `${httpCount} HTTP API connector katalógus alább (strukturált endpoints[] + guide mező).`,
    )
  }

  return { summary: summaryParts.join('\n\n'), connectors }
}

type ConnectorWithActiveSpec = Connector & {
  activeSpecVersion?: { capabilitySet: unknown } | null
}

export function connectorCatalogBindingsFromAgent(
  bindings: AgentConnectorBinding[],
): ConnectorCatalogBinding[] {
  return bindings.map((row) => {
    const connector = row.connector as ConnectorWithActiveSpec
    return {
      connector: {
        id: connector.id,
        name: connector.name,
        type: connector.type,
        config: connector.config,
        connectorMode: connector.connectorMode,
      },
      accessMode: row.accessMode,
      activeCapabilitySet: connector.activeSpecVersion?.capabilitySet,
    }
  })
}

export function buildAgentConnectorCatalogFromBindings(
  bindings: AgentConnectorBinding[],
): AgentConnectorCatalog {
  return buildAgentConnectorCatalog(connectorCatalogBindingsFromAgent(bindings))
}

export function formatAgentConnectorCatalogMarkdown(catalog: AgentConnectorCatalog): string {
  const lines = ['## Connector API katalógus', '', catalog.summary, '']
  for (const connector of catalog.connectors) {
    lines.push(connector.guide, '')
  }
  return `${lines.join('\n').trim()}\n`
}
