/**
 * Generikus HTTP/REST API connector — vékony adapter a Tool Broker mögött.
 *
 * Egy `http_api` típusú connector egy külső REST API-t ír le (baseUrl + auth +
 * endpoint-katalógus). A Broker oldja fel az API-kulcsot a connector
 * `secretAlias`-ából (env vagy Secret Manager), és injektálja a hitelesítő
 * fejlécbe — a kulcs SOHA nem kerül a promptba, az argumentumokba vagy a logba.
 *
 * A modell egy generikus `http_api_get` (olvasás) / `http_api_request` (írás)
 * eszközzel hív; az endpoint-katalógus (config.endpoints + config.description)
 * a tool loopban kerül a modell elé.
 */
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { getCloudRunAccessToken } from '@/domain/net/cloud-run-auth'
import { guardEgressUrl } from '@/domain/net/egress-guard'
import {
  httpPaginationSchema,
  type HttpPagination,
} from '@/domain/provisioning/connector-config'
import {
  GITHUB_REPOSITORY_PATTERN,
  parseGitHubRepositoryAccessConfig,
  type GitHubRepositoryAccess,
} from './github-repository-access'
import { decodeGitHubContentsBody } from './decode-github-contents-body'
import {
  buildHttpApiClientErrorHint,
  buildHttpApiOversizedResponseHint,
  buildHttpApiTruncationBody,
} from './http-api-prompt'

export type HttpApiAuthConfig =
  | { scheme: 'header'; header: string }
  | { scheme: 'bearer' }
  | { scheme: 'basic' }
  | { scheme: 'none' }
  | {
      scheme: 'oauth2'
      tokenUrl: string
      clientId: string
      scope?: string
      authUrl?: string
      userInfoUrl?: string
      accountEmailField?: string
      offlineParams?: Record<string, string>
      scopeTransform?: 'none' | 'gmailAlias'
    }

/** Következmény-kapu / dokumentáció: endpoint kockázati osztálya. */
export type HttpApiRisk = 'read' | 'write' | 'danger'

/** OpenAPI / kézi config: query vagy path param a modell-katalógushoz. */
export type HttpApiEndpointParam = {
  name: string
  required: boolean
  type?: string
  description?: string
}

/** Végpont-katalógus sor a modellnek/MCP-kliensnek — titkot sosem tartalmaz. */
export type HttpApiEndpointSummary = {
  method: string
  path: string
  access?: 'read' | 'write'
  description?: string
  queryParams?: HttpApiEndpointParam[]
  pathParams?: HttpApiEndpointParam[]
}

/**
 * A connector engedélyezett végpontjai emberi/modell-olvasható alakban — ugyanaz
 * a lista, ami a hívást is engedélyezi (`config.endpoints`), csak titok nélkül.
 * Ezt kapja meg az agent-definíció (proaktív felfedezés) és az `endpoint_not_allowed`
 * hiba is (reaktív felfedezés, ha mégis rossz path-ot próbált).
 */
export function summarizeHttpApiEndpoints(
  endpoints: HttpApiEndpoint[] | undefined,
): HttpApiEndpointSummary[] {
  return (endpoints ?? []).map((endpoint) => ({
    method: endpoint.method,
    path: endpoint.path,
    ...(endpoint.access ? { access: endpoint.access } : {}),
    ...(endpoint.description ? { description: endpoint.description } : {}),
    ...(endpoint.queryParams?.length ? { queryParams: endpoint.queryParams } : {}),
    ...(endpoint.pathParams?.length ? { pathParams: endpoint.pathParams } : {}),
  }))
}

export type HttpApiEndpoint = {
  method: string
  path: string
  description?: string
  profile?: string
  idempotent?: boolean
  /**
   * Következmény-kapu jelölés. Ha hiányzik, a kapu a metódusból / legacy
   * `access` mezőből vezeti le (`resolveHttpApiEndpointRisk`).
   */
  risk?: HttpApiRisk
  /** Legacy sablon-mező (`proposedTools.access`) — a parse `risk`-re is leképezheti. */
  access?: 'read' | 'write'
  headers?: Record<string, string>
  headerParams?: Array<{ name: string; required: boolean }>
  /**
   * Platform-sablon fejlécek (requestHeaders/writeHeaders/headers), amiket EZ az
   * endpoint az OpenAPI-ja szerint `required: false`-nak jelöl (pl. X-Acting-User,
   * ha nincs bejelentkezett actingUser). Ha a sablon nem tud feloldódni, ezekre
   * NEM dobunk hibát — a fejlécet egyszerűen kihagyjuk a hívásból.
   */
  optionalPlatformHeaders?: ReadonlySet<string>
  /** Dokumentált query paraméterek — a modell elé kerülnek a tool loopban. */
  queryParams?: HttpApiEndpointParam[]
  /** Dokumentált path paraméterek (template mellett). */
  pathParams?: HttpApiEndpointParam[]
  pagination?: HttpPagination
}

export type HttpApiAuthProfile = {
  secretAlias: string
  auth?: HttpApiAuthConfig
}

export type HttpApiConfig = {
  baseUrl: string
  auth: HttpApiAuthConfig
  /** Több auth-profil egy connectoron belül, pl. readonly/write kulcsok. */
  authProfiles?: Record<string, HttpApiAuthProfile>
  /** Endpoint profile hiányában ez a profil használatos. */
  defaultAuthProfile?: string
  /** Minden hívásra injektált, sablonozható fejlécek. */
  requestHeaders?: Record<string, string>
  /** Acting user fallback, ha a chat actingUser.email hiányzik (Ostorosbor CRM). */
  defaultActingUserEmail?: string
  /** Csak író hívásokra injektált, sablonozható fejlécek. */
  writeHeaders?: Record<string, string>
  /** Emberi nyelvű API-leírás — a modell elé kerül a tool loopban. */
  description?: string
  /** Ismert endpointok (dokumentáció + opcionális allowlist). */
  endpoints?: HttpApiEndpoint[]
  /** Ha true: csak az `endpoints` listában szereplő (method+path) hívható. */
  restrictToEndpoints?: boolean
  /**
   * Connector-szintű alap kockázat a következmény-kapuhoz. Ha `write`/`danger`,
   * minden `http_api_request` kapuzott (még allowlistelt read végponton is).
   */
  defaultRisk?: HttpApiRisk
  /** GitHub connector repository-határa. Hiánya visszafelé kompatibilisen `any`. */
  githubRepositoryAccess?: GitHubRepositoryAccess
  /** Maximális válasz-méret karakterben (alap: 20000). */
  maxResponseChars?: number
  /** Önfrissítő snapshotból materializált config: minden hívásnál egress-őr. */
  selfUpdatingPinned?: boolean
}

const HTTP_API_RISKS = new Set<HttpApiRisk>(['read', 'write', 'danger'])

