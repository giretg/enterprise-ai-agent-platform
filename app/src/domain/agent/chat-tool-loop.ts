import type { ToolBrokerInvokeInput } from '@/domain/tool-broker/tool-broker-service'
import type { ToolBrokerService } from '@/domain/tool-broker/tool-broker-service'
import type { GatewayMessage, ModelConfig, ModelGateway } from '@/domain/gateway/model-gateway'
import type { ToolBrokerRepository } from '@/repositories/interfaces'
import type { XlsxRow } from '@/domain/file-editor/adapters/xlsx-adapter'

/** Chatben hívható platform toolok (capability + connector alapján szűrve).
 *  Kihagyva: kb_search (előre lefut a runtime-ban), board_write (belső ticket állapotgép). */
export const CHAT_PLATFORM_TOOLS = [
  'agent_catalog',
  'agent_resolve',
  'ticket_create',
  'agent_ask',
  'gmail_search',
  'gmail_get_message',
  'gmail_create_draft',
  'gmail_send',
  'file_read',
  'file_write',
  'file_edit',
  'file_list',
  'file_glob',
  'file_search',
  'file_delete',
  'xlsx_read_sheet',
  'xlsx_write_cells',
  'xlsx_append_rows',
  'docx_read',
  'pdf_read',
] as const

export type ChatPlatformToolName = (typeof CHAT_PLATFORM_TOOLS)[number]

/**
 * Kontextus-agnosztikus tool loop kontextus: vagy egy chat beszélgetés
 * (`conversationId`), vagy egy aszinkron feladat-ticket (`ticketId`).
 * A két ág kölcsönösen kizáró — egyszerre csak az egyik adható meg.
 */
export type ToolLoopContext =
  | { conversationId: string; ticketId?: never }
  | { ticketId: string; conversationId?: never }

export type ToolLoopMode = 'chat' | 'task'

const TOOL_INSTRUCTION = `
Platform eszközök — ha külső adatra (email, fájl, más agent) vagy ticketre van szükség, NE találj ki tényt, hívd az eszközt.
- Eszközhíváskor válaszolj KIZÁRÓLAG egy JSON objektummal, semmi más szöveg nélkül:
  {"tool":"<eszköz>","args":{...}}
- Ha nincs eszközszükséglet, válaszolj természetes magyar szöveggel (NE JSON).

Szervezeti agentek / Kanban:
1. agent_catalog — args: { "query"?: "nicknév/név", "agentId"?: "uuid", "limit"?: number }
2. agent_resolve — args: { "query": "...", "limit"?: number }
3. ticket_create — args: { "title": "...", "payload": { "task": "..." }, "assigneeType": "human"|"agent", "assigneeId"?: "uuid" }
4. agent_ask — args: { "targetAgentId": "uuid", "question": "...", "context"?: {} } — CSAK completed:true esetén idézd a választ.

Gmail (a beszélgető felhasználó postafiókja — csatlakoztatott fiók kell):
5. gmail_search — args: { "query": "Gmail keresőszintaxis pl. is:unread newer_than:1d", "maxResults"?: number }
   Email-lekérdezésnél (pl. „milyen leveleim vannak ma”) ELŐSZÖR ezt hívd — ne a tudásbázist.
6. gmail_get_message — args: { "id": "messageId" } — egy levél teljes tartalma.
7. gmail_create_draft — args: { "to": "...", "subject": "...", "body": "...", "threadId"?: "..." }
8. gmail_send — args: { "draftId"?: "...", "approvalTicketId"?: "..." } — küldés jóváhagyott ticket mellett.

Agent munkaterület (workspace fájlok):
9. file_list — args: { "path"?: "", "recursive"?: boolean }
10. file_glob — args: { "pattern": "**/*.csv" }
11. file_search — args: { "pattern": "regex", "path"?: "", "glob"?: "", "max_results"?: number }
12. file_read — args: { "path": "rel/útvonal", "offset"?: 1, "limit"?: 2000 }
13. file_write — args: { "path": "...", "content": "..." }
14. file_edit — args: { "path": "...", "old_string": "...", "new_string": "...", "replace_all"?: boolean }
15. file_delete — args: { "path": "..." }
16. xlsx_read_sheet — args: { "path": "...", "sheet"?: "...", "max_rows"?: number }
17. xlsx_write_cells — args: { "path": "...", "sheet"?: "...", "changes": [{ "cell": "A1", "value": "..." }] }
18. xlsx_append_rows — args: { "path": "...", "sheet"?: "...", "rows": [["a","b"]] }
19. docx_read — args: { "path": "..." }
20. pdf_read — args: { "path": "...", "page_range"?: "1-3" }
`

