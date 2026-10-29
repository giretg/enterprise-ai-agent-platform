/**
 * Kimenő MCP-kliens a külső MCP-szerverekhez (#395 WP-1).
 *
 * Az SDK `Client` + `StreamableHTTPClientTransport` párosát használjuk; a saját
 * JSON-RPC réteg helyett csak a transzport `fetch`-jét cseréljük egy őrzöttre:
 *  - minden kérés `guardEgressUrl`-en megy át (https, SSRF, feloldás utáni
 *    privát-IP, a connector hostjára pinelve — D8/D10);
 *  - átirányítás nem követhető (`redirect: 'manual'` → hiba);
 *  - a válasz bájtban korlátozott, a hívás időben korlátozott;
 *  - sampling / elicitation / roots nincs hirdetve, a szerver ilyen kérését
 *    elutasítjuk és jelezzük a hívónak (D9, audit a hívó oldalán).
 *
 * A kapcsolat hívásonként épül (`initialize` → művelet → zárás), pool nincs.
 */
import { lookup } from 'node:dns/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { discoverOAuthServerInfo, registerClient } from '@modelcontextprotocol/sdk/client/auth.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { guardEgressUrl } from '@/domain/net/egress-guard'

export type McpClientErrorCode =
  | 'egress_blocked'
  | 'redirect_blocked'
  | 'unauthorized'
  | 'timeout'
  | 'too_large'
  | 'server_error'