function parseHttpApiRisk(raw: unknown): HttpApiRisk | undefined {
  return typeof raw === 'string' && HTTP_API_RISKS.has(raw as HttpApiRisk)
    ? (raw as HttpApiRisk)
    : undefined
}

/**
 * Endpoint kockázat feloldása a kapuhoz: explicit `risk` → legacy `access` →
 * connector `defaultRisk` → HTTP metódus heurisztika (DELETE=danger, GET=read, egyéb=write).
 */
export function resolveHttpApiEndpointRisk(
  endpoint: Pick<HttpApiEndpoint, 'risk' | 'access'>,
  method: string,
  connectorDefaultRisk?: HttpApiRisk,
): HttpApiRisk {
  if (endpoint.risk) return endpoint.risk
  if (endpoint.access === 'read') return 'read'
  if (endpoint.access === 'write') {
    // access=write mellett a DELETE továbbra is danger (visszafordíthatatlan).
    return method.toUpperCase() === 'DELETE' ? 'danger' : 'write'
  }
  if (connectorDefaultRisk) return connectorDefaultRisk
  return riskFromHttpMethod(method)
}

export function riskFromHttpMethod(method: string): HttpApiRisk {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD') return 'read'
  if (m === 'DELETE') return 'danger'
  return 'write'
}

const READ_METHODS = new Set(['GET', 'HEAD'])
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const DEFAULT_MAX_RESPONSE_CHARS = 20_000
/** Runtime által injektált idempotencia-fejléc (kisbetűs egyeztetéshez). */
const IDEMPOTENCY_HEADER_LOWER = 'idempotency-key'
/**
 * Hány azonos-host átirányítás követhető egy connector-híváson belül (deny-by-default a
 * más hostra mutató redirectekre). Ugyanaz a szigor, mint a `web_fetch` útján — a redirect
 * nem viheti ki a hívást a connector konfigurált hostjáról (SSRF-védelem).
 */
const MAX_SAME_HOST_REDIRECTS = 3

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Az átalakított body mérete karakterben; körkörös/serializálhatatlan alaknál a nyers hossz. */
function safeJsonLength(value: unknown, fallback: number): number {
  try {
    return JSON.stringify(value)?.length ?? fallback
  } catch {
    return fallback
  }
}

/**
 * A connector `config` JSON validálása. Hibás konfigot dob — a Broker ezt
 * `tool_call_failed`-ként jelenti, nem szivárogtat kulcsot.
 * `allowMissingOAuthClientId` csak delegált draftra: service-oauth2-nél a refresh a clientId-t igényli.
 */
export function parseHttpApiConfig(
  raw: unknown,
  opts?: { allowMissingOAuthClientId?: boolean },
): HttpApiConfig {
  if (!isRecord(raw)) throw new Error('http_api connector config must be an object')

  const baseUrl = raw.baseUrl
  if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl)) {
    throw new Error('http_api config.baseUrl must be an absolute http(s) URL')
  }

  const authRaw = raw.auth
  if (!isRecord(authRaw)) throw new Error('http_api config.auth is required')
  let auth: HttpApiAuthConfig
  if (authRaw.scheme === 'bearer') {
    auth = { scheme: 'bearer' }
  } else if (authRaw.scheme === 'header') {
    if (typeof authRaw.header !== 'string' || !authRaw.header.trim()) {
      throw new Error('http_api config.auth.header is required for scheme "header"')
    }
    auth = { scheme: 'header', header: authRaw.header.trim() }
  } else if (authRaw.scheme === 'basic' || authRaw.type === 'basic') {
    auth = { scheme: 'basic' }
  } else if (authRaw.scheme === 'oauth2' || authRaw.type === 'oauth2') {
    const tokenUrl = typeof authRaw.tokenUrl === 'string' ? authRaw.tokenUrl.trim() : ''
    if (!/^https?:\/\//i.test(tokenUrl)) {
      throw new Error('http_api config.auth.tokenUrl must be an absolute http(s) URL for scheme "oauth2"')
    }
    const clientId = typeof authRaw.clientId === 'string' ? authRaw.clientId.trim() : ''
    if (!clientId && !opts?.allowMissingOAuthClientId) {
      throw new Error('http_api config.auth.clientId is required for scheme "oauth2"')
    }
    const scope = typeof authRaw.scope === 'string' && authRaw.scope.trim() ? authRaw.scope.trim() : undefined
    const authUrl = parseOptionalAbsoluteUrl(authRaw.authUrl, 'auth.authUrl')
    const userInfoUrl = parseOptionalAbsoluteUrl(authRaw.userInfoUrl, 'auth.userInfoUrl')
    const accountEmailField =
      typeof authRaw.accountEmailField === 'string' && authRaw.accountEmailField.trim()
        ? authRaw.accountEmailField.trim()
        : undefined
    const offlineParams = parseStringRecord(authRaw.offlineParams, 'auth.offlineParams')
    const scopeTransform =
      authRaw.scopeTransform === 'gmailAlias' || authRaw.scopeTransform === 'none'
        ? authRaw.scopeTransform
        : undefined
    auth = {
      scheme: 'oauth2',
      tokenUrl,
      clientId,
      ...(scope ? { scope } : {}),
      ...(authUrl ? { authUrl } : {}),
      ...(userInfoUrl ? { userInfoUrl } : {}),
      ...(accountEmailField ? { accountEmailField } : {}),
      ...(offlineParams ? { offlineParams } : {}),
      ...(scopeTransform ? { scopeTransform } : {}),
    }
  } else if (authRaw.type === 'bearer_token') {
    auth = { scheme: 'bearer' }
  } else if (authRaw.type === 'api_key_header') {
    const header = typeof authRaw.headerName === 'string' ? authRaw.headerName.trim() : ''
    if (!header) {
      throw new Error('http_api config.auth.headerName is required for type "api_key_header"')
    }
    auth = { scheme: 'header', header }
  } else if (authRaw.type === 'none' || authRaw.scheme === 'none') {
    auth = { scheme: 'none' }
  } else {
    throw new Error('http_api config.auth.scheme must be "header", "bearer", "basic", "none" or "oauth2"')
  }

  const requestHeaders = parseHeaderTemplates(raw.requestHeaders, 'requestHeaders')
  const writeHeaders = parseHeaderTemplates(raw.writeHeaders, 'writeHeaders')

  const endpointSource = Array.isArray(raw.endpoints)
    ? raw.endpoints
    : Array.isArray(raw.proposedTools)
      ? raw.proposedTools
      : undefined
  const endpoints = Array.isArray(endpointSource)
    ? endpointSource
        .filter(isRecord)
        .map((e) => {
          const access =
            e.access === 'read' || e.access === 'write' ? (e.access as 'read' | 'write') : undefined
          const risk = parseHttpApiRisk(e.risk)
          const method = String(e.method ?? '').toUpperCase()
          const headers = parseHeaderTemplates(e.headers, 'endpoint.headers')
          const platformHeaders = headerNameSet(
            requestHeaders,
            !READ_METHODS.has(method) ? writeHeaders : undefined,
            headers,
          )
          if (e.idempotent === true && !READ_METHODS.has(method)) {
            platformHeaders.add(IDEMPOTENCY_HEADER_LOWER)
          }
          const headerParams = parseEndpointHeaderParams(e, platformHeaders)
          const optionalPlatformHeaders = parseOptionalPlatformHeaders(e, platformHeaders)
          const queryParams = parseEndpointLocationParams(e, 'query')
          const pathParams = parseEndpointLocationParams(e, 'path')
          const paginationResult = httpPaginationSchema.safeParse(e.pagination)
          return {
            method,
            path: String(e.path ?? ''),
            description: typeof e.description === 'string' ? e.description : undefined,
            profile: typeof e.profile === 'string' && e.profile.trim() ? e.profile.trim() : undefined,
            idempotent: e.idempotent === true,
            ...(risk ? { risk } : {}),
            ...(access ? { access } : {}),
            headers,
            ...(headerParams ? { headerParams } : {}),
            ...(optionalPlatformHeaders ? { optionalPlatformHeaders } : {}),
            ...(queryParams ? { queryParams } : {}),
            ...(pathParams ? { pathParams } : {}),
            ...(paginationResult.success ? { pagination: paginationResult.data } : {}),
          }
        })
        .filter((e) => e.method && e.path)
    : undefined

  const authProfiles = parseAuthProfiles(raw.authProfiles)
  const githubRepositoryAccess = parseGitHubRepositoryAccessConfig(raw.githubRepositoryAccess)

  const defaultRisk = parseHttpApiRisk(raw.defaultRisk)

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    auth,
    ...(authProfiles ? { authProfiles } : {}),
    ...(defaultRisk ? { defaultRisk } : {}),
    defaultAuthProfile:
      typeof raw.defaultAuthProfile === 'string' && raw.defaultAuthProfile.trim()
        ? raw.defaultAuthProfile.trim()
        : undefined,
    requestHeaders,
    writeHeaders,
    defaultActingUserEmail:
      typeof raw.defaultActingUserEmail === 'string' && raw.defaultActingUserEmail.trim()
        ? raw.defaultActingUserEmail.trim()
        : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    endpoints,
    restrictToEndpoints: raw.restrictToEndpoints === true,
    ...(githubRepositoryAccess ? { githubRepositoryAccess } : {}),
    maxResponseChars:
      typeof raw.maxResponseChars === 'number' && raw.maxResponseChars > 0
        ? raw.maxResponseChars
        : DEFAULT_MAX_RESPONSE_CHARS,
    selfUpdatingPinned: raw.selfUpdatingPinned === true,
  }
}

