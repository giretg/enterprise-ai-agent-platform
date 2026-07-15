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
import { getCloudRunAccessToken } from '@/domain/dispatcher/cloud-run-auth'
import {
  GITHUB_REPOSITORY_PATTERN,
  parseGitHubRepositoryAccessConfig,
  type GitHubRepositoryAccess,
} from './github-repository-access'

export type HttpApiAuthConfig =
  | { scheme: 'header'; header: string }
  | { scheme: 'bearer' }
  | { scheme: 'basic' }
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
  /** GitHub connector repository-határa. Hiánya visszafelé kompatibilisen `any`. */
  githubRepositoryAccess?: GitHubRepositoryAccess
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
  } else if (authRaw.scheme === 'basic' || authRaw.type === 'basic') {
    auth = { scheme: 'basic' }
  } else if (authRaw.scheme === 'oauth2' || authRaw.type === 'oauth2') {
    const tokenUrl = typeof authRaw.tokenUrl === 'string' ? authRaw.tokenUrl.trim() : ''
    if (!/^https?:\/\//i.test(tokenUrl)) {
      throw new Error('http_api config.auth.tokenUrl must be an absolute http(s) URL for scheme "oauth2"')
    }
    const clientId = typeof authRaw.clientId === 'string' ? authRaw.clientId.trim() : ''
    if (!clientId) {
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
  } else {
    throw new Error('http_api config.auth.scheme must be "header", "bearer", "basic" or "oauth2"')
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
  const githubRepositoryAccess = parseGitHubRepositoryAccessConfig(raw.githubRepositoryAccess)

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
    ...(githubRepositoryAccess ? { githubRepositoryAccess } : {}),
    maxResponseChars:
      typeof raw.maxResponseChars === 'number' && raw.maxResponseChars > 0
        ? raw.maxResponseChars
        : DEFAULT_MAX_RESPONSE_CHARS,
  }
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
    this.assertGitHubRepositoryAllowed(path)
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

/**
 * Egyszerű path-egyezés placeholderekkel. Kétféle jelölést fogadunk el, mert a
 * kézi „API-kapcsolat" a `:param` alakot használja (pl. /banks/:bankId/crm), a
 * sablonból materializált configok viszont a `{param}` alakot (pl. /accounts/{id}).
 * Mindkét forma egyetlen path-szegmensre illeszkedő joker.
 */
function pathMatches(template: string, actual: string): boolean {
  const t = template.split('/').filter(Boolean)
  const a = actual.split('/').filter(Boolean)
  if (t.length !== a.length) return false
  return t.every((seg, i) => isPathParamSegment(seg) || seg === a[i])
}

function isPathParamSegment(segment: string): boolean {
  return segment.startsWith(':') || (segment.startsWith('{') && segment.endsWith('}'))
}