export class McpClientError extends Error {
  constructor(
    readonly code: McpClientErrorCode,
    readonly detail?: string,
  ) {
    super(`mcp_client_${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'McpClientError'
  }
}

export type McpRemoteTool = {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

export type McpCallResult = {
  content?: Array<Record<string, unknown>>
  structuredContent?: unknown
  isError?: boolean
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

export type McpClientDeps = {
  fetchImpl?: FetchLike
  resolveHostIps?: (host: string) => Promise<string[]>
}

export type McpSessionInput = {
  serverUrl: string
  /** Az engedélyezett MCP-hostok (a connector saját hostja; OAuth-felderítésnél pin-to-request). */
  allowedHosts: string[]
  /** OAuth-felderítés: minden kérés a saját hostjára pinelve (SSRF-őr marad). */
  pinToRequestHost?: boolean
  accessToken?: string
  timeoutMs?: number
  maxResponseBytes?: number
  /** D9: a szerver kliens felé irányuló kérése (sampling, elicitation, roots…). */
  onServerRequest?: (method: string) => void
  /** OAuth 401-felderítés: a 401-et visszaadjuk, nem dobjuk (RFC 9728 WWW-Authenticate). */
  passUnauthorized?: boolean
}

export const MCP_DEFAULT_TIMEOUT_MS = 30_000
export const MCP_DEFAULT_MAX_RESPONSE_BYTES = 2_000_000
/** A `tools/list` lapozás plafonja — több száz eszközös szervernél se fújjon fel. */
export const MCP_MAX_TOOLS = 1000

const defaultResolveHostIps = async (host: string) =>
  (await lookup(host, { all: true })).map((entry) => entry.address)

function cappedBody(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let total = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (total > maxBytes) {
          controller.error(new McpClientError('too_large'))
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )
}

/** Őrzött fetch: egress-őr minden kérésen, redirect tiltva, válasz-méretkorlát. */
export function guardedMcpFetch(input: McpSessionInput, deps: McpClientDeps = {}): FetchLike {
  const fetchImpl = deps.fetchImpl ?? fetch
  const resolveHostIps = deps.resolveHostIps ?? defaultResolveHostIps
  const maxBytes = input.maxResponseBytes ?? MCP_DEFAULT_MAX_RESPONSE_BYTES
  return async (url, init) => {
    const target = url.toString()
    let allowlistHosts = input.allowedHosts
    if (input.pinToRequestHost) {
      try {
        allowlistHosts = [new URL(target).hostname.toLowerCase()]
      } catch {
        throw new McpClientError('egress_blocked', 'invalid_url')
      }
    }
    const guard = await guardEgressUrl({
      url: target,
      allowlistHosts,
      resolveHostIps,
    })
    if (!guard.ok) throw new McpClientError('egress_blocked', guard.detail ?? guard.reason)
    const headers = new Headers(init?.headers)
    if (input.accessToken) headers.set('authorization', `Bearer ${input.accessToken}`)
    const res = await fetchImpl(guard.url, { ...init, headers, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) throw new McpClientError('redirect_blocked')
    if (res.status === 401 || res.status === 403) {
      if (!input.passUnauthorized) throw new McpClientError('unauthorized', String(res.status))
      return res
    }
    const declared = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maxBytes) throw new McpClientError('too_large')
    if (!res.body) return res
    return new Response(cappedBody(res.body, maxBytes), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
}

function mapError(error: unknown): McpClientError {
  if (error instanceof McpClientError) return error
  // A transzport a fetch-hibát becsomagolhatja — a cause-láncban keressük.
  let cause: unknown = error
  for (let i = 0; i < 4 && cause; i++) {
    if (cause instanceof McpClientError) return cause
    cause = (cause as { cause?: unknown }).cause
  }
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return new McpClientError('timeout')
  }
  if (error instanceof Error && error.name === 'AbortError') return new McpClientError('timeout')
  const message = error instanceof Error ? error.message : String(error)
  return new McpClientError('server_error', message.slice(0, 300))
}

/** Egy MCP-munkamenet: initialize → `run` → zárás. Minden hiba `McpClientError`. */
export async function withMcpSession<T>(
  input: McpSessionInput,
  run: (client: Client, options: { timeout: number; signal: AbortSignal }) => Promise<T>,
  deps: McpClientDeps = {},
): Promise<T> {
  const timeout = input.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeout)
  // D9: üres kliens-képesség — nincs sampling / elicitation / roots.
  const client = new Client({ name: 'excellence-ai-platform', version: '1.0' }, { capabilities: {} })
  client.fallbackRequestHandler = async (request) => {
    input.onServerRequest?.(request.method)
    throw new McpError(ErrorCode.MethodNotFound, 'Client does not support server-initiated requests')
  }
  const transport = new StreamableHTTPClientTransport(new URL(input.serverUrl), {
    fetch: guardedMcpFetch(input, deps),
    requestInit: { signal: abort.signal },
    reconnectionOptions: {
      maxReconnectionDelay: 0,
      initialReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  })
  try {
    await client.connect(transport, { timeout, signal: abort.signal })
    return await run(client, { timeout, signal: abort.signal })
  } catch (error) {
    throw mapError(error)
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => {})
  }
}

/** A szerver teljes eszközlistája (lapozva, `MCP_MAX_TOOLS` plafonnal). */
export async function mcpListTools(input: McpSessionInput, deps: McpClientDeps = {}): Promise<McpRemoteTool[]> {
  return withMcpSession(
    input,
    async (client, options) => {
      const tools: McpRemoteTool[] = []
      const sentCursors = new Set<string>()
      let cursor: string | undefined
      do {
        if (cursor) sentCursors.add(cursor)
        const page = await client.listTools(cursor ? { cursor } : undefined, options)
        const batch = (page.tools ?? []) as McpRemoteTool[]
        tools.push(...batch)
        cursor = page.nextCursor
        // Egy nem-haladó szerver (üres lap vagy már elküldött — ismétlődő/körbeérő — kurzor) ne
        // pörgesse a kérést a session-timeoutig: ha egy lap nem hoz új eszközt vagy a kurzort
        // már elküldtük, lezárjuk. A szabályos lapozást (nem üres lap + mozgó kurzor) nem érinti.
        // ponytail: az üres-lap kaput szándékosan „vége" jelnek vesszük — egy spec-szerinti
        // üres KÖZBÜLSŐ lap (nem-null kurzorral) itt csonkolna; ez gyakorlatban nem fordul elő,
        // a pörgés-stop fontosabb. Ha valós szervernél gond lesz: lap-plafon a break helyett.
        if (batch.length === 0 || (cursor !== undefined && sentCursors.has(cursor))) break
      } while (cursor && tools.length < MCP_MAX_TOOLS)
      return tools.slice(0, MCP_MAX_TOOLS)
    },
    deps,
  )
}

export async function mcpCallTool(
  input: McpSessionInput & { tool: string; arguments: Record<string, unknown> },
  deps: McpClientDeps = {},
): Promise<McpCallResult> {
  return withMcpSession(
    input,
    async (client, options) =>
      (await client.callTool({ name: input.tool, arguments: input.arguments }, undefined, options)) as McpCallResult,
    deps,
  )
}

export type McpOAuthDiscovery = {
  authUrl: string
  tokenUrl: string
  scopes: string[]
  authorizationServerUrl: string
  registrationEndpoint?: string
}

/**
 * RFC 9728 → RFC 8414 felderítés az egress-őr mögött (D5/D10).
 * Előbb a well-known PRM, ha az nem ad végpontot: 401 WWW-Authenticate `resource_metadata`.
 */
export async function discoverMcpOAuthMetadata(
  serverUrl: string,
  allowedHosts: string[],
  deps: McpClientDeps = {},
): Promise<McpOAuthDiscovery> {
  const fetchFn = guardedMcpFetch(
    { serverUrl, allowedHosts, pinToRequestHost: true, passUnauthorized: true },
    deps,
  )
  const fromWellKnown = await oauthInfoToDiscovery(
    await discoverOAuthServerInfo(serverUrl, { fetchFn }).catch(() => null),
  )
  if (fromWellKnown) return fromWellKnown

  const probe = await fetchFn(serverUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  const resourceMetadataUrl = resourceMetadataUrlFrom401(probe)
  if (probe.status !== 401 || !resourceMetadataUrl) {
    throw new McpClientError('unauthorized', 'oauth_discovery_failed')
  }
  const fromHeader = await oauthInfoToDiscovery(
    await discoverOAuthServerInfo(serverUrl, { fetchFn, resourceMetadataUrl }).catch(() => null),
  )
  if (!fromHeader) throw new McpClientError('unauthorized', 'oauth_discovery_failed')
  return fromHeader
}

/** RFC 9728: 401 WWW-Authenticate `resource_metadata` URL. */
function resourceMetadataUrlFrom401(res: Response): URL | undefined {
  const header = res.headers.get('www-authenticate')
  if (!header) return undefined
  const match = /(?:^|[\s,])resource_metadata=(?:"([^"]+)"|([^\s,]+))/i.exec(header)
  const raw = match?.[1] ?? match?.[2]
  if (!raw) return undefined
  try {
    return new URL(raw)
  } catch {
    return undefined
  }
}

async function oauthInfoToDiscovery(
  info: Awaited<ReturnType<typeof discoverOAuthServerInfo>> | null,
): Promise<McpOAuthDiscovery | null> {
  const metadata = info?.authorizationServerMetadata
  if (!info || !metadata?.authorization_endpoint || !metadata.token_endpoint) return null
  const registration = metadata.registration_endpoint
    ? String(metadata.registration_endpoint)
    : undefined
  return {
    authUrl: String(metadata.authorization_endpoint),
    tokenUrl: String(metadata.token_endpoint),
    scopes: (info.resourceMetadata?.scopes_supported ?? []).slice(0, 50),
    authorizationServerUrl: info.authorizationServerUrl,
    ...(registration ? { registrationEndpoint: registration } : {}),
  }
}

/** RFC 7591: client ID nélküli MCP-szerver (pl. T3 Google-belépés) DCR-rel. */
export async function registerMcpOAuthClient(
  input: {
    authorizationServerUrl: string
    registrationEndpoint: string
    redirectUri: string
    clientName: string
    scopes?: string[]
  },
  deps: McpClientDeps = {},
): Promise<{ clientId: string; clientSecret?: string }> {
  const registrationUrl = new URL(input.registrationEndpoint)
  const fetchFn = guardedMcpFetch(
    {
      serverUrl: input.registrationEndpoint,
      allowedHosts: [registrationUrl.hostname.toLowerCase()],
      pinToRequestHost: true,
    },
    deps,
  )
  try {
    const registered = await registerClient(input.authorizationServerUrl, {
      metadata: { registration_endpoint: input.registrationEndpoint } as never,
      clientMetadata: {
        redirect_uris: [input.redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: input.clientName.slice(0, 120),
        ...(input.scopes?.length ? { scope: input.scopes.join(' ') } : {}),
      } as never,
      fetchFn,
    })
    return {
      clientId: registered.client_id,
      ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}),
    }
  } catch (error) {
    if (error instanceof McpClientError) throw error
    throw new McpClientError('unauthorized', 'dcr_failed')
  }
}