/** Kisbetűs fejlécnevek uniója — platform-sablon kulcsok gyűjtéséhez. */
export function headerNameSet(
  ...sources: Array<Record<string, string> | Set<string> | undefined | null>
): Set<string> {
  const names = new Set<string>()
  for (const source of sources) {
    if (!source) continue
    if (source instanceof Set) {
      for (const name of source) names.add(name.toLowerCase())
      continue
    }
    for (const name of Object.keys(source)) names.add(name.toLowerCase())
  }
  return names
}

/**
 * Query / path paramok OpenAPI `parameters` vagy kézi `queryParams`/`pathParams` mezőből.
 * A modell-katalógus és a 4xx hint ezekre épül — header-eket nem ide gyűjtjük.
 */
function parseEndpointLocationParams(
  endpoint: Record<string, unknown>,
  location: 'query' | 'path',
): HttpApiEndpointParam[] | undefined {
  const explicitKey = location === 'query' ? 'queryParams' : 'pathParams'
  const fromExplicit = Array.isArray(endpoint[explicitKey])
    ? endpoint[explicitKey]
        .filter(
          (param): param is Record<string, unknown> => isRecord(param) && typeof param.name === 'string',
        )
        .map((param) => toEndpointParam(param, location === 'path'))
    : []
  const fromParameters = Array.isArray(endpoint.parameters)
    ? endpoint.parameters
        .filter(
          (param): param is Record<string, unknown> =>
            isRecord(param) && param.in === location && typeof param.name === 'string',
        )
        .map((param) => toEndpointParam(param, location === 'path'))
    : []
  const byName = new Map<string, HttpApiEndpointParam>()
  for (const param of [...fromParameters, ...fromExplicit]) {
    byName.set(param.name.toLowerCase(), param)
  }
  return byName.size > 0 ? [...byName.values()] : undefined
}

function toEndpointParam(param: Record<string, unknown>, pathDefaultRequired: boolean): HttpApiEndpointParam {
  const type =
    typeof param.type === 'string' && param.type.trim()
      ? param.type.trim()
      : isRecord(param.schema) && typeof param.schema.type === 'string'
        ? String(param.schema.type)
        : undefined
  const description =
    typeof param.description === 'string' && param.description.trim()
      ? param.description.trim()
      : undefined
  return {
    name: String(param.name),
    required: pathDefaultRequired || param.required === true,
    ...(type ? { type } : {}),
    ...(description ? { description } : {}),
  }
}

function parseEndpointHeaderParams(
  endpoint: Record<string, unknown>,
  platformHeaders: Set<string>,
): Array<{ name: string; required: boolean }> | undefined {
  const fromParameters = Array.isArray(endpoint.parameters)
    ? endpoint.parameters
        .filter(
          (param): param is Record<string, unknown> =>
            isRecord(param) && param.in === 'header' && typeof param.name === 'string',
        )
        .map((param) => ({ name: String(param.name), required: param.required === true }))
    : []
  const fromHeaderParams = Array.isArray(endpoint.headerParams)
    ? endpoint.headerParams
        .filter(
          (param): param is Record<string, unknown> => isRecord(param) && typeof param.name === 'string',
        )
        .map((param) => ({ name: String(param.name), required: param.required === true }))
    : []
  const byName = new Map<string, { name: string; required: boolean }>()
  for (const param of [...fromParameters, ...fromHeaderParams]) {
    const lower = param.name.toLowerCase()
    if (platformHeaders.has(lower)) continue
    byName.set(lower, param)
  }
  return byName.size > 0 ? [...byName.values()] : undefined
}

/**
 * A platform-sablon fejlécek (X-Agent-Id, X-Acting-User, stb.) közül melyeket
 * jelöl EZ az endpoint `required: false`-nak a saját OpenAPI-jában. `parseEndpointHeaderParams`
 * pont ezeket zárja ki (azok a modellnek szóló, nem-platform fejlécek) — itt a
 * fordítottja kell: csak a platform-fejlécek, hogy tudjuk melyiket lehet kihagyni,
 * ha a sablon-értéke (pl. actingUser.email) nem áll rendelkezésre.
 */
