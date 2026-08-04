/**
 * Következmény-kapu policy — risk-class alapú (nem taint × side-effect).
 *
 * Alapelv: a felhasználó a workspace-munkát (Excel, script, ticket) a kéréssel
 * már engedélyezte; a kapu csak ritka, veszélyes / kilépő műveletekre marad.
 * A teljes tool-audit továbbra is visszakereshetőséget ad.
 *
 * http_api_request: kapu, ha az endpoint `risk` write/danger, VAGY a path nincs
 * a connector endpoint-katalógusában (nem allowlistelt).
 *
 * issue #220 — `preapproved` trust: allowlistelt write(/danger) hívás kapu nélkül,
 * ha az admin tudatosan megadta; nem allowlistelt path mindig kapu (fail-safe).
 */
import type { HttpApiConfig, HttpApiEndpoint, HttpApiRisk } from '@/domain/connector/http-api-client'
import { httpApiPathMatches, resolveHttpApiEndpointRisk } from '@/domain/connector/http-api-client'
import { SIDE_EFFECTING_TOOLS } from '@/domain/tool-broker/tool-trust-registry'
import type { ToolName } from '@/domain/tool-broker/tool-broker-types'
import {
  DEFAULT_WRITE_APPROVAL_TRUST,
  type WriteApprovalTrust,
} from '@/domain/tool-broker/write-approval-trust'

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

export type PreapprovedSkipInfo = {
  connectorId: string
  connectorName: string
  trustMode: 'lax' | 'strict'
  used: number
  limit: number | null
  risk: 'write' | 'danger'
}

export type ConsequenceGateDecision = {
  required: boolean
  reason?: ConsequenceGateReason
  /** Kapu-skip `preapproved` miatt — a loop ebből emel státuszt / számol budgetet. */
  preapprovedSkip?: PreapprovedSkipInfo
}

export type HttpApiGateConnector = {
  id: string
  /** Megjelenítő név (státusz / összesítő). Hiányában az id. */
  name?: string
  config: HttpApiConfig
  /** Agent–connector assignment: csak `write` mellett futhat `http_api_request`. */
  accessMode: 'read' | 'write'
  /** Hiányában `per_call` (mai viselkedés). */
  writeApproval?: WriteApprovalTrust
}

/** Futásonkénti preapproved író-hívás számláló (connectorId → használt). */
export type PreapprovedRunBudget = {
  usedByConnector: Map<string, number>
}

export function createPreapprovedRunBudget(): PreapprovedRunBudget {
  return { usedByConnector: new Map() }
}

/**
 * Kell-e emberi jóváhagyás ehhez a tool-híváshoz?
 * A taint (külső adat a fordulóban) NEM dönt — csak a tool kockázati osztálya.
 */