function isChatPlatformTool(name: string): name is ChatPlatformToolName {
  return (CHAT_PLATFORM_TOOLS as readonly string[]).includes(name)
}

function extractToolCall(content: string): { tool: string; args: Record<string, unknown> } | null {
  const trimmed = content.trim()

  const codeBlock = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i)
  const candidates = [codeBlock?.[1], trimmed.startsWith('{') ? trimmed : null]

  const inline = trimmed.match(/\{[\s\S]*"tool"\s*:\s*"[^"]+"[\s\S]*\}/)
  if (inline?.[0]) candidates.push(inline[0])

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate) as { tool?: string; args?: Record<string, unknown> }
      if (typeof parsed.tool === 'string' && parsed.args && typeof parsed.args === 'object') {
        return { tool: parsed.tool, args: parsed.args }
      }
    } catch {
      // continue
    }
  }
  return null
}

function stripToolArtifacts(content: string): string {
  return content
    .replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/gi, '')
    .replace(/\{[\s\S]*"tool"\s*:\s*"[^"]+"[\s\S]*\}/g, '')
    .trim()
}

function strArg(args: Record<string, unknown>, key: string, fallback = ''): string {
  return typeof args[key] === 'string' ? args[key] : fallback
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  return typeof args[key] === 'number' ? args[key] : undefined
}

function boolArg(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === 'boolean' ? args[key] : undefined
}

function recordArg(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key]
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