function parseOptionalPlatformHeaders(
  endpoint: Record<string, unknown>,
  platformHeaders: Set<string>,
): Set<string> | undefined {
  const params = Array.isArray(endpoint.parameters)
    ? endpoint.parameters.filter(
        (param): param is Record<string, unknown> =>
          isRecord(param) && param.in === 'header' && typeof param.name === 'string',
      )
    : []
  const optional = new Set<string>()
  for (const param of params) {
    const lower = String(param.name).toLowerCase()
    if (platformHeaders.has(lower) && param.required !== true) optional.add(lower)
  }
  return optional.size > 0 ? optional : undefined
}

function parseOptionalAbsoluteUrl(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw.trim())) {
    throw new Error(`http_api config.${field} must be an absolute http(s) URL`)
  }
  return raw.trim()
}

function parseStringRecord(raw: unknown, field: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new Error(`http_api config.${field} must be an object`)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim()) throw new Error(`http_api config.${field} has empty key`)
    if (typeof value !== 'string') {
      throw new Error(`http_api config.${field}.${key} must be a string`)
    }
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseAuthProfiles(raw: unknown): Record<string, HttpApiAuthProfile> | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new Error('http_api config.authProfiles must be an object')

  const profiles: Record<string, HttpApiAuthProfile> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(`http_api auth profile has invalid name: ${name}`)
    }
    if (!isRecord(value)) throw new Error(`http_api auth profile must be an object: ${name}`)
    if (typeof value.secretAlias !== 'string' || !value.secretAlias.trim()) {
      throw new Error(`http_api auth profile has no secretAlias: ${name}`)
    }

    let auth: HttpApiAuthConfig | undefined
    if (value.auth !== undefined) {
      if (!isRecord(value.auth)) throw new Error(`http_api auth profile auth must be an object: ${name}`)
      if (value.auth.scheme === 'bearer') auth = { scheme: 'bearer' }
      else if (value.auth.scheme === 'header') {
        if (typeof value.auth.header !== 'string' || !value.auth.header.trim()) {
          throw new Error(`http_api auth profile header is required: ${name}`)
        }
        auth = { scheme: 'header', header: value.auth.header.trim() }
      } else {
        throw new Error(`http_api auth profile scheme must be "header" or "bearer": ${name}`)
      }
    }

    profiles[name] = { secretAlias: value.secretAlias.trim(), ...(auth ? { auth } : {}) }
  }

  return Object.keys(profiles).length > 0 ? profiles : undefined
}

function parseHeaderTemplates(raw: unknown, field: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new Error(`http_api config.${field} must be an object`)

  const headers: Record<string, string> = {}
  for (const [name, template] of Object.entries(raw)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`http_api config.${field} has invalid header name: ${name}`)
    }
    if (name.toLowerCase() === 'authorization') {
      throw new Error(`http_api config.${field} must not override Authorization`)
    }
    if (typeof template !== 'string') {
      throw new Error(`http_api config.${field}.${name} must be a string`)
    }
    headers[name] = template
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

/**
 * Service-módú connector API-kulcsának feloldása a `secretAlias`-ból.
 * Támogatott formák:
 *   - `env:NÉV`                         → process.env.NÉV
 *   - `secret-manager:projects/.../secrets/<id>` → Secret Manager latest version
 * A nyers kulcs csak itt, szerveroldalon, rövid élettartamra jelenik meg.
 */
