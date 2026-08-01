import {
  TOOL_GROUP_GMAIL,
  TOOL_GROUP_WEB,
  TOOL_REGISTRY,
  resolveToolDescriptor,
  toolJsonSchema,
  toolsForSurface,
} from '@/domain/tool-broker/tool-registry'

/** A hívó felhasználójának / beszélgetésének kontextusát igénylő eszközcsoportok. */
const USER_SCOPED_TOOL_GROUPS = new Set<string>([TOOL_GROUP_GMAIL, TOOL_GROUP_WEB])

export type McpJsonRpcRequest = {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

export type McpJsonRpcResponse = {
  jsonrpc: '2.0'
  id?: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/**
 * A KIFELÉ menő MCP-vetület (issue #194, WP-3). A tool-lista és minden
 * `inputSchema` a kanonikus `TOOL_REGISTRY`-ből GENERÁLÓDIK — nincs többé
 * kézzel írt tool-definíció ebben a fájlban. Korábban a Goose-út listája
 * észrevétlenül elsodródott a chat-útétól; generált vetületként ez nem tud
 * megismétlődni, a fenntartási költsége pedig közel nulla (D5).
 */
export const PLATFORM_BROKER_TOOLS: ReadonlyArray<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
}> = toolsForSurface('mcp').map((name) => ({
  name,
  description: TOOL_REGISTRY[name].description,
  inputSchema: toolJsonSchema(name),
}))

export type PlatformToolInvoker = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>

const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'] as const

function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requested as (typeof SUPPORTED_MCP_PROTOCOL_VERSIONS)[number])) {
    return requested
  }
  return '2025-03-26'
}

export function writeMcpMessage(message: McpJsonRpcResponse) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Goose/rmcp stdio transport: newline-delimited JSON (nem Content-Length). */
export async function readMcpFramedMessages(
  input: NodeJS.ReadableStream,
  onMessage: (message: McpJsonRpcRequest) => Promise<McpJsonRpcResponse>,
): Promise<void> {
  const { createInterface } = await import('node:readline')
  input.resume()
  const rl = createInterface({ input, crlfDelay: Infinity })

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const message = JSON.parse(trimmed) as McpJsonRpcRequest
    const response = await onMessage(message)
    if (response.result !== undefined || response.error !== undefined) {
      writeMcpMessage(response)
    }
  }
}

export async function handleMcpRequest(
  request: McpJsonRpcRequest,
  invokeTool: PlatformToolInvoker,
): Promise<McpJsonRpcResponse> {
  const id = request.id

  try {
    switch (request.method) {
      case 'initialize': {
        const params = request.params ?? {}
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiateProtocolVersion(params.protocolVersion),
            capabilities: { tools: {} },
            serverInfo: { name: 'platform-broker-bridge', version: '0.1.0' },
          },
        }
      }
      case 'notifications/initialized':
        return { jsonrpc: '2.0', id }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: PLATFORM_BROKER_TOOLS } }
      case 'tools/call': {
        const params = request.params ?? {}
        const name = String(params.name ?? '')
        const args = (params.arguments as Record<string, unknown>) ?? {}
        const result = await invokeTool(name, args)
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            isError: false,
          },
        }
      }
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        }
    }
  } catch (e) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: e instanceof Error ? e.message : 'platform bridge error',
      },
    }
  }
}

export async function invokePlatformToolViaHttp(
  tool: string,
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
): Promise<unknown> {
  const platformApiUrl = env.PLATFORM_API_URL?.replace(/\/$/, '')
  const apiKey = env.HARNESS_AGENT_API_KEY
  const ticketId = env.TICKET_ID?.trim()
  if (!platformApiUrl || !apiKey) {
    throw new Error('Missing PLATFORM_API_URL or HARNESS_AGENT_API_KEY')
  }

  const descriptor = resolveToolDescriptor(tool)
  if (!descriptor || !descriptor.surfaces.includes('mcp')) {
    throw new Error(`Unsupported platform broker tool: ${tool}`)
  }

  // A törzs a regiszterből képződik: az args VÁLTOZATLANUL megy tovább, a
  // szerveroldali `toolInvokeSchema` (ugyanabból a descriptorból generálva)
  // validálja. Korábban itt egy második, kézi args-leképezés élt — ez volt az
  // egyik hely, ahol a két út némán elcsúszhatott egymástól.
  const body: Record<string, unknown> = {
    tool,
    // A board_write CÉLJA a hívásban megadott ticket, nem a futás sajátja.
    ticketId: tool === 'board_write' ? String(args.ticketId ?? ticketId ?? '') : ticketId,
    args,
  }

  // Felhasználó-hatókörű eszközök (postafiók, webes kutatás) a hívó
  // beszélgetésének és felhasználójának kontextusán futnak. A workspace-es
  // toolokhoz SZÁNDÉKOSAN nem adjuk hozzá a conversationId-t: ott a ticket a
  // munkaterület gazdája, és egy beszélgetés-azonosító átirányítaná a fájlokat.
  if (USER_SCOPED_TOOL_GROUPS.has(descriptor.capabilityGroup)) {
    const actingUserId = env.ACTING_USER_ID?.trim()
    const conversationId = env.CONVERSATION_ID?.trim()
    if (actingUserId) body.actingUserId = actingUserId
    if (conversationId) body.conversationId = conversationId
  }


  const response = await fetch(`${platformApiUrl}/api/v1/agent/tools`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const payload = (await response.json()) as {
    success?: boolean
    error?: string
    data?: { denied?: boolean; reason?: string; result?: unknown }
  }

  if (!response.ok || !payload.success) {
    throw new Error(payload.error ?? `Tool broker HTTP ${response.status}`)
  }

  if (payload.data?.denied) {
    throw new Error(payload.data.reason ?? 'tool denied')
  }

  return payload.data?.result ?? payload.data
}