function buildToolInvoke(
  tool: ChatPlatformToolName,
  args: Record<string, unknown>,
  base: {
    agentId: string
    agentVersion: number
    context: ToolLoopContext
    actingUserId?: string
  },
): ToolBrokerInvokeInput {
  const common = {
    agentId: base.agentId,
    agentVersion: base.agentVersion,
    ...base.context,
    ...(base.actingUserId ? { actingUserId: base.actingUserId } : {}),
  }

  switch (tool) {
    case 'agent_resolve':
      return {
        ...common,
        tool: 'agent_resolve',
        args: {
          query: strArg(args, 'query'),
          limit: numArg(args, 'limit'),
        },
      }

    case 'agent_catalog':
      return {
        ...common,
        tool: 'agent_catalog',
        args: {
          query: typeof args.query === 'string' ? args.query : undefined,
          agentId: typeof args.agentId === 'string' ? args.agentId : undefined,
          limit: numArg(args, 'limit'),
        },
      }

    case 'ticket_create':
      return {
        ...common,
        tool: 'ticket_create',
        args: {
          title: strArg(args, 'title'),
          payload: recordArg(args, 'payload') ?? {},
          assigneeType: args.assigneeType === 'agent' ? 'agent' : 'human',
          assigneeId: typeof args.assigneeId === 'string' ? args.assigneeId : undefined,
          sourceDocumentId: typeof args.sourceDocumentId === 'string' ? args.sourceDocumentId : undefined,
        },
      }

    case 'agent_ask':
      return {
        ...common,
        tool: 'agent_ask',
        args: {
          targetAgentId: strArg(args, 'targetAgentId'),
          question: strArg(args, 'question'),
          context: recordArg(args, 'context'),
        },
      }

    case 'gmail_search':
      return {
        ...common,
        tool: 'gmail_search',
        args: {
          query: strArg(args, 'query'),
          maxResults: numArg(args, 'maxResults'),
        },
      }

    case 'gmail_get_message':
      return {
        ...common,
        tool: 'gmail_get_message',
        args: { id: strArg(args, 'id') },
      }

    case 'gmail_create_draft':
      return {
        ...common,
        tool: 'gmail_create_draft',
        args: {
          to: strArg(args, 'to'),
          subject: strArg(args, 'subject'),
          body: strArg(args, 'body'),
          threadId: typeof args.threadId === 'string' ? args.threadId : undefined,
        },
      }

    case 'gmail_send':
      return {
        ...common,
        tool: 'gmail_send',
        args: {
          draftId: typeof args.draftId === 'string' ? args.draftId : undefined,
          to: typeof args.to === 'string' ? args.to : undefined,
          subject: typeof args.subject === 'string' ? args.subject : undefined,
          body: typeof args.body === 'string' ? args.body : undefined,
          approvalTicketId: typeof args.approvalTicketId === 'string' ? args.approvalTicketId : undefined,
        },
      }

    case 'file_read':
      return {
        ...common,
        tool: 'file_read',
        args: {
          path: strArg(args, 'path'),
          offset: numArg(args, 'offset'),
          limit: numArg(args, 'limit'),
        },
      }

    case 'file_write':
      return {
        ...common,
        tool: 'file_write',
        args: {
          path: strArg(args, 'path'),
          content: strArg(args, 'content'),
        },
      }

    case 'file_edit':
      return {
        ...common,
        tool: 'file_edit',
        args: {
          path: strArg(args, 'path'),
          old_string: strArg(args, 'old_string'),
          new_string: strArg(args, 'new_string'),
          replace_all: boolArg(args, 'replace_all'),
        },
      }

    case 'file_list':
      return {
        ...common,
        tool: 'file_list',
        args: {
          path: typeof args.path === 'string' ? args.path : undefined,
          recursive: boolArg(args, 'recursive'),
        },
      }

    case 'file_glob':
      return {
        ...common,
        tool: 'file_glob',
        args: { pattern: strArg(args, 'pattern') },
      }

    case 'file_search':
      return {
        ...common,
        tool: 'file_search',
        args: {
          pattern: strArg(args, 'pattern'),
          path: typeof args.path === 'string' ? args.path : undefined,
          glob: typeof args.glob === 'string' ? args.glob : undefined,
          ignore_case: boolArg(args, 'ignore_case'),
          max_results: numArg(args, 'max_results'),
        },
      }

    case 'file_delete':
      return {
        ...common,
        tool: 'file_delete',
        args: { path: strArg(args, 'path') },
      }

    case 'xlsx_read_sheet':
      return {
        ...common,
        tool: 'xlsx_read_sheet',
        args: {
          path: strArg(args, 'path'),
          sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
          max_rows: numArg(args, 'max_rows'),
        },
      }

    case 'xlsx_write_cells':
      return {
        ...common,
        tool: 'xlsx_write_cells',
        args: {
          path: strArg(args, 'path'),
          sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
          changes: Array.isArray(args.changes)
            ? (args.changes as Array<{ cell: string; value: string | number | boolean | null }>)
            : [],
        },
      }

    case 'xlsx_append_rows':
      return {
        ...common,
        tool: 'xlsx_append_rows',
        args: {
          path: strArg(args, 'path'),
          sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
          rows: Array.isArray(args.rows) ? (args.rows as XlsxRow[]) : [],
        },
      }

    case 'docx_read':
      return {
        ...common,
        tool: 'docx_read',
        args: { path: strArg(args, 'path') },
      }

    case 'pdf_read':
      return {
        ...common,
        tool: 'pdf_read',
        args: {
          path: strArg(args, 'path'),
          page_range: typeof args.page_range === 'string' ? args.page_range : undefined,
        },
      }

    default: {
      const _exhaustive: never = tool
      throw new Error(`Unsupported chat tool: ${_exhaustive}`)
    }
  }
}

/**
 * Egységes, kontextus-agnosztikus agent tool loop. Chat (`conversationId`) és
 * feladat-ticket (`ticketId`) kontextusban egyaránt fut — a képességek
 * azonosak, csak a kontextus (és a board_write utómunka a hívónál) tér el.
 */