export async function resolveConnectorApiKey(secretAlias: string | null): Promise<string> {
  if (process.env.HTTP_API_STUB === 'true') return 'stub-api-key'
  if (!secretAlias?.trim()) throw new Error('http_api connector has no secretAlias')

  const alias = secretAlias.trim()

  if (alias.startsWith('secret-ref:')) {
    const { loadConnectorApiKeyByRef } = await import('./connector-secret-store')
    return loadConnectorApiKeyByRef(alias)
  }

  const envMatch = alias.match(/^env:(.+)$/)
  if (envMatch) {
    const value = process.env[envMatch[1].trim()]
    if (!value) throw new Error(`http_api API key env var not set: ${envMatch[1].trim()}`)
    return value
  }

  const smMatch = alias.match(/^secret-manager:(.+)$/)
  if (smMatch) {
    const resource = smMatch[1].trim()
    const token = await getCloudRunAccessToken(process.env.SECRET_MANAGER_ACCESS_TOKEN)
    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/${resource}/versions/latest:access`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    if (!res.ok) {
      throw new Error(`Secret Manager access failed: ${res.status}`)
    }
    const data = (await res.json()) as { payload?: { data?: string } }
    if (!data.payload?.data) throw new Error('Secret Manager version payload empty')
    return Buffer.from(data.payload.data, 'base64').toString('utf8').trim()
  }

  throw new Error(
    'http_api secretAlias must be "env:NAME" or "secret-manager:projects/.../secrets/<id>"',
  )
}

export type HttpApiRequestParams = {
  method: string
  path: string
  /** Belső get_all jelzés: a pathot az eredeti next_link endpoint válasza adta. */
  continuationOf?: string
  query?: Record<string, string | number | boolean>
  headers?: Record<string, string>
  body?: unknown
  context?: HttpApiTemplateContext
}

export type HttpApiResponse = {
  status: number
  ok: boolean
  body: unknown
  /** Modellnek szóló útmutató (4xx / truncate) — titkot nem tartalmaz. */
  hint?: string
  /** true, ha a body truncate-elt előnézet (maxResponseChars). */
  truncated?: boolean
  /** RFC 8288 lapozáshoz; csak a Link fejléc, más response header nem kerül tovább. */
  linkHeader?: string
}

export class HttpApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** `endpoint_not_allowed`-nál a valódi engedélyezett katalógus (reaktív felfedezés). */
    readonly allowedEndpoints?: HttpApiEndpointSummary[],
    /** `endpoint_not_allowed`-nál: miért nem illeszkedett (modellnek, titok nélkül). */
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'HttpApiError'
  }
}

export type HttpApiTemplateContext = {
  agent: { id: string; version?: number }
  connector: { id: string; name: string }
  actingUser?: { id: string; email: string; tenantId: string | null } | null
  /** Connector config fallback — pl. Ostorosbor CRM sandbox/legacy hívások. */
  defaultActingUserEmail?: string
  tenant?: { id: string } | null
  call: { id: string; idempotencyKey: string }
  now: { iso: string }
}

export type HttpApiCredentials =
  | string
  | {
      defaultApiKey?: string
      resolveProfileApiKey?: (profile: string, secretAlias: string) => Promise<string>
    }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Vékony, állapotmentes REST-kliens egy http_api connectorhoz. A kulcsot a
 * konstruktor kapja (a Broker injektálja); a kliens csak felhasználja és
 * elfelejti — nem tárol, nem frissít, nem szerez kredenciált.
 */
export class HttpApiClient {
  private defaultApiKey?: string
  private resolveProfileApiKey?: (profile: string, secretAlias: string) => Promise<string>

  constructor(
    private config: HttpApiConfig,
    credentials: HttpApiCredentials,
  ) {
    if (typeof credentials === 'string') {
      this.defaultApiKey = credentials
    } else {
      this.defaultApiKey = credentials.defaultApiKey
      this.resolveProfileApiKey = credentials.resolveProfileApiKey
    }
  }

  private isStub(): boolean {
    return process.env.HTTP_API_STUB === 'true' || Boolean(this.defaultApiKey?.startsWith('stub-'))
  }

  private selectEndpoint(
    method: string,
    path: string,
    continuationOf?: string,
  ): HttpApiEndpoint | undefined {
    if (/:\/\//.test(path)) {
      // SSRF-védelem: a path nem írhatja felül a connector hostját.
      throw new HttpApiError('path must be relative to the connector baseUrl', 'invalid_path')
    }
    this.assertGitHubRepositoryAllowed(path)
    const endpoint = findHttpApiEndpoint(this.config, method, path)
    const continuationEndpoint = continuationOf
      ? findHttpApiEndpoint(this.config, method, continuationOf)
      : undefined
    if (this.config.restrictToEndpoints) {
      if (!endpoint) {
        if (
          method === 'GET'
          && continuationEndpoint?.pagination?.kind === 'next_link'
          && continuationEndpoint.pagination.continuationPathTemplate
          && httpApiPathMatches(continuationEndpoint.pagination.continuationPathTemplate, path)
        ) {
          return continuationEndpoint
        }
        const reason = explainHttpApiEndpointMiss(this.config, method, path)
        throw new HttpApiError(
          `endpoint not allowed: ${method} ${path} — ${reason}`,
          'endpoint_not_allowed',
          summarizeHttpApiEndpoints(this.config.endpoints),
          reason,
        )
      }
    }
    return endpoint
  }

  private assertGitHubRepositoryAllowed(path: string): void {
    const access = this.config.githubRepositoryAccess
    if (!access || access.mode === 'any') return

    let normalized: string
    try {
      normalized = this.buildUrl(path).pathname
    } catch {
      throw new HttpApiError('GitHub repository path is invalid', 'invalid_path')
    }
    const match = normalized.match(/^\/?repos\/([^/]+)\/([^/]+)(?:\/|$)/i)
    if (!match) {
      throw new HttpApiError(
        `GitHub path requires a selected owner/repo scope: ${path}`,
        'github_repository_scope_required',
      )
    }

    let repository: string
    try {
      repository = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`.toLowerCase()
    } catch {
      throw new HttpApiError('GitHub repository path is invalid', 'invalid_path')
    }
    if (!GITHUB_REPOSITORY_PATTERN.test(repository)) {
      throw new HttpApiError('GitHub repository path is invalid', 'invalid_path')
    }
    if (!access.repositories.includes(repository)) {
      throw new HttpApiError(
        `GitHub repository not allowed: ${repository}`,
        'github_repository_not_allowed',
      )
    }
  }

  private buildUrl(path: string, query?: HttpApiRequestParams['query']): URL {
    const rel = path.startsWith('/') ? path : `/${path}`
    const url = new URL(`${this.config.baseUrl}${rel}`)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, String(v))
      }
    }
    return url
  }

  private async authHeaders(endpoint?: HttpApiEndpoint): Promise<Record<string, string>> {
    const profileName = endpoint?.profile ?? this.config.defaultAuthProfile
    if (profileName) {
      const profile = this.config.authProfiles?.[profileName]
      if (!profile) throw new HttpApiError(`auth profile not found: ${profileName}`, 'auth_profile_not_found')
      const key = this.resolveProfileApiKey
        ? await this.resolveProfileApiKey(profileName, profile.secretAlias)
        : await resolveConnectorApiKey(profile.secretAlias)
      return buildAuthHeaders(profile.auth ?? this.config.auth, key)
    }

    if (this.config.auth.scheme === 'none') return {}

    if (!this.defaultApiKey) {
      throw new HttpApiError('http_api connector has no default API key', 'missing_api_key')
    }
    return buildAuthHeaders(this.config.auth, this.defaultApiKey)
  }

  private platformInjectedHeaderNames(
    method: string,
    endpoint: HttpApiEndpoint | undefined,
  ): Set<string> {
    const names = headerNameSet(
      this.config.requestHeaders,
      !READ_METHODS.has(method) ? this.config.writeHeaders : undefined,
      endpoint?.headers,
    )
    if (endpoint?.idempotent && !READ_METHODS.has(method)) {
      names.add(IDEMPOTENCY_HEADER_LOWER)
    }
    return names
  }

  private buildTemplateHeaders(
    method: string,
    endpoint: HttpApiEndpoint | undefined,
    context: HttpApiTemplateContext | undefined,
  ): Record<string, string> {
    const headers: Record<string, string> = {}
    const optional = endpoint?.optionalPlatformHeaders
    applyHeaderTemplates(headers, this.config.requestHeaders, context, optional)
    if (!READ_METHODS.has(method)) applyHeaderTemplates(headers, this.config.writeHeaders, context, optional)
    applyHeaderTemplates(headers, endpoint?.headers, context, optional)

    if (endpoint?.idempotent && !READ_METHODS.has(method) && !hasHeader(headers, IDEMPOTENCY_HEADER_LOWER)) {
      if (!context) throw new HttpApiError('idempotent endpoint requires call context', 'missing_context')
      headers['Idempotency-Key'] = context.call.idempotencyKey
    }
    return headers
  }

  private buildParameterHeaders(
    endpoint: HttpApiEndpoint | undefined,
    provided: Record<string, string> | undefined,
    platformInjected: Set<string>,
  ): Record<string, string> {
    const declared = new Map((endpoint?.headerParams ?? []).map((param) => [param.name.toLowerCase(), param]))
    const values = new Map<string, string>()
    const authHeader = this.config.auth.scheme === 'header' ? this.config.auth.header.toLowerCase() : 'authorization'
    for (const [name, value] of Object.entries(provided ?? {})) {
      const normalized = name.toLowerCase()
      if (platformInjected.has(normalized)) {
        throw new HttpApiError(
          `platform-injected header cannot be supplied by the caller: ${name} — omit it from headers; the platform injects it`,
          'platform_injected_header',
        )
      }
      const param = declared.get(normalized)
      if (!param) throw new HttpApiError(`header not allowed by active snapshot: ${name}`, 'header_not_allowed')
      if (normalized === authHeader || ['authorization', 'host', 'content-length', 'content-type'].includes(normalized)) {
        throw new HttpApiError(`protected header cannot be supplied by the caller: ${name}`, 'header_not_allowed')
      }
      values.set(normalized, value)
    }
    for (const param of declared.values()) {
      const normalized = param.name.toLowerCase()
      // A hitelesítési fejlécet mindig a platform injektálja a Secret Store-ból.
      if (normalized === authHeader || normalized === 'authorization') continue
      // Sablonból fedett fejlécek: a runtime küldi, a hívónak nem kell megadnia.
      if (platformInjected.has(normalized)) continue
      if (param.required && !values.has(normalized)) {
        throw new HttpApiError(`required header missing: ${param.name}`, 'required_header_missing')
      }
    }
    return Object.fromEntries([...values].map(([name, value]) => [declared.get(name)!.name, value]))
  }

  async request(params: HttpApiRequestParams): Promise<HttpApiResponse> {
    const method = params.method.toUpperCase()
    if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) {
      throw new HttpApiError(`unsupported HTTP method: ${method}`, 'invalid_method')
    }
    const endpoint = this.selectEndpoint(method, params.path, params.continuationOf)
    const platformInjected = this.platformInjectedHeaderNames(method, endpoint)
    const parameterHeaders = this.buildParameterHeaders(endpoint, params.headers, platformInjected)

    if (this.isStub()) {
      return {
        status: 200,
        ok: true,
        body: { stub: true, method, path: params.path, query: params.query ?? null },
      }
    }

    const url = this.buildUrl(params.path, params.query)
    const hasBody = params.body !== undefined && !READ_METHODS.has(method)
    // Sorrend: caller paraméterek → platform sablon → auth. A sablon/auth soha
    // nem írható felül a modell által beadott headers-szel.
    const init: RequestInit = {
      method,
      headers: {
        accept: 'application/json',
        ...parameterHeaders,
        ...this.buildTemplateHeaders(method, endpoint, params.context),
        ...(await this.authHeaders(endpoint)),
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(params.body) } : {}),
    }

    const res = await this.fetchWithBackoff(url, init)
    const text = await res.text()
    const max = this.config.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS
    const overLimit = text.length > max
    const previewText = overLimit ? `${text.slice(0, max)}…[truncated]` : text

    let body: unknown = previewText
    let truncated = false
    let oversizedSoftHint: string | undefined
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      // Sikeres / parse-olható JSON: a teljes body megmarad (get_all + archive + extract).
      // A maxResponseChars soft jelzés: ne dumpold a modell kontextusába.
      try {
        const parsed: unknown = JSON.parse(text)
        body = decodeGitHubContentsBody(parsed)
        // A méret-kaput a TÉNYLEGESEN visszaadott alakra mérjük. A GitHub base64
        // fájltartalma ~33%-kal nagyobb a dekódolt szövegnél, a könyvtárlistából
        // pedig URL-mezőket hagytunk el — a nyers hosszal mérve egy hiánytalanul
        // átadott forrásfájl is „túl nagynak”, a szerződés felé `partial`-nak
        // látszana, és a modell csonkoltnak hinné, amit egészben megkapott.
        const effectiveChars = body === parsed ? text.length : safeJsonLength(body, text.length)
        if (effectiveChars > max) {
          truncated = true
          oversizedSoftHint = buildHttpApiOversizedResponseHint({
            originalChars: effectiveChars,
            maxChars: max,
          })
        }
      } catch {
        if (overLimit) {
          truncated = true
          body = buildHttpApiTruncationBody({
            originalChars: text.length,
            maxChars: max,
            preview: text.slice(0, max),
          })
        } else {
          body = previewText
        }
      }
    } else if (overLimit) {
      truncated = true
    }

    const errorHint =
      !res.ok
        ? buildHttpApiClientErrorHint({
            status: res.status,
            endpoint: endpoint ?? null,
            usedQueryKeys: params.query ? Object.keys(params.query) : [],
          })
        : undefined
    const truncationHint =
      truncated && typeof body === 'object' && body && 'hint' in (body as object)
        ? String((body as { hint: string }).hint)
        : oversizedSoftHint
          ? oversizedSoftHint
          : truncated
            ? buildHttpApiTruncationBody({
                originalChars: text.length,
                maxChars: max,
                preview: text.slice(0, Math.min(max, text.length)),
              }).hint
            : undefined

    return {
      status: res.status,
      ok: res.ok,
      body,
      ...(res.headers.get('link') ? { linkHeader: res.headers.get('link')! } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(errorHint || truncationHint
        ? { hint: [errorHint, truncationHint].filter(Boolean).join(' ') }
        : {}),
    }
  }

  private async fetchWithBackoff(input: URL, init: RequestInit): Promise<Response> {
    const connectorUrl = new URL(this.config.baseUrl)
    const connectorHost = connectorUrl.hostname.toLowerCase()
    // A redirect-pinning ORIGIN-szinten köt (séma + host + port), nem csak hostname-en: egy
    // azonos-hostnevű, de más PORTRA mutató (pl. `:2375` belső admin/docker) vagy `https→http`
    // downgrade átirányítás különben átcsúszna a puszta hostname-egyezésen.
    const connectorOrigin = connectorUrl.origin
    if (this.config.selfUpdatingPinned) {
      const guard = await guardEgressUrl({
        url: input.toString(),
        allowlistHosts: [connectorHost],
        resolveHostIps: async (host) => (await lookup(host, { all: true })).map((entry) => entry.address),
      })
      if (!guard.ok || guard.host !== connectorHost) {
        throw new HttpApiError(`runtime egress blocked: ${guard.ok ? 'host_mismatch' : guard.reason}`, 'egress_blocked')
      }
    }
    // Host-pinning a redirecteken is: a `fetch` alapból KÖVETI a 3xx-eket, ezért egy
    // allowlistolt host egyetlen átirányítással kivihetné a hívást egy belső szolgáltatásra
    // vagy a felhő-metadata hostra (169.254.169.254) — ez SSRF, és a path/query az agent
    // kezében van (nyílt-redirect végponton is kiváltható). Ezért MINDEN connectornál
    // `redirect: 'manual'`, és a redirecteket kézzel, a connector SAJÁT hostjára pinnelve
    // követjük; idegen hostra mutató átirányítás → blokk.
    const guardedInit: RequestInit = { ...init, redirect: 'manual' }
    const delays = [250, 750]
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      const res = await this.fetchFollowingSameOriginRedirects(input, guardedInit, connectorOrigin)
      // 429 / 5xx → korlátozott backoff; minden mást (a 4xx-eket is) felfelé adunk
      // strukturált válaszként, hogy a modell reagálhasson rá.
      if (![429, 500, 502, 503, 504].includes(res.status) || attempt === delays.length) {
        return res
      }
      await sleep(delays[attempt])
    }
    throw new HttpApiError('request failed before response', 'network_error')
  }

  /**
   * A redirecteket kézzel, a connector KONFIGURÁLT ORIGIN-jére (séma + host + port) pinnelve
   * követi (deny-by-default a más originre mutató átirányításokra). Pin-elt (önfrissítő)
   * connectornál MINDEN 3xx tilos — ez a korábbi, szigorúbb viselkedés. Nem-pin-elt connectornál
   * az azonos-origin redirect legfeljebb `MAX_SAME_HOST_REDIRECTS`-szer követhető; a Location
   * nélküli 3xx-et és minden nem-3xx választ változatlanul visszaadja. Így a host-pinning
   * invariáns a redirect-láncon is áll, és az SSRF-út (allowlistolt host → 3xx → belső/metadata,
   * vagy azonos hostnév más porton / `https→http` downgrade) zárva marad.
   */
  private async fetchFollowingSameOriginRedirects(
    input: URL,
    init: RequestInit,
    connectorOrigin: string,
  ): Promise<Response> {
    let currentUrl = input
    for (let hop = 0; ; hop += 1) {
      const res = await fetch(currentUrl, init)
      if (res.status < 300 || res.status >= 400) return res

      if (this.config.selfUpdatingPinned) {
        throw new HttpApiError('runtime redirect blocked for pinned connector', 'egress_blocked')
      }
      const location = res.headers.get('location')
      // Location nélküli 3xx: nincs mit követni — adjuk vissza strukturáltan a modellnek.
      if (!location) return res
      if (hop >= MAX_SAME_HOST_REDIRECTS) {
        throw new HttpApiError('runtime redirect blocked: too many redirects', 'egress_blocked')
      }
      let target: URL
      try {
        target = new URL(location, currentUrl)
      } catch {
        throw new HttpApiError('runtime redirect blocked: invalid redirect target', 'egress_blocked')
      }
      // A redirect csak a connector SAJÁT originjén maradhat (séma+host+port); bármi más (belső
      // szolgáltatás, felhő-metadata, azonos hostnév más porton, https→http downgrade, idegen
      // exfil-host) SSRF → blokk. A connector-kliens szándékosan nem ismeri a tágabb
      // egress-allowlistet, ezért a self-contained szabály a same-origin-only.
      if (target.origin !== connectorOrigin) {
        throw new HttpApiError('runtime redirect blocked: cross-origin redirect', 'egress_blocked')
      }
      currentUrl = target
    }
  }
}

