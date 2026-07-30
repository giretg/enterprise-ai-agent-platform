/**
 * Következmény-kapu policy — risk-class alapú (nem taint × side-effect).
 *
 * Alapelv: a felhasználó a workspace-munkát (Excel, script, ticket) a kéréssel
 * már engedélyezte; a kapu csak ritka, veszélyes / kilépő műveletekre marad.
 * A teljes tool-audit továbbra is visszakereshetőséget ad.
 *
 * http_api_request: kapu, ha az endpoint `risk` write/danger, VAGY a path nincs
 * a connector endpoint-katalógusában (nem allowlistelt).
 */
import type { HttpApiConfig, HttpApiEndpoint, HttpApiRisk } from '@/domain/connector/http-api-client'
import {
  canonicalizeHttpApiPath,
  httpApiPathMatches,
  resolveHttpApiEndpointRisk,
} from '@/domain/connector/http-api-client'
import { SIDE_EFFECTING_TOOLS } from '@/domain/tool-broker/tool-trust-registry'
import type { ToolName } from '@/domain/tool-broker/tool-broker-types'

/** Mindig kapuzott toolok — args-független. */
export const ALWAYS_CONSEQUENCE_GATED_TOOLS: ReadonlySet<string> = new Set<ToolName>([
  'gmail_send',
  'file_delete',
  'repo_open_pull_request',
  'sandbox.request_promotion',
  'sandbox.commit',
  'memory_propose',
])

export type ConsequenceGateReason =
  | 'high_risk_tool'
  | 'http_api_not_allowlisted'
  | 'http_api_write_or_danger'
  | 'unknown_tool'

export type ConsequenceGateDecision = {
  required: boolean
  reason?: ConsequenceGateReason
}

export type HttpApiGateConnector = {
  id: string
  config: HttpApiConfig
}

/**
 * Kell-e emberi jóváhagyás ehhez a tool-híváshoz?
 * A taint (külső adat a fordulóban) NEM dönt — csak a tool kockázati osztálya.
 */
export function requiresConsequenceApproval(
  tool: string,
  args?: Record<string, unknown>,
  httpApiConnectors?: HttpApiGateConnector[],
): ConsequenceGateDecision {
  if (tool === 'http_api_request') {
    return evaluateHttpApiRequestGate(args ?? {}, httpApiConnectors ?? [])
  }
  if (ALWAYS_CONSEQUENCE_GATED_TOOLS.has(tool)) {
    return { required: true, reason: 'high_risk_tool' }
  }
  // Fail-safe: ismeretlen tool → kapu (mint a side-effect regiszternél).
  if (!(tool in SIDE_EFFECTING_TOOLS)) {
    return { required: true, reason: 'unknown_tool' }
  }
  return { required: false }
}

export function evaluateHttpApiRequestGate(
  args: Record<string, unknown>,
  connectors: HttpApiGateConnector[],
): ConsequenceGateDecision {
  const method = String(args.method ?? 'POST').toUpperCase()
  const path = typeof args.path === 'string' ? args.path : ''
  if (!path) {
    return { required: true, reason: 'http_api_not_allowlisted' }
  }

  const connector = pickHttpApiConnector(args.connectorId, connectors)
  if (!connector) {
    // Nincs feloldható katalógus → fail-safe kapu.
    return { required: true, reason: 'http_api_not_allowlisted' }
  }

  const { config } = connector
  if (config.defaultRisk === 'write' || config.defaultRisk === 'danger') {
    return { required: true, reason: 'http_api_write_or_danger' }
  }

  let normalizedPath: string
  try {
    normalizedPath = canonicalizeHttpApiPath(path)
  } catch {
    return { required: true, reason: 'http_api_not_allowlisted' }
  }
  const endpoint = findHttpApiEndpoint(config.endpoints, method, normalizedPath)
  if (!endpoint) {
    return { required: true, reason: 'http_api_not_allowlisted' }
  }

  const risk = resolveHttpApiEndpointRisk(endpoint, method, config.defaultRisk)
  if (risk === 'write' || risk === 'danger') {
    return { required: true, reason: 'http_api_write_or_danger' }
  }
  return { required: false }
}

function pickHttpApiConnector(
  connectorId: unknown,
  connectors: HttpApiGateConnector[],
): HttpApiGateConnector | null {
  if (typeof connectorId === 'string' && connectorId.trim()) {
    return connectors.find((c) => c.id === connectorId) ?? null
  }
  if (connectors.length === 1) return connectors[0]
  return null
}

function findHttpApiEndpoint(
  endpoints: HttpApiEndpoint[] | undefined,
  method: string,
  path: string,
): HttpApiEndpoint | undefined {
  if (!endpoints?.length) return undefined
  return endpoints.find((e) => e.method === method && httpApiPathMatches(e.path, path))
}

export function consequenceGateReasonForModel(reason: ConsequenceGateReason | undefined): string {
  switch (reason) {
    case 'http_api_not_allowlisted':
      return 'a hívott HTTP végpont nincs a connector engedélyezett listáján'
    case 'http_api_write_or_danger':
      return 'a HTTP hívás író / veszélyes (write vagy danger) végpontra megy'
    case 'unknown_tool':
      return 'ez egy nem besorolt eszköz, ezért óvatosságból jóváhagyást kérünk'
    case 'high_risk_tool':
    default:
      return 'ez a művelet kilép a munkaterületről, visszafordíthatatlan, vagy tartós rendszerállapotot változtat'
  }
}

export type { HttpApiRisk }