export function requiresConsequenceApproval(
  tool: string,
  args?: Record<string, unknown>,
  httpApiConnectors?: HttpApiGateConnector[],
  budget?: PreapprovedRunBudget,
  now: Date = new Date(),
): ConsequenceGateDecision {
  if (tool === 'http_api_request') {
    return evaluateHttpApiRequestGate(args ?? {}, httpApiConnectors ?? [], budget, now)
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

/**
 * Írásjog-ellenőrzés a következmény-kapu ELŐTT.
 * Read-only assignment mellett a POST/PUT/… ne nyisson jóváhagyási kártyát —
 * az úgysem futna le (`missing_http_api_connector_write_*`).
 *
 * Ha a connector nincs a katalógusban, nem döntünk itt (a broker authorizer dönt).
 */
export function evaluateHttpApiWriteGrant(
  args: Record<string, unknown>,
  connectors: HttpApiGateConnector[],
): { allowed: true } | { allowed: false; reason: string; connectorId: string } {
  const connector = pickHttpApiConnector(args.connectorId, connectors)
  if (!connector) return { allowed: true }
  if (connector.accessMode === 'write') return { allowed: true }
  return {
    allowed: false,
    reason: `missing_http_api_connector_write_${connector.id}`,
    connectorId: connector.id,
  }
}

/** Modellnek szóló, actionable denied szöveg read-only connector + http_api_request esetén. */
export function httpApiWriteGrantDeniedMessage(reason: string, connectorId: string): string {
  return (
    `DENIED: ${reason}. Ehhez a connectorhoz (connectorId=${connectorId}) csak olvasási jogod van — ` +
    `a http_api_request (POST/PUT/PATCH/DELETE) nem futtatható, és jóváhagyással sem oldható fel. ` +
    `Használj http_api_get-et (GET) olvasáshoz, vagy kérd meg a felhasználót, hogy írási jogot rendeljen a connectorhoz. ` +
    `NE indítsd újra ugyanezt a http_api_request hívást.`
  )
}

export function evaluateHttpApiRequestGate(
  args: Record<string, unknown>,
  connectors: HttpApiGateConnector[],
  budget?: PreapprovedRunBudget,
  now: Date = new Date(),
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
  const normalizedPath = path.split('?')[0]
  const endpoint = findHttpApiEndpoint(config.endpoints, method, normalizedPath)

  // issue #220 — nem allowlistelt / ismeretlen path MINDIG kapu (fail-safe),
  // preapproved trust mellett is. A trust a megismert felületre szól.
  if (!endpoint) {
    // Visszafelé kompatibilis: defaultRisk write/danger esetén a régi ok is
    // `http_api_write_or_danger` volt allowlist nélkül is — de a fail-safe
    // üzenet a nem allowlistelt pathot jelzi (preapproved escape hatch NINCS).
    if (config.defaultRisk === 'write' || config.defaultRisk === 'danger') {
      return { required: true, reason: 'http_api_not_allowlisted' }
    }
    return { required: true, reason: 'http_api_not_allowlisted' }
  }

  let risk = resolveHttpApiEndpointRisk(endpoint, method, config.defaultRisk)
  // Connector-szintű defaultRisk: még allowlistelt read végponton is emel
  // (régi viselkedés: „minden request kapu").
  if (config.defaultRisk === 'write' || config.defaultRisk === 'danger') {
    risk = elevateRisk(risk, config.defaultRisk)
  }

  if (risk === 'read') {
    return { required: false }
  }

  const skip = tryPreapprovedSkip(connector, risk, budget, now)
  if (skip) return skip

  return { required: true, reason: 'http_api_write_or_danger' }
}

/**
 * Ha a kapu `preapprovedSkip`-et adott, a loop HÍVÁS ELŐTT növeli a budgetet
 * (sikertelen HTTP is számít — issue #220).
 */
export function consumePreapprovedBudget(
  budget: PreapprovedRunBudget,
  skip: PreapprovedSkipInfo,
): void {
  budget.usedByConnector.set(skip.connectorId, skip.used)
}

function tryPreapprovedSkip(
  connector: HttpApiGateConnector,
  risk: 'write' | 'danger',
  budget: PreapprovedRunBudget | undefined,
  now: Date,
): ConsequenceGateDecision | null {
  const trust = connector.writeApproval ?? DEFAULT_WRITE_APPROVAL_TRUST
  if (trust.mode !== 'preapproved' || connector.accessMode !== 'write') return null
  if (!trust.trustMode) return null

  if (risk === 'danger' && !trust.dangerPreapproved) {
    // Danger külön kapcsoló, default off — nélkül mindig per_call.
    return null
  }

  // Lejárat / visszavonás: a *következő* író hívástól per_call.
  if (trust.expiresAt && trust.expiresAt.getTime() <= now.getTime()) {
    return null
  }

  const used = budget?.usedByConnector.get(connector.id) ?? 0
  if (trust.trustMode === 'strict') {
    const limit = trust.writeLimitPerRun
    if (limit == null || used >= limit) {
      // Limit túllépés → visszaesés per_call-ra.
      return null
    }
  }

  const nextUsed = used + 1
  return {
    required: false,
    preapprovedSkip: {
      connectorId: connector.id,
      connectorName: connector.name?.trim() || connector.id,
      trustMode: trust.trustMode,
      used: nextUsed,
      limit: trust.trustMode === 'strict' ? trust.writeLimitPerRun : null,
      risk,
    },
  }
}

function elevateRisk(current: HttpApiRisk, floor: 'write' | 'danger'): HttpApiRisk {
  const rank = (r: HttpApiRisk) => (r === 'read' ? 0 : r === 'write' ? 1 : 2)
  return rank(floor) > rank(current) ? floor : current
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

export type PreapprovedRunSummary = {
  connectorId: string
  connectorName: string
  trustMode: 'lax' | 'strict'
  writeCalls: number
  limit: number | null
}

export function summarizePreapprovedBudget(
  budget: PreapprovedRunBudget,
  connectors: HttpApiGateConnector[],
): PreapprovedRunSummary[] {
  const out: PreapprovedRunSummary[] = []
  for (const [connectorId, writeCalls] of budget.usedByConnector) {
    if (writeCalls <= 0) continue
    const connector = connectors.find((c) => c.id === connectorId)
    const trust = connector?.writeApproval
    out.push({
      connectorId,
      connectorName: connector?.name?.trim() || connectorId,
      trustMode: trust?.trustMode === 'strict' ? 'strict' : 'lax',
      writeCalls,
      limit: trust?.trustMode === 'strict' ? trust.writeLimitPerRun : null,
    })
  }
  return out
}

export function formatPreapprovedRunSummary(summaries: PreapprovedRunSummary[]): string | null {
  if (summaries.length === 0) return null
  const parts = summaries.map((s) => {
    const modeLabel = s.trustMode === 'strict' ? 'szigorú' : 'laza'
    const limitPart =
      s.limit != null ? `, limit ${s.writeCalls}/${s.limit}` : `, ${s.writeCalls} író hívás`
    return `${s.connectorName} (${modeLabel}${limitPart})`
  })
  return `Írás előzetesen engedélyezve: ${parts.join('; ')}.`
}

export type { HttpApiRisk }