type OAuth2Credentials = { clientSecret: string; refreshToken: string }

/**
 * Az oauth2 séma esetén a connector secretAlias-a mögött NEM egy nyers kulcs,
 * hanem egy JSON blob áll: `{"clientSecret":"...","refreshToken":"..."}`
 * (a client_id nem titok, az a configban van). Rossz alakzat → tiszta hiba,
 * SOSEM próbáljuk a nyers stringet access tokenként felhasználni.
 */
function parseOAuth2Credentials(raw: string): OAuth2Credentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.clientSecret !== 'string' ||
    !parsed.clientSecret.trim() ||
    typeof parsed.refreshToken !== 'string' ||
    !parsed.refreshToken.trim()
  ) {
    throw new HttpApiError(
      'oauth2 secret must be a JSON string {"clientSecret","refreshToken"}',
      'oauth2_credentials_invalid',
    )
  }
  return { clientSecret: parsed.clientSecret.trim(), refreshToken: parsed.refreshToken.trim() }
}

type CachedOAuth2Token = { accessToken: string; expiresAt: number }
/** Folyamaton belüli access-token cache — SOSEM perzisztált, SOSEM naplózott. */
const oauth2TokenCache = new Map<string, CachedOAuth2Token>()
const OAUTH2_EXPIRY_SKEW_MS = 60_000

