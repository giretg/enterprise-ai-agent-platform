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
}

export type HttpApiConfig = {
  baseUrl: string
  auth: HttpApiAuthConfig
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
  } else {
    throw new Error('http_api config.auth.scheme must be "header" or "bearer"')
  }

  const endpoints = Array.isArray(raw.endpoints)
    ? raw.endpoints
        .filter(isRecord)
        .map((e) => ({
          method: String(e.method ?? '').toUpperCase(),
          path: String(e.path ?? ''),
          description: typeof e.description === 'string' ? e.description : undefined,
        }))
        .filter((e) => e.method && e.path)
    : undefined

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    auth,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    endpoints,
    restrictToEndpoints: raw.restrictToEndpoints === true,
    maxResponseChars:
      typeof raw.maxResponseChars === 'number' && raw.maxResponseChars > 0
        ? raw.maxResponseChars
        : DEFAULT_MAX_RESPONSE_CHARS,
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Vékony, állapotmentes REST-kliens egy http_api connectorhoz. A kulcsot a
 * konstruktor kapja (a Broker injektálja); a kliens csak felhasználja és
 * elfelejti — nem tárol, nem frissít, nem szerez kredenciált.
 */
export class HttpApiClient {
  constructor(
    private config: HttpApiConfig,
    private apiKey: string,
  ) {}

  private isStub(): boolean {
    return process.env.HTTP_API_STUB === 'true' || this.apiKey.startsWith('stub-')
  }

  private assertAllowed(method: string, path: string): void {
    if (/:\/\//.test(path)) {
      // SSRF-védelem: a path nem írhatja felül a connector hostját.
      throw new HttpApiError('path must be relative to the connector baseUrl', 'invalid_path')
    }
    if (this.config.restrictToEndpoints) {
      const normalized = path.split('?')[0]
      const allowed = (this.config.endpoints ?? []).some(
        (e) => e.method === method && pathMatches(e.path, normalized),
      )
      if (!allowed) {
        throw new HttpApiError(`endpoint not allowed: ${method} ${path}`, 'endpoint_not_allowed')
      }
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

  private authHeaders(): Record<string, string> {
    if (this.config.auth.scheme === 'bearer') {
      return { authorization: `Bearer ${this.apiKey}` }
    }
    return { [this.config.auth.header]: this.apiKey }
  }

  async request(params: HttpApiRequestParams): Promise<HttpApiResponse> {
    const method = params.method.toUpperCase()
    if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) {
      throw new HttpApiError(`unsupported HTTP method: ${method}`, 'invalid_method')
    }
    this.assertAllowed(method, params.path)

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
        ...this.authHeaders(),
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

/** Egyszerű path-egyezés `:param` placeholderekkel (pl. /banks/:bankId/crm). */
function pathMatches(template: string, actual: string): boolean {
  const t = template.split('/').filter(Boolean)
  const a = actual.split('/').filter(Boolean)
  if (t.length !== a.length) return false
  return t.every((seg, i) => seg.startsWith(':') || seg === a[i])
}
