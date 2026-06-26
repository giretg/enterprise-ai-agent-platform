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

const FILE_TOOLS = [
  'file_read',
  'file_write',
  'file_edit',
  'file_list',
  'file_glob',
  'file_search',
  'file_delete',
] as const

const BINARY_TOOLS = [
  'xlsx_read_sheet',
  'xlsx_write_cells',
  'xlsx_format_range',
  'xlsx_layout',
  'xlsx_create',
  'xlsx_append_rows',
  'docx_read',
  'pdf_read',
] as const

/** Közös cella-stílus JSON-séma a formázó toolokhoz (CellStyle, §2). */
const CELL_STYLE_SCHEMA = {
  type: 'object',
  description: 'Cell formatting. Colors accept RGB ("1F4E78") or ARGB ("FF1F4E78") hex.',
  properties: {
    font: {
      type: 'object',
      properties: {
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        size: { type: 'number' },
        color: { type: 'string', description: 'RGB or ARGB hex, e.g. "FFFFFFFF"' },
        name: { type: 'string', description: 'Font family, e.g. "Calibri"' },
      },
    },
    fill: {
      type: 'object',
      properties: {
        color: { type: 'string', description: 'Solid background, RGB or ARGB hex' },
      },
    },
    alignment: {
      type: 'object',
      properties: {
        horizontal: { type: 'string', enum: ['left', 'center', 'right'] },
        vertical: { type: 'string', enum: ['top', 'middle', 'bottom'] },
        wrapText: { type: 'boolean' },
      },
    },
    border: {
      type: 'object',
      properties: {
        top: { type: 'string', enum: ['thin', 'medium', 'thick'] },
        bottom: { type: 'string', enum: ['thin', 'medium', 'thick'] },
        left: { type: 'string', enum: ['thin', 'medium', 'thick'] },
        right: { type: 'string', enum: ['thin', 'medium', 'thick'] },
      },
    },
    numFmt: { type: 'string', description: 'Excel number format, e.g. "#,##0.00", "0.0%"' },
  },
} as const

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
      'Ask another agent a question via a delegation ticket. The target agent answers; the delegation ticket closes (done) with the answer in payload.',
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
  {
    name: 'file_read',
    description: 'Read a file from the ticket workspace. Returns content with line numbers. Use offset + limit for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within workspace, e.g. "data/report.csv"' },
        offset: { type: 'number', description: 'Start from this line number (1-based, default 1)' },
        limit: { type: 'number', description: 'Max lines to return (default 2000)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description: 'Write (overwrite or create) a file in the ticket workspace. For edits to existing files prefer file_edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within workspace' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_edit',
    description: 'Replace an exact string in a file. old_string must be unique — provide surrounding context if needed. Fails if old_string not found or ambiguous (use replace_all: true for bulk replace).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to find and replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'file_list',
    description: 'List files and directories in a workspace path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default: workspace root)' },
        recursive: { type: 'boolean', description: 'List recursively (default false)' },
      },
    },
  },
  {
    name: 'file_glob',
    description: 'Find files matching a glob pattern in the workspace. Returns matching paths sorted by last modified.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.csv" or "reports/*.xlsx"' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'file_search',
    description: 'Search file contents using a regex pattern. Returns matching lines with file path and line number.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search in (default: workspace root)' },
        glob: { type: 'string', description: 'Limit to files matching this glob, e.g. "*.csv"' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search (default false)' },
        max_results: { type: 'number', description: 'Max matching lines to return (default 100)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'file_delete',
    description: 'Delete a file from the workspace. Irreversible — use with care.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'xlsx_read_sheet',
    description: 'Read an Excel worksheet as a JSON array of row objects. Headers from the first row become object keys.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet: { type: 'string', description: 'Sheet name (default: first sheet)' },
        max_rows: { type: 'number', description: 'Max rows to return (default 500)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'xlsx_write_cells',
    description:
      'Update individual cells in an Excel file with value and/or formula and/or formatting. Cell addresses use A1 notation. style is merged onto the existing cell style. Use formula (without "=") for SUM etc. — note the computed value is only filled in when the file is opened in Excel/LibreOffice.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet: { type: 'string' },
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              cell: { type: 'string', description: 'e.g. "B3"' },
              value: { description: 'string | number | boolean | null (mutually exclusive with formula)' },
              formula: { type: 'string', description: 'e.g. "SUM(B2:B10)" — without leading "="' },
              style: CELL_STYLE_SCHEMA,
              numFmt: { type: 'string', description: 'Shortcut for style.numFmt, e.g. "# ##0 Ft"' },
            },
            required: ['cell'],
          },
        },
      },
      required: ['path', 'changes'],
    },
  },
  {
    name: 'xlsx_format_range',
    description:
      'Apply one CellStyle to every cell in an A1 rectangle range (e.g. "A1:E1" to style a header row).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet: { type: 'string' },
        range: { type: 'string', description: 'A1 range, e.g. "A1:E1" or "A1:A100"' },
        style: CELL_STYLE_SCHEMA,
      },
      required: ['path', 'range', 'style'],
    },
  },
  {
    name: 'xlsx_layout',
    description:
      'Structural operations on a worksheet: merge cells, column widths, row heights, freeze panes, autofilter. All fields optional; combine several in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet: { type: 'string' },
        mergeCells: {
          type: 'array',
          items: { type: 'string' },
          description: 'A1 ranges to merge, e.g. ["A1:D1", "A2:A5"]',
        },
        columnWidths: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: 'Column letter, e.g. "A"' },
              width: { type: 'number' },
            },
            required: ['column', 'width'],
          },
        },
        rowHeights: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              row: { type: 'number', description: '1-based row number' },
              height: { type: 'number' },
            },
            required: ['row', 'height'],
          },
        },
        freeze: {
          type: 'object',
          properties: {
            rows: { type: 'number', description: 'Rows to freeze from the top, e.g. 1 for header' },
            columns: { type: 'number', description: 'Columns to freeze from the left' },
          },
        },
        autoFilter: { type: 'string', description: 'A1 range for the filter header, e.g. "A1:E1"' },
      },
      required: ['path'],
    },
  },
  {
    name: 'xlsx_create',
    description:
      'Create a new empty Excel workbook with named worksheet(s) and optional initial 2D data rows. Fails with FILE_ALREADY_EXISTS if the path exists.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path, e.g. "reports/q2.xlsx"' },
        sheets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Worksheet name (max 31 chars)' },
              rows: {
                type: 'array',
                items: { type: 'array', items: {} },
                description: '2D array of rows (first row typically the header)',
              },
            },
            required: ['name'],
          },
        },
      },
      required: ['path', 'sheets'],
    },
  },
  {
    name: 'xlsx_append_rows',
    description: 'Append rows to an Excel worksheet.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet: { type: 'string' },
        rows: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of row objects matching the header columns',
        },
      },
      required: ['path', 'rows'],
    },
  },
  {
    name: 'docx_read',
    description: 'Extract text content from a Word document (.docx).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'pdf_read',
    description: 'Extract text content from a PDF file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        page_range: { type: 'string', description: 'e.g. "1-5" or "3" (default: all)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'http_api_get',
    description:
      'Read (GET) from the external REST API connector assigned to this agent. path is relative to the connector base URL (e.g. "/banks" or "/banks/{id}/crm"). The API key is injected by the platform.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the connector base URL' },
        query: { type: 'object', description: 'Query parameters (scalar values)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'http_api_request',
    description:
      'Write (POST/PUT/PATCH/DELETE) to the external REST API connector assigned to this agent. Only call for operations that change state. The API key is injected by the platform.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'Path relative to the connector base URL' },
        query: { type: 'object', description: 'Query parameters (scalar values)' },
        body: { type: 'object', description: 'JSON request body' },
      },
      required: ['method', 'path'],
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
      : tool.startsWith('http_api_')
        ? { tool, ticketId, args }
      : tool.startsWith('file_') || (FILE_TOOLS as readonly string[]).includes(tool) || (BINARY_TOOLS as readonly string[]).includes(tool)
        ? { tool, ticketId, args }
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