function oauth2CacheKey(auth: Extract<HttpApiAuthConfig, { scheme: 'oauth2' }>, refreshToken: string): string {
  return createHash('sha256').update(`${auth.tokenUrl}::${auth.clientId}::${refreshToken}`).digest('hex')
}

/**
 * OAuth2 refresh_token grant (RFC 6749 §6) — access token beszerzése/frissítése
 * a tárolt refresh_token-ből. Lejárat előtt a cache-elt tokent adja vissza;
 * a client_secret/refresh_token SOSEM kerül hibaüzenetbe vagy naplóba.
 */
async function resolveOAuth2AccessToken(
  auth: Extract<HttpApiAuthConfig, { scheme: 'oauth2' }>,
  credentialsJson: string,
): Promise<string> {
  const { clientSecret, refreshToken } = parseOAuth2Credentials(credentialsJson)
  const cacheKey = oauth2CacheKey(auth, refreshToken)
  const cached = oauth2TokenCache.get(cacheKey)
  if (cached && cached.expiresAt - OAUTH2_EXPIRY_SKEW_MS > Date.now()) {
    return cached.accessToken
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: auth.clientId,
    client_secret: clientSecret,
    ...(auth.scope ? { scope: auth.scope } : {}),
  })
  const res = await fetch(auth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    // Az OAuth-szerver error/error_description mezői NEM titkosak (RFC 6749 §5.2) —
    // ezek a diagnózishoz kellenek; a client_secret/refresh_token SOSEM kerül ide.
    let reason = `status ${res.status}`
    try {
      const errBody = (await res.json()) as { error?: string; error_description?: string }
      if (errBody.error) reason = `${errBody.error}${errBody.error_description ? `: ${errBody.error_description}` : ''}`
    } catch {
      // nem JSON válasz — marad a status kód
    }
    throw new HttpApiError(`oauth2 token refresh failed (${reason})`, 'oauth2_refresh_failed')
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) {
    throw new HttpApiError('oauth2 token endpoint returned no access_token', 'oauth2_refresh_failed')
  }
  const expiresInMs =
    (typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600) * 1000
  oauth2TokenCache.set(cacheKey, { accessToken: data.access_token, expiresAt: Date.now() + expiresInMs })
  return data.access_token
}

async function buildAuthHeaders(auth: HttpApiAuthConfig, apiKey: string): Promise<Record<string, string>> {
  if (auth.scheme === 'none') return {}
  if (auth.scheme === 'bearer') return { authorization: `Bearer ${apiKey}` }
  if (auth.scheme === 'basic') return { authorization: `Basic ${apiKey}` }
  if (auth.scheme === 'oauth2') {
    const accessToken = await resolveOAuth2AccessToken(auth, apiKey)
    return { authorization: `Bearer ${accessToken}` }
  }
  return { [auth.header]: apiKey }
}

function hasHeader(headers: Record<string, string>, lowerName: string): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === lowerName)
}

