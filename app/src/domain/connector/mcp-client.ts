/**
 * Kimenő MCP-kliens a külső MCP-szerverekhez (#395 WP-1).
 *
 * Az SDK `Client` + `StreamableHTTPClientTransport` párosát használjuk; a saját
 * JSON-RPC réteg helyett csak a transzport `fetch`-jét cseréljük egy őrzöttre:
 *  - minden kérés `guardEgressUrl`-en megy át (https, SSRF, feloldás utáni
 *    privát-IP, az MCP-allowlist hostjai — D8/D10);
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
  /** Az engedélyezett MCP-hostok (platform-allowlist ∩ a connector hostja). */
  allowedHosts: string[]
  accessToken?: string
  timeoutMs?: number
  maxResponseBytes?: number
  /** D9: a szerver kliens felé irányuló kérése (sampling, elicitation, roots…). */
  onServerRequest?: (method: string) => void
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
    const guard = await guardEgressUrl({
      url: url.toString(),
      allowlistHosts: input.allowedHosts,
      resolveHostIps,
    })
    if (!guard.ok) throw new McpClientError('egress_blocked', guard.detail ?? guard.reason)
    const headers = new Headers(init?.headers)
    if (input.accessToken) headers.set('authorization', `Bearer ${input.accessToken}`)
    const res = await fetchImpl(guard.url, { ...init, headers, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) throw new McpClientError('redirect_blocked')
    if (res.status === 401 || res.status === 403) throw new McpClientError('unauthorized', String(res.status))
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
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, options)
        tools.push(...(page.tools as McpRemoteTool[]))
        cursor = page.nextCursor
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
