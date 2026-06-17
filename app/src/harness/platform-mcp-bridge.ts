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

const GMAIL_TOOLS = ['gmail_search', 'gmail_get_message', 'gmail_create_draft', 'gmail_send'] as const

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
  {
    name: 'ticket_create',
    description:
      'Create a new interaction ticket on the board. Use assigneeType human for human review (awaiting_human), or agent to delegate work (ready for dispatch).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short ticket title' },
        payload: { type: 'object', description: 'Ticket payload (question, context, etc.)' },
        assigneeType: {
          type: 'string',
          enum: ['human', 'agent'],
          description: 'human = awaiting_human review; agent = dispatch to assigneeId',
        },
        assigneeId: {
          type: 'string',
          description: 'Target agent UUID (required when assigneeType is agent)',
        },
        sourceDocumentId: { type: 'string', description: 'Optional source document UUID' },
      },
      required: ['title', 'payload', 'assigneeType'],
    },
  },
  {
    name: 'agent_ask',
    description:
      'Ask another agent a question via a delegation ticket. The target agent answers; the ticket returns to you (ready) with the answer in payload.',
    inputSchema: {
      type: 'object',
      properties: {
        targetAgentId: { type: 'string', description: 'Agent UUID to answer the question' },
        question: { type: 'string', description: 'Question for the target agent' },
        context: { type: 'object', description: 'Optional extra context for the delegate' },
      },
      required: ['targetAgentId', 'question'],
    },
  },
  {
    name: 'agent_resolve',
    description: 'Find AI agents by nickname or name (e.g. Bori → Könyvelő Agent).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Nickname, name, or keyword' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'agent_catalog',
    description:
      'List or look up AI agents with full profile: role instruction, behavior, model, tools, connectors, resources, recipe.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional search by nickname, name, or keyword' },
        agentId: { type: 'string', description: 'Optional specific agent UUID' },
        limit: { type: 'number', description: 'Max results (default 25 or 5 when searching)' },
      },
    },
  },
  ...GMAIL_TOOLS.map((name) => ({
    name,
    description:
      name === 'gmail_search'
        ? 'Search the acting user Gmail mailbox (requires connected account).'
        : name === 'gmail_get_message'
          ? 'Fetch a Gmail message by id for the acting user.'
          : name === 'gmail_create_draft'
            ? 'Create a Gmail draft (does not send).'
            : 'Send Gmail — requires human approval on an approved ticket.',
    inputSchema:
      name === 'gmail_search'
        ? {
            type: 'object',
            properties: {
              query: { type: 'string' },
              maxResults: { type: 'number' },
            },
            required: ['query'],
          }
        : name === 'gmail_get_message'
          ? {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            }
          : name === 'gmail_create_draft'
            ? {
                type: 'object',
                properties: {
                  to: { type: 'string' },
                  subject: { type: 'string' },
                  body: { type: 'string' },
                  threadId: { type: 'string' },
                },
                required: ['to', 'subject', 'body'],
              }
            : {
                type: 'object',
                properties: {
                  draftId: { type: 'string' },
                  approvalTicketId: { type: 'string' },
                },
              },
  })),
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
      : tool.startsWith('gmail_')
        ? {
            tool,
            ticketId,
            actingUserId: env.ACTING_USER_ID?.trim() || undefined,
            conversationId: env.CONVERSATION_ID?.trim() || undefined,
            args,
          }
        : tool === 'ticket_create'
        ? {
            tool: 'ticket_create',
            ticketId,
            args: {
              title: String(args.title ?? ''),
              payload: (args.payload as Record<string, unknown>) ?? {},
              assigneeType: String(args.assigneeType ?? 'human'),
              assigneeId: typeof args.assigneeId === 'string' ? args.assigneeId : undefined,
              sourceDocumentId:
                typeof args.sourceDocumentId === 'string' ? args.sourceDocumentId : undefined,
            },
          }
        : tool === 'agent_ask'
          ? {
              tool: 'agent_ask',
              ticketId,
              args: {
                targetAgentId: String(args.targetAgentId ?? ''),
                question: String(args.question ?? ''),
                context:
                  args.context && typeof args.context === 'object' && !Array.isArray(args.context)
                    ? (args.context as Record<string, unknown>)
                    : undefined,
              },
            }
          : tool === 'agent_resolve'
            ? {
                tool: 'agent_resolve',
                ticketId,
                args: {
                  query: String(args.query ?? ''),
                  limit: typeof args.limit === 'number' ? args.limit : undefined,
                },
              }
            : tool === 'agent_catalog'
              ? {
                  tool: 'agent_catalog',
                  ticketId,
                  args: {
                    query: typeof args.query === 'string' ? args.query : undefined,
                    agentId: typeof args.agentId === 'string' ? args.agentId : undefined,
                    limit: typeof args.limit === 'number' ? args.limit : undefined,
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
