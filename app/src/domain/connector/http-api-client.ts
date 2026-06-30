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
import { getCloudRunAccessToken } from '@/domain/dispatcher/cloud-run-auth'

export type HttpApiAuthConfig =
  | { scheme: 'header'; header: string }
  | { scheme: 'bearer' }

export type HttpApiEndpoint = {
  method: string
  path: string
  description?: string
  profile?: string
  idempotent?: boolean
  headers?: Record<string, string>
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
  /** Csak író hívásokra injektált, sablonozható fejlécek. */
  writeHeaders?: Record<string, string>
  /** Emberi nyelvű API-leírás — a modell elé kerül a tool loopban. */
  description?: string
  /** Ismert endpointok (dokumentáció + opcionális allowlist). */
  endpoints?: HttpApiEndpoint[]
  /** Ha true: csak az `endpoints` listában szereplő (method+path) hívható. */
  restrictToEndpoints?: boolean
  /** Maximális válasz-méret karakterben (alap: 20000). */
  maxResponseChars?: number
}

const READ_METHODS = new Set(['GET', 'HEAD'])
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const DEFAULT_MAX_RESPONSE_CHARS = 20_000

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A connector `config` JSON validálása. Hibás konfigot dob — a Broker ezt
 * `tool_call_failed`-ként jelenti, nem szivárogtat kulcsot.
 */
export function parseHttpApiConfig(raw: unknown): HttpApiConfig {
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
  } else if (authRaw.type === 'bearer_token') {
    auth = { scheme: 'bearer' }
  } else if (authRaw.type === 'api_key_header') {
    const header = typeof authRaw.headerName === 'string' ? authRaw.headerName.trim() : ''
    if (!header) {
      throw new Error('http_api config.auth.headerName is required for type "api_key_header"')
    }
    auth = { scheme: 'header', header }
  } else {
    throw new Error('http_api config.auth.scheme must be "header" or "bearer"')
  }

  const endpointSource = Array.isArray(raw.endpoints)
    ? raw.endpoints
    : Array.isArray(raw.proposedTools)
      ? raw.proposedTools
      : undefined
  const endpoints = Array.isArray(endpointSource)
    ? endpointSource
        .filter(isRecord)
        .map((e) => ({
          method: String(e.method ?? '').toUpperCase(),
          path: String(e.path ?? ''),
          description: typeof e.description === 'string' ? e.description : undefined,
          profile: typeof e.profile === 'string' && e.profile.trim() ? e.profile.trim() : undefined,
          idempotent: e.idempotent === true,
          headers: parseHeaderTemplates(e.headers, 'endpoint.headers'),
        }))
        .filter((e) => e.method && e.path)
    : undefined

  const authProfiles = parseAuthProfiles(raw.authProfiles)

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    auth,
    ...(authProfiles ? { authProfiles } : {}),
    defaultAuthProfile:
      typeof raw.defaultAuthProfile === 'string' && raw.defaultAuthProfile.trim()
        ? raw.defaultAuthProfile.trim()
        : undefined,
    requestHeaders: parseHeaderTemplates(raw.requestHeaders, 'requestHeaders'),
    writeHeaders: parseHeaderTemplates(raw.writeHeaders, 'writeHeaders'),
    description: typeof raw.description === 'string' ? raw.description : undefined,
    endpoints,
    restrictToEndpoints: raw.restrictToEndpoints === true,
    maxResponseChars:
      typeof raw.maxResponseChars === 'number' && raw.maxResponseChars > 0
        ? raw.maxResponseChars
        : DEFAULT_MAX_RESPONSE_CHARS,
  }
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
  query?: Record<string, string | number | boolean>
  body?: unknown
  context?: HttpApiTemplateContext
}

export type HttpApiResponse = {
  status: number
  ok: boolean
  body: unknown
}

export class HttpApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'HttpApiError'
  }
}

