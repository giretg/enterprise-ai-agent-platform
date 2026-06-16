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

export const PLATFORM_BROKER_TOOLS = [
  {
    name: 'kb_search',
    description: 'Search the agent knowledge base for relevant snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        k: { type: 'number', description: 'Maximum number of hits (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'board_write',
    description: 'Update a ticket payload and/or state on the control plane board.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'Target ticket UUID' },
        patch: {
          type: 'object',
          properties: {
            state: { type: 'string' },
            payload: { type: 'object' },
          },
        },
      },
      required: ['ticketId', 'patch'],
    },
  },
] as const

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

  const body =
    tool === 'kb_search'
      ? {
          tool: 'kb_search',
          ticketId,
          args: {
            query: String(args.query ?? ''),
            k: typeof args.k === 'number' ? args.k : undefined,
          },
        }
      : {
          tool: 'board_write',
          ticketId: String(args.ticketId ?? ticketId ?? ''),
          args: {
            ticketId: String(args.ticketId ?? ticketId ?? ''),
            patch: (args.patch as Record<string, unknown>) ?? {},
          },
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