function applyHeaderTemplates(
  target: Record<string, string>,
  templates: Record<string, string> | undefined,
  context: HttpApiTemplateContext | undefined,
  optionalHeaders?: ReadonlySet<string>,
): void {
  if (!templates) return
  if (!context) throw new HttpApiError('header templates require call context', 'missing_context')
  for (const [name, template] of Object.entries(templates)) {
    try {
      target[name] = renderTemplate(template, context)
    } catch (error) {
      // Az endpoint saját OpenAPI-ja szerint opcionális fejléc (pl. X-Acting-User
      // actingUser nélküli MCP-hívásnál) — kihagyjuk, nem buktatjuk a hívást.
      if (
        error instanceof HttpApiError &&
        error.code === 'template_variable_missing' &&
        optionalHeaders?.has(name.toLowerCase())
      ) {
        continue
      }
      throw error
    }
  }
}

function renderTemplate(template: string, context: HttpApiTemplateContext): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, key: string) => {
    const value = templateValue(key, context)
    if (value === undefined || value === null) {
      throw new HttpApiError(`template variable not available: ${key}`, 'template_variable_missing')
    }
    return String(value)
  })
}

function templateValue(key: string, context: HttpApiTemplateContext): string | number | null | undefined {
  const values: Record<string, string | number | null | undefined> = {
    'agent.id': context.agent.id,
    'agent.version': context.agent.version,
    'connector.id': context.connector.id,
    'connector.name': context.connector.name,
    'actingUser.id': context.actingUser?.id,
    'actingUser.email': context.actingUser?.email ?? context.defaultActingUserEmail,
    'actingUser.tenantId': context.actingUser?.tenantId,
    'tenant.id': context.tenant?.id,
    'call.id': context.call.id,
    'call.idempotencyKey': context.call.idempotencyKey,
    'now.iso': context.now.iso,
  }
  return values[key]
}

/**
 * Path-egyezés placeholderekkel. Kétféle jelölést fogadunk el, mert a kézi
 * „API-kapcsolat" a `:param` alakot használja (pl. /banks/:bankId/crm), a
 * sablonból materializált configok viszont a `{param}` alakot (pl. /accounts/{id}).
 * A `{param}` szegmensen BELÜL is állhat fix előtaggal/utótaggal (pl. `act_{id}`,
 * `{id}.json`, `Customers('{id}')`); a `:param` csak teljes szegmens lehet, mert a
 * kettőspont sok API-ban literál (pl. `/v1/items:batchGet`).
 */
export function httpApiPathMatches(template: string, actual: string): boolean {
  const t = template.split('/').filter(Boolean)
  const a = actual.split('/').filter(Boolean)
  if (t.length !== a.length) return false
  return t.every((seg, i) => segmentMatches(seg, a[i]))
}

/** Közös endpoint-feloldás a kliens és a get_all lapozási terv számára. */
export function findHttpApiEndpoint(
  config: Pick<HttpApiConfig, 'endpoints'>,
  method: string,
  path: string,
): HttpApiEndpoint | undefined {
  const normalized = path.split('?')[0]
  const upperMethod = method.toUpperCase()
  // Több illeszkedő sablonnál a legspecifikusabb nyer (a `/act_{id}` a `/{id}` előtt),
  // különben a tágabb sablon kockázati/lapozási beállítása érvényesülne.
  let best: HttpApiEndpoint | undefined
  let bestScore = -1
  for (const endpoint of config.endpoints ?? []) {
    if (endpoint.method !== upperMethod || !httpApiPathMatches(endpoint.path, normalized)) continue
    const score = templateLiteralLength(endpoint.path)
    if (score > bestScore) {
      best = endpoint
      bestScore = score
    }
  }
  return best
}

/**
 * Miért nem illeszkedett a hívás? Modellnek szóló, titokmentes magyarázat az
 * `endpoint_not_allowed` hibához, hogy ne vakon próbálkozzon újabb alakokkal.
 */
export function explainHttpApiEndpointMiss(
  config: Pick<HttpApiConfig, 'endpoints'>,
  method: string,
  path: string,
): string {
  const normalized = path.split('?')[0]
  const otherMethods = [
    ...new Set(
      (config.endpoints ?? [])
        .filter((endpoint) => httpApiPathMatches(endpoint.path, normalized))
        .map((endpoint) => endpoint.method),
    ),
  ]
  if (otherMethods.length > 0) {
    return `path matches an allowed endpoint, but method ${method.toUpperCase()} is not allowed there (allowed: ${otherMethods.join(', ')})`
  }
  return 'no allowed endpoint template matches this path — substitute {param} placeholders only, keep every literal segment and prefix (e.g. act_{id} → act_123)'
}

/**
 * Azonos metódusú sablonpárok, amelyekre ugyanaz a konkrét path illeszkedhet
 * (pl. `GET /{campaignId}` és `GET /act_{adAccountId}`). A futásidő ilyenkor a
 * specifikusabbat választja, de a tágabb sablon csendben mást is enged — ezért
 * konfiguráláskor figyelmeztetünk rá.
 */
export function findOverlappingHttpApiEndpoints(
  endpoints: ReadonlyArray<Pick<HttpApiEndpoint, 'method' | 'path'>>,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      const a = endpoints[i]
      const b = endpoints[j]
      if (a.method.toUpperCase() !== b.method.toUpperCase() || a.path === b.path) continue
      if (templatesOverlap(a.path, b.path)) {
        pairs.push([`${a.method.toUpperCase()} ${a.path}`, `${b.method.toUpperCase()} ${b.path}`])
      }
    }
  }
  return pairs
}

function templatesOverlap(left: string, right: string): boolean {
  const l = left.split('/').filter(Boolean)
  const r = right.split('/').filter(Boolean)
  if (l.length !== r.length) return false
  return l.every((seg, i) => {
    const other = r[i]
    if (!hasPathParam(seg)) return segmentMatches(other, seg)
    if (!hasPathParam(other)) return segmentMatches(seg, other)
    // ponytail: két vegyes szegmens (pl. act_{a} vs cmp_{b}) átfedését nem bizonyítjuk,
    // átfedőnek vesszük — legfeljebb egy fölösleges figyelmeztetés.
    return true
  })
}

const BRACE_PARAM = /\{[^{}/]+\}/g

function isPathParamSegment(segment: string): boolean {
  return segment.startsWith(':') || (segment.startsWith('{') && segment.endsWith('}'))
}

function hasPathParam(segment: string): boolean {
  return segment.startsWith(':') || /\{[^{}/]+\}/.test(segment)
}

function segmentMatches(templateSegment: string, actual: string): boolean {
  if (isPathParamSegment(templateSegment)) return actual.length > 0
  if (!templateSegment.includes('{')) return templateSegment === actual
  const pattern = templateSegment
    .split(BRACE_PARAM)
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+')
  return new RegExp(`^${pattern}$`).test(actual)
}

function templateLiteralLength(template: string): number {
  return template
    .split('/')
    .filter(Boolean)
    .reduce((sum, seg) => sum + (seg.startsWith(':') ? 0 : seg.replace(BRACE_PARAM, '').length), 0)
}