export type HttpApiTemplateContext = {
  agent: { id: string; version?: number }
  connector: { id: string; name: string }
  actingUser?: { id: string; email: string; tenantId: string | null } | null
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

  private selectEndpoint(method: string, path: string): HttpApiEndpoint | undefined {
    if (/:\/\//.test(path)) {
      // SSRF-védelem: a path nem írhatja felül a connector hostját.
      throw new HttpApiError('path must be relative to the connector baseUrl', 'invalid_path')
    }
    const normalized = path.split('?')[0]
    const endpoint = (this.config.endpoints ?? []).find(
      (e) => e.method === method && pathMatches(e.path, normalized),
    )
    if (this.config.restrictToEndpoints) {
      if (!endpoint) {
        throw new HttpApiError(`endpoint not allowed: ${method} ${path}`, 'endpoint_not_allowed')
      }
    }
    return endpoint
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

    if (!this.defaultApiKey) {
      throw new HttpApiError('http_api connector has no default API key', 'missing_api_key')
    }
    return buildAuthHeaders(this.config.auth, this.defaultApiKey)
  }

  private buildTemplateHeaders(
    method: string,
    endpoint: HttpApiEndpoint | undefined,
    context: HttpApiTemplateContext | undefined,
  ): Record<string, string> {
    const headers: Record<string, string> = {}
    applyHeaderTemplates(headers, this.config.requestHeaders, context)
    if (!READ_METHODS.has(method)) applyHeaderTemplates(headers, this.config.writeHeaders, context)
    applyHeaderTemplates(headers, endpoint?.headers, context)

    if (endpoint?.idempotent && !READ_METHODS.has(method) && !hasHeader(headers, 'idempotency-key')) {
      if (!context) throw new HttpApiError('idempotent endpoint requires call context', 'missing_context')
      headers['Idempotency-Key'] = context.call.idempotencyKey
    }
    return headers
  }

  async request(params: HttpApiRequestParams): Promise<HttpApiResponse> {
    const method = params.method.toUpperCase()
    if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) {
      throw new HttpApiError(`unsupported HTTP method: ${method}`, 'invalid_method')
    }
    const endpoint = this.selectEndpoint(method, params.path)

    if (this.isStub()) {
      return {
        status: 200,
        ok: true,
        body: { stub: true, method, path: params.path, query: params.query ?? null },
      }
    }

    const url = this.buildUrl(params.path, params.query)
    const hasBody = params.body !== undefined && !READ_METHODS.has(method)
    const init: RequestInit = {
      method,
      headers: {
        accept: 'application/json',
        ...this.buildTemplateHeaders(method, endpoint, params.context),
        ...(await this.authHeaders(endpoint)),
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(params.body) } : {}),
    }

    const res = await this.fetchWithBackoff(url, init)
    const text = await res.text()
    const max = this.config.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS
    const truncated = text.length > max ? `${text.slice(0, max)}…[truncated]` : text

    let body: unknown = truncated
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      try {
        body = JSON.parse(text)
      } catch {
        body = truncated
      }
    }

    return { status: res.status, ok: res.ok, body }
  }

  private async fetchWithBackoff(input: URL, init: RequestInit): Promise<Response> {
    const delays = [250, 750]
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      const res = await fetch(input, init)
      // 429 / 5xx → korlátozott backoff; minden mást (a 4xx-eket is) felfelé adunk
      // strukturált válaszként, hogy a modell reagálhasson rá.
      if (![429, 500, 502, 503, 504].includes(res.status) || attempt === delays.length) {
        return res
      }
      await sleep(delays[attempt])
    }
    throw new HttpApiError('request failed before response', 'network_error')
  }
}

function buildAuthHeaders(auth: HttpApiAuthConfig, apiKey: string): Record<string, string> {
  if (auth.scheme === 'bearer') return { authorization: `Bearer ${apiKey}` }
  return { [auth.header]: apiKey }
}

function hasHeader(headers: Record<string, string>, lowerName: string): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === lowerName)
}

function applyHeaderTemplates(
  target: Record<string, string>,
  templates: Record<string, string> | undefined,
  context: HttpApiTemplateContext | undefined,
): void {
  if (!templates) return
  if (!context) throw new HttpApiError('header templates require call context', 'missing_context')
  for (const [name, template] of Object.entries(templates)) {
    target[name] = renderTemplate(template, context)
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
    'actingUser.email': context.actingUser?.email,
    'actingUser.tenantId': context.actingUser?.tenantId,
    'tenant.id': context.tenant?.id,
    'call.id': context.call.id,
    'call.idempotencyKey': context.call.idempotencyKey,
    'now.iso': context.now.iso,
  }
  return values[key]
}

/** Egyszerű path-egyezés `:param` placeholderekkel (pl. /banks/:bankId/crm). */
function pathMatches(template: string, actual: string): boolean {
  const t = template.split('/').filter(Boolean)
  const a = actual.split('/').filter(Boolean)
  if (t.length !== a.length) return false
  return t.every((seg, i) => seg.startsWith(':') || seg === a[i])
}