export async function runAgentToolLoop(params: {
  gateway: ModelGateway
  toolBroker: ToolBrokerService
  toolCaps: ToolBrokerRepository
  agentId: string
  agentVersion: number
  context: ToolLoopContext
  mode: ToolLoopMode
  /** Chatben a beszélgető felhasználó; taskban a broker oldja fel a ticket run-as payloadjából. */
  actingUserId?: string
  messages: GatewayMessage[]
  modelConfig: ModelConfig
  allowedTools: ChatPlatformToolName[]
  maxTurns?: number
}): Promise<{ content: string; toolCallCount: number }> {
  const maxTurns = params.maxTurns ?? 10
  const modeNote =
    params.mode === 'task'
      ? 'Ez egy aszinkron feladat — a végeredményed visszakerül a ticketbe. Dolgozz végig minden szükséges eszközhívást, majd add meg a kész választ természetes magyar szövegként (NE JSON).'
      : 'Ez egy közvetlen beszélgetés — a végén természetes magyar szöveggel válaszolj a felhasználónak (NE JSON).'
  const messages: GatewayMessage[] = [
    ...params.messages,
    { role: 'system', content: TOOL_INSTRUCTION },
    { role: 'system', content: modeNote },
    {
      role: 'system',
      content: `A számodra engedélyezett eszközök: ${params.allowedTools.join(', ')}`,
    },
  ]

  let toolCallCount = 0

  for (let turn = 0; turn < maxTurns; turn++) {
    const { content } = await params.gateway.call({
      agentId: params.agentId,
      ...params.context,
      messages,
      modelConfig: params.modelConfig,
    })

    const toolCall = extractToolCall(content)
    if (!toolCall) {
      const cleaned = stripToolArtifacts(content)
      if (cleaned) return { content: cleaned, toolCallCount }

      if (turn < maxTurns - 1) {
        messages.push({
          role: 'user',
          content: '[Belső] Üres válasz. Fogalmazd meg magyarul a felhasználónak.',
        })
        continue
      }
      return { content: content.trim() || 'Nem kaptam választ a modelltől.', toolCallCount }
    }

    if (!isChatPlatformTool(toolCall.tool) || !params.allowedTools.includes(toolCall.tool)) {
      messages.push({
        role: 'user',
        content: `[Belső] Az eszköz „${toolCall.tool}" nem elérhető. Engedélyezett: ${params.allowedTools.join(', ')}`,
      })
      continue
    }

    try {
      const invokeInput = buildToolInvoke(toolCall.tool, toolCall.args, {
        agentId: params.agentId,
        agentVersion: params.agentVersion,
        context: params.context,
        actingUserId: params.actingUserId,
      })

      const result = await params.toolBroker.invoke(invokeInput)
      toolCallCount += 1

      if (result.denied) {
        messages.push({
          role: 'user',
          content: `[Tool eredmény: ${toolCall.tool}] ELUTASÍTVA: ${result.reason}`,
        })
      } else {
        messages.push({
          role: 'user',
          content: `[Tool eredmény: ${toolCall.tool}]\n${JSON.stringify(result.result)}`,
        })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'tool_call_failed'
      messages.push({
        role: 'user',
        content: `[Tool eredmény: ${toolCall.tool}] HIBA: ${message}`,
      })
    }
  }

  messages.push({
    role: 'system',
    content:
      'Fogalmazd meg a felhasználónak magyarul. agent_ask: completed:true + answer → fogalmazd át; completed:false → mondd el hogy nem sikerült. Gmail/file eszköz: csak a tool eredményére támaszkodj, ne találj ki adatot. connector_grant_missing esetén jelezd hogy csatlakoztasd a fiókot. Ne használj JSON tool blokkot.',
  })

  const { content: finalContent } = await params.gateway.call({
    agentId: params.agentId,
    ...params.context,
    messages,
    modelConfig: params.modelConfig,
  })

  return {
    content: stripToolArtifacts(finalContent) || finalContent.trim(),
    toolCallCount,
  }
}

export async function listAllowedChatTools(
  toolCaps: ToolBrokerRepository,
  agentId: string,
): Promise<ChatPlatformToolName[]> {
  const caps = await toolCaps.findCapabilitiesForAgent(agentId)
  return caps
    .filter((c) => c.allowed && isChatPlatformTool(c.toolName))
    .map((c) => c.toolName as ChatPlatformToolName)
}
