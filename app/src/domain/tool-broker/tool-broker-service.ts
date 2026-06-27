import type {
  AssigneeType,
  Connector,
  ConnectorAccessMode,
  ConnectorGrant,
  ConnectorType,
  Prisma,
  Ticket,
  TicketState,
  ToolCallStatus,
  UserStatus,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import { personaFor } from '@/lib/agent-persona'
import {
  buildAgentCatalogEntry,
  scoreAgentForCatalogQuery,
  type AgentCatalogEntry,
} from '@/lib/agent-catalog'
import { readDelegationPayload, shouldCompleteDelegation } from '@/lib/delegation-payload'
import { isRunAsAuthorized, readRunAsUserId, RUN_AS_AUTHORIZED_AT, RUN_AS_AUTHORIZED_BY } from '@/lib/run-as-payload'
import { GmailApiAuthError, GmailApiClient } from '@/domain/connector-grant/gmail-api-client'
import { gmailToolAllowedByScopes } from '@/domain/connector-grant/gmail-scopes'
import {
  HttpApiClient,
  parseHttpApiConfig,
  resolveConnectorApiKey,
} from '@/domain/connector/http-api-client'
import type { ConnectorGrantService } from '@/domain/connector-grant/connector-grant-service'
import type { FileEditorService } from '@/domain/file-editor/file-editor-service'
import {
  FileEditorError,
  type FileReadResult,
  type FileWriteResult,
  type FileEditResult,
  type FileListResult,
  type FileGlobResult,
  type FileSearchResult,
  type FileDeleteResult,
  type XlsxReadSheetResult,
  type XlsxWriteCellsResult,
  type XlsxAppendRowsResult,
  type XlsxFormatRangeResult,
  type XlsxLayoutResult,
  type XlsxCreateResult,
  type DocxReadResult,
  type PdfReadResult,
} from '@/domain/file-editor/file-editor-service'
import type {
  AgentRepository,
  AuditRepository,
  ConnectorGrantRepository,
  TicketRepository,
  ToolBrokerRepository,
} from '@/repositories/interfaces'
import type { TicketService } from '@/domain/ticket/ticket-service'
import type {
  XlsxRow,
  XlsxCellChange,
  CellStyle,
  XlsxSheetSpec,
} from '@/domain/file-editor/adapters/xlsx-adapter'

export type KbSearchArgs = {
  query: string
  k?: number
}

export type KbSearchHit = {
  docId: string
  snippet: string
  sourceRef: string
  memoryVersion: number | null
}

export type KbSearchResult = {
  hits: KbSearchHit[]
}

export type BoardWriteArgs = {
  ticketId: string
  patch: {
    state?: TicketState
    payload?: Record<string, unknown>
  }
}

export type BoardWriteResult = {
  ok: boolean
  ticketId: string
  state: TicketState
}

export type TicketCreateArgs = {
  title: string
  payload: Record<string, unknown>
  assigneeType: AssigneeType
  assigneeId?: string
  sourceDocumentId?: string
}

export type TicketCreateResult = {
  ok: boolean
  ticketId: string
  state: TicketState
  assigneeType: AssigneeType
  assigneeId: string | null
}

export type AgentAskArgs = {
  targetAgentId: string
  question: string
  context?: Record<string, unknown>
}

export type AgentAskResult = {
  ok: boolean
  ticketId: string
  state: TicketState
  targetAgentId: string
  requesterAgentId: string
  /** Chat-kontextusban (conversationId) szinkron delegálás után kitöltve. */
  completed?: boolean
  answer?: string
  sources?: unknown
  rationale?: string
  confidence?: string
  answeredByAgentId?: string
  error?: string
}

export type DelegationProcessInput = {
  ticketId: string
  targetAgentId: string
  requesterAgentId: string
  actingUserId?: string
}

export type DelegationProcessor = (input: DelegationProcessInput) => Promise<void>

export type AgentResolveArgs = {
  query: string
  limit?: number
}

export type AgentResolveHit = {
  agentId: string
  name: string
  nickname: string
  role: string
  trait: string
  score: number
}

export type AgentResolveResult = {
  agents: AgentResolveHit[]
}

export type AgentCatalogArgs = {
  query?: string
  agentId?: string
  limit?: number
}

export type AgentCatalogResult = {
  agents: AgentCatalogEntry[]
}

export type GmailSearchArgs = { query: string; maxResults?: number }
export type GmailGetMessageArgs = { id: string }
export type GmailCreateDraftArgs = {
  to: string
  subject: string
  body: string
  threadId?: string
}
export type GmailSendArgs = {
  draftId?: string
  to?: string
  subject?: string
  body?: string
  approvalTicketId?: string
}

export type HttpApiQuery = Record<string, string | number | boolean>
export type HttpApiGetArgs = { path: string; query?: HttpApiQuery }
export type HttpApiRequestArgs = {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  query?: HttpApiQuery
  body?: unknown
}
export type HttpApiCallResult = { status: number; ok: boolean; body: unknown }

export type GmailSearchResult = { messages: Array<Record<string, string>> }
export type GmailGetMessageResult = Record<string, string>
export type GmailCreateDraftResult = { draftId: string }
export type GmailSendResult = { messageId: string }

export type FileReadArgs = { path: string; offset?: number; limit?: number }
export type FileWriteArgs = { path: string; content: string }
export type FileEditArgs = { path: string; old_string: string; new_string: string; replace_all?: boolean }
export type FileListArgs = { path?: string; recursive?: boolean }
export type FileGlobArgs = { pattern: string }
export type FileSearchArgs = { pattern: string; path?: string; glob?: string; ignore_case?: boolean; max_results?: number }
export type FileDeleteArgs = { path: string }
export type XlsxReadSheetArgs = { path: string; sheet?: string; max_rows?: number }
export type XlsxWriteCellsArgs = {
  path: string
  sheet?: string
  changes: XlsxCellChange[]
}
export type XlsxFormatRangeArgs = {
  path: string
  sheet?: string
  range: string
  style: CellStyle
}
export type XlsxLayoutArgs = {
  path: string
  sheet?: string
  mergeCells?: string[]
  columnWidths?: Array<{ column: string; width: number }>
  rowHeights?: Array<{ row: number; height: number }>
  freeze?: { rows?: number; columns?: number }
  autoFilter?: string
}
export type XlsxCreateArgs = {
  path: string
  sheets: XlsxSheetSpec[]
}
export type XlsxAppendRowsArgs = { path: string; sheet?: string; rows: XlsxRow[] }
export type DocxReadArgs = { path: string }
export type PdfReadArgs = { path: string; page_range?: string }
export type PdfCreateArgs = {
  path: string
  source_xlsx?: string
  sheet?: string
  title?: string
  headers?: string[]
  rows?: Array<Array<string | number | boolean | null>>
}

type ToolInvokeBase = {
  agentId: string
  agentVersion: number
  ticketId?: string
  conversationId?: string
  actingUserId?: string
}

export type ToolBrokerInvokeInput =
  | (ToolInvokeBase & { tool: 'kb_search'; args: KbSearchArgs })
  | (ToolInvokeBase & { tool: 'board_write'; args: BoardWriteArgs })
  | (ToolInvokeBase & { tool: 'ticket_create'; args: TicketCreateArgs })
  | (ToolInvokeBase & { tool: 'agent_ask'; args: AgentAskArgs })
  | (ToolInvokeBase & { tool: 'agent_resolve'; args: AgentResolveArgs })
  | (ToolInvokeBase & { tool: 'agent_catalog'; args: AgentCatalogArgs })
  | (ToolInvokeBase & { tool: 'gmail_search'; args: GmailSearchArgs })
  | (ToolInvokeBase & { tool: 'gmail_get_message'; args: GmailGetMessageArgs })
  | (ToolInvokeBase & { tool: 'gmail_create_draft'; args: GmailCreateDraftArgs })
  | (ToolInvokeBase & { tool: 'gmail_send'; args: GmailSendArgs })
  | (ToolInvokeBase & { tool: 'http_api_get'; args: HttpApiGetArgs })
  | (ToolInvokeBase & { tool: 'http_api_request'; args: HttpApiRequestArgs })
  | (ToolInvokeBase & { tool: 'file_read'; args: FileReadArgs })
  | (ToolInvokeBase & { tool: 'file_write'; args: FileWriteArgs })
  | (ToolInvokeBase & { tool: 'file_edit'; args: FileEditArgs })
  | (ToolInvokeBase & { tool: 'file_list'; args: FileListArgs })
  | (ToolInvokeBase & { tool: 'file_glob'; args: FileGlobArgs })
  | (ToolInvokeBase & { tool: 'file_search'; args: FileSearchArgs })
  | (ToolInvokeBase & { tool: 'file_delete'; args: FileDeleteArgs })
  | (ToolInvokeBase & { tool: 'xlsx_read_sheet'; args: XlsxReadSheetArgs })
  | (ToolInvokeBase & { tool: 'xlsx_write_cells'; args: XlsxWriteCellsArgs })
  | (ToolInvokeBase & { tool: 'xlsx_format_range'; args: XlsxFormatRangeArgs })
  | (ToolInvokeBase & { tool: 'xlsx_layout'; args: XlsxLayoutArgs })
  | (ToolInvokeBase & { tool: 'xlsx_create'; args: XlsxCreateArgs })
  | (ToolInvokeBase & { tool: 'xlsx_append_rows'; args: XlsxAppendRowsArgs })
  | (ToolInvokeBase & { tool: 'docx_read'; args: DocxReadArgs })
  | (ToolInvokeBase & { tool: 'pdf_read'; args: PdfReadArgs })
  | (ToolInvokeBase & { tool: 'pdf_create'; args: PdfCreateArgs })

export type ToolBrokerInvokeResult =
  | {
      denied: true
      reason: string
      latencyMs: number
    }
  | {
      denied: false
      result:
        | KbSearchResult
        | BoardWriteResult
        | TicketCreateResult
        | AgentAskResult
        | AgentResolveResult
        | AgentCatalogResult
        | GmailSearchResult
        | GmailGetMessageResult
        | GmailCreateDraftResult
        | GmailSendResult
        | HttpApiCallResult
        | FileReadResult
        | FileWriteResult
        | FileEditResult
        | FileListResult
        | FileGlobResult
        | FileSearchResult
        | FileDeleteResult
        | XlsxReadSheetResult
        | XlsxWriteCellsResult
        | XlsxAppendRowsResult
        | XlsxFormatRangeResult
        | XlsxLayoutResult
        | XlsxCreateResult
        | DocxReadResult
        | PdfReadResult
      resultMeta: Record<string, unknown>
      latencyMs: number
    }

type ToolName = ToolBrokerInvokeInput['tool']

type AuthorizationResult =
  | { allowed: true; connector: Connector; grant?: ConnectorGrant; actingUserId?: string }
  | { allowed: false; reason: string; connector?: Connector }

const TOOL_REQUIREMENTS: Record<
  ToolName,
  { connectorType: ConnectorType; accessMode: ConnectorAccessMode }
> = {
  kb_search: { connectorType: 'knowledge_base', accessMode: 'read' },
  board_write: { connectorType: 'board', accessMode: 'write' },
  ticket_create: { connectorType: 'board', accessMode: 'write' },
  agent_ask: { connectorType: 'board', accessMode: 'write' },
  agent_resolve: { connectorType: 'board', accessMode: 'read' },
  agent_catalog: { connectorType: 'board', accessMode: 'read' },
  gmail_search: { connectorType: 'gmail', accessMode: 'read' },
  gmail_get_message: { connectorType: 'gmail', accessMode: 'read' },
  gmail_create_draft: { connectorType: 'gmail', accessMode: 'write' },
  gmail_send: { connectorType: 'gmail', accessMode: 'write' },
  http_api_get: { connectorType: 'http_api', accessMode: 'read' },
  http_api_request: { connectorType: 'http_api', accessMode: 'write' },
  file_read: { connectorType: 'workspace', accessMode: 'read' },
  file_write: { connectorType: 'workspace', accessMode: 'write' },
  file_edit: { connectorType: 'workspace', accessMode: 'write' },
  file_list: { connectorType: 'workspace', accessMode: 'read' },
  file_glob: { connectorType: 'workspace', accessMode: 'read' },
  file_search: { connectorType: 'workspace', accessMode: 'read' },
  file_delete: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_read_sheet: { connectorType: 'workspace', accessMode: 'read' },
  xlsx_write_cells: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_format_range: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_layout: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_create: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_append_rows: { connectorType: 'workspace', accessMode: 'write' },
  docx_read: { connectorType: 'workspace', accessMode: 'read' },
  pdf_read: { connectorType: 'workspace', accessMode: 'read' },
  pdf_create: { connectorType: 'workspace', accessMode: 'write' },
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
}

// Magyar ragoz\u00e1s \u00e1thidal\u00e1sa: a tokeneket egy r\u00f6vid sz\u00f3t\u0151re v\u00e1gjuk, \u00edgy a
// k\u00e9rd\u00e9sbeli ragozott alak (pl. "gatewayeken", "m\u0171veleteinek") egyezik a
// dokumentumbeli alapalakkal ("gateway", "m\u0171velet"). Nyers r\u00e9szstring helyett
// prefix-bucket egyez\u00e9st haszn\u00e1lunk, ami a recallt jav\u00edtja keyword keres\u00e9sn\u00e9l.
const STEM_LENGTH = 4

function stemToken(token: string): string {
  return token.length <= STEM_LENGTH ? token : token.slice(0, STEM_LENGTH)
}

function queryTermStems(query: string): string[] {
  return [
    ...new Set(
      normalizeText(query)
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3)
        .map(stemToken),
    ),
  ]
}

function stemsFromText(text: string): string[] {
  return [
    ...new Set(
      normalizeText(text)
        .split(/\s+/)
        .filter(Boolean)
        .filter((term) => term.length >= 3)
        .map(stemToken),
    ),
  ]
}

function filenameSearchText(filename: string): string {
  return filename.replace(/[._-]+/g, ' ')
}

function documentSearchCorpus(filename: string, extractedText: string | null): string {
  const header = filenameSearchText(filename)
  const body = extractedText?.trim() ?? ''
  return body ? `${header}\n\n${body}` : header
}

function snippet(value: string): string {
  return value.length > 2000 ? `${value.slice(0, 1997)}...` : value
}

function argsMeta(input: ToolBrokerInvokeInput): Record<string, unknown> {
  const base = {
    ticketId: input.ticketId ?? null,
    conversationId: input.conversationId ?? null,
    actingUserId: input.actingUserId ?? null,
  }

  if (input.tool === 'kb_search') {
    return { ...base, queryLength: input.args.query.length, k: input.args.k ?? 5 }
  }

  if (input.tool === 'ticket_create') {
    return {
      ...base,
      titleLength: input.args.title.length,
      assigneeType: input.args.assigneeType,
      assigneeId: input.args.assigneeId ?? null,
      parentTicketId: input.ticketId ?? null,
      payloadKeys: Object.keys(input.args.payload).sort(),
    }
  }

  if (input.tool === 'agent_ask') {
    return {
      ...base,
      targetAgentId: input.args.targetAgentId,
      questionLength: input.args.question.length,
      parentTicketId: input.ticketId ?? null,
      hasContext: Boolean(input.args.context && Object.keys(input.args.context).length > 0),
    }
  }

  if (input.tool === 'agent_resolve') {
    return {
      ...base,
      queryLength: input.args.query.length,
      limit: input.args.limit ?? 5,
    }
  }

  if (input.tool === 'agent_catalog') {
    return {
      ...base,
      queryLength: input.args.query?.length ?? 0,
      agentId: input.args.agentId ?? null,
      limit: input.args.limit ?? null,
    }
  }

  if (input.tool === 'gmail_search') {
    return { ...base, queryLength: input.args.query.length, maxResults: input.args.maxResults ?? 10 }
  }

  if (input.tool === 'gmail_get_message') {
    return { ...base, messageId: input.args.id }
  }

  if (input.tool === 'gmail_create_draft') {
    return {
      ...base,
      toLength: input.args.to.length,
      subjectLength: input.args.subject.length,
      bodyLength: input.args.body.length,
      hasThreadId: Boolean(input.args.threadId),
    }
  }

  if (input.tool === 'gmail_send') {
    return {
      ...base,
      hasDraftId: Boolean(input.args.draftId),
      approvalTicketId: input.args.approvalTicketId ?? input.ticketId ?? null,
    }
  }

  if (input.tool === 'http_api_get') {
    return { ...base, method: 'GET', path: input.args.path, queryKeys: Object.keys(input.args.query ?? {}).sort() }
  }

  if (input.tool === 'http_api_request') {
    return {
      ...base,
      method: input.args.method,
      path: input.args.path,
      queryKeys: Object.keys(input.args.query ?? {}).sort(),
      hasBody: input.args.body !== undefined,
    }
  }

  if (input.tool === 'file_read') return { ...base, path: input.args.path, offset: input.args.offset ?? 1, limit: input.args.limit ?? 2000 }
  if (input.tool === 'file_write') return { ...base, path: input.args.path, contentLength: input.args.content.length }
  if (input.tool === 'file_edit') return { ...base, path: input.args.path, oldStringLength: input.args.old_string.length, replaceAll: input.args.replace_all ?? false }
  if (input.tool === 'file_list') return { ...base, path: input.args.path ?? '', recursive: input.args.recursive ?? false }
  if (input.tool === 'file_glob') return { ...base, pattern: input.args.pattern }
  if (input.tool === 'file_search') return { ...base, pattern: input.args.pattern, path: input.args.path ?? '', glob: input.args.glob ?? null, maxResults: input.args.max_results ?? 100 }
  if (input.tool === 'file_delete') return { ...base, path: input.args.path }
  if (input.tool === 'xlsx_read_sheet') return { ...base, path: input.args.path, sheet: input.args.sheet ?? null, maxRows: input.args.max_rows ?? 500 }
  if (input.tool === 'xlsx_write_cells') return { ...base, path: input.args.path, sheet: input.args.sheet ?? null, cellCount: input.args.changes.length }
  if (input.tool === 'xlsx_format_range') return { ...base, path: input.args.path, sheet: input.args.sheet ?? null, range: input.args.range }
  if (input.tool === 'xlsx_layout') {
    return {
      ...base,
      path: input.args.path,
      sheet: input.args.sheet ?? null,
      mergeCount: input.args.mergeCells?.length ?? 0,
      columnWidthCount: input.args.columnWidths?.length ?? 0,
      rowHeightCount: input.args.rowHeights?.length ?? 0,
      freeze: Boolean(input.args.freeze),
      autoFilter: Boolean(input.args.autoFilter),
    }
  }
  if (input.tool === 'xlsx_create') return { ...base, path: input.args.path, sheetCount: input.args.sheets.length }
  if (input.tool === 'xlsx_append_rows') return { ...base, path: input.args.path, sheet: input.args.sheet ?? null, rowCount: input.args.rows.length }
  if (input.tool === 'docx_read') return { ...base, path: input.args.path }
  if (input.tool === 'pdf_read') return { ...base, path: input.args.path, pageRange: input.args.page_range ?? null }
  if (input.tool === 'pdf_create') return { ...base, path: input.args.path, sourceXlsx: input.args.source_xlsx ?? null, rowCount: input.args.rows?.length ?? null }

  return {
    ...base,
    ticketId: input.args.ticketId,
    requestedState: input.args.patch.state ?? null,
    payloadKeys: input.args.patch.payload ? Object.keys(input.args.patch.payload).sort() : [],
  }
}

function resultMeta(
  result:
    | KbSearchResult
    | BoardWriteResult
    | TicketCreateResult
    | AgentAskResult
    | AgentResolveResult
    | AgentCatalogResult
    | GmailSearchResult
    | GmailGetMessageResult
    | GmailCreateDraftResult
    | GmailSendResult
    | HttpApiCallResult
    | FileReadResult
    | FileWriteResult
    | FileEditResult
    | FileListResult
    | FileGlobResult
    | FileSearchResult
    | FileDeleteResult
    | XlsxReadSheetResult
    | XlsxWriteCellsResult
    | XlsxAppendRowsResult
    | XlsxFormatRangeResult
    | XlsxLayoutResult
    | XlsxCreateResult
    | DocxReadResult
    | PdfReadResult,
): Record<string, unknown> {
  if ('status' in result && 'ok' in result && 'body' in result) {
    return { status: result.status, ok: result.ok }
  }

  if ('hits' in result && Array.isArray(result.hits)) {
    return {
      hitCount: result.hits.length,
      memoryVersions: [...new Set(result.hits.map((hit) => hit.memoryVersion))],
    }
  }

  if ('messages' in result && Array.isArray(result.messages)) {
    return { messageCount: result.messages.length }
  }

  if ('agents' in result && Array.isArray(result.agents)) {
    const first = result.agents[0] as { agentId?: string; score?: number } | undefined
    return {
      matchCount: result.agents.length,
      topAgentId: first?.agentId ?? null,
      topScore: first && 'score' in first ? first.score : undefined,
    }
  }

  if ('draftId' in result && typeof result.draftId === 'string') {
    return { draftId: result.draftId }
  }

  if ('messageId' in result && typeof result.messageId === 'string' && !('ticketId' in result)) {
    return { messageId: result.messageId }
  }

  if ('id' in result && 'body' in result) {
    return { messageId: String(result.id) }
  }

  if ('ok' in result && 'ticketId' in result && 'state' in result) {
    const ask = result as AgentAskResult
    return {
      ok: ask.ok,
      ticketId: ask.ticketId,
      state: ask.state,
      assigneeType: 'assigneeType' in result ? result.assigneeType : undefined,
      assigneeId: 'assigneeId' in result ? result.assigneeId : undefined,
      targetAgentId: ask.targetAgentId,
      requesterAgentId: ask.requesterAgentId,
      completed: ask.completed ?? false,
      hasAnswer: typeof ask.answer === 'string' && ask.answer.length > 0,
    }
  }

  if ('totalLines' in result) return { path: result.path, totalLines: result.totalLines }
  if ('bytesWritten' in result) return { path: result.path, bytesWritten: result.bytesWritten }
  if ('replacements' in result) return { path: result.path, replacements: result.replacements }
  if ('entries' in result) return { path: result.path, count: result.entries.length }
  if ('paths' in result) return { count: result.paths.length }
  if ('matches' in result) return { count: result.matches.length, truncated: result.truncated }
  if ('deleted' in result) return { path: result.path, deleted: result.deleted }
  if ('rowCount' in result && 'headers' in result) return { sheet: result.sheet, rowCount: result.rowCount, headerCount: result.headers.length }
  if ('cellsUpdated' in result) return { path: result.path, cellsUpdated: result.cellsUpdated }
  if ('rowsAppended' in result) return { path: result.path, rowsAppended: result.rowsAppended }
  if ('range' in result) return { path: result.path, range: result.range }
  if ('operations' in result) return { path: result.path, operations: result.operations }
  if ('sheets' in result) return { path: result.path, sheets: result.sheets }
  if ('numPages' in result) return { numPages: result.numPages, pagesRead: result.pagesRead, textLength: result.text.length }
  if ('text' in result && 'messages' in result) return { textLength: result.text.length, messages: result.messages.length }

  return {}
}

async function systemUserId(): Promise<string> {
  const user = await prisma.user.findFirst({
    where: { role: 'admin' },
    orderBy: { createdAt: 'asc' },
  })
  if (!user) throw new Error('No system user configured')
  return user.id
}

export interface Authorizer {
  authorize(input: {
    agentId: string
    tool: ToolName
    args?: Record<string, unknown>
    actingUserId?: string | null
    tenantId?: string | null
  }): Promise<AuthorizationResult>
}

const ORCHESTRATOR_DELEGATION_TOOLS: ToolName[] = [
  'ticket_create',
  'agent_ask',
  'agent_resolve',
  'agent_catalog',
]

/**
 * Az acting-user státusz-feloldása. Cserepont a determinisztikus teszteléshez
 * (G5 — suspended user), alapból a Postgres `users` táblát kérdezi.
 */
export type ActingUserLookup = (
  userId: string,
) => Promise<{ status: UserStatus } | null>

const prismaActingUserLookup: ActingUserLookup = async (userId) =>
  prisma.user.findUnique({ where: { id: userId }, select: { status: true } })

export class AllowlistAuthorizer implements Authorizer {
  constructor(
    private tools: ToolBrokerRepository,
    private agents: AgentRepository,
    private grants: ConnectorGrantRepository,
    private lookupActingUser: ActingUserLookup = prismaActingUserLookup,
  ) {}

  async authorize(input: {
    agentId: string
    tool: ToolName
    args?: Record<string, unknown>
    actingUserId?: string | null
    tenantId?: string | null
  }): Promise<AuthorizationResult> {
    const agent = await this.agents.findById(input.agentId)
    if (
      agent?.role === 'orchestrator' &&
      !ORCHESTRATOR_DELEGATION_TOOLS.includes(input.tool)
    ) {
      return { allowed: false, reason: 'orchestrator_tool_less' }
    }

    const capability = await this.tools.findCapability(input.agentId, input.tool)
    if (!capability?.allowed) {
      return { allowed: false, reason: 'capability_not_allowed' }
    }

    const requirement = TOOL_REQUIREMENTS[input.tool]
    const connector = await this.tools.findConnectorForAgent(
      input.agentId,
      requirement.connectorType,
      requirement.accessMode,
    )
    if (!connector) {
      return {
        allowed: false,
        reason: `missing_${requirement.connectorType}_connector_${requirement.accessMode}`,
      }
    }

    if (connector.authMode === 'user_delegated') {
      if (!input.actingUserId) {
        return { allowed: false, reason: 'acting_user_required', connector }
      }

      const user = await this.lookupActingUser(input.actingUserId)
      if (!user || user.status === 'suspended') {
        return { allowed: false, reason: 'acting_user_suspended', connector }
      }

      const grant = await this.grants.findActiveGrant({
        tenantId: input.tenantId ?? connector.tenantId ?? null,
        connectorId: connector.id,
        userId: input.actingUserId,
      })
      if (!grant) {
        return { allowed: false, reason: 'connector_grant_missing', connector }
      }

      if (
        connector.type === 'gmail' &&
        !gmailToolAllowedByScopes({
          tool: input.tool as Extract<ToolName, `gmail_${string}`>,
          args: input.args,
          scopes: grant.scopes,
        })
      ) {
        return { allowed: false, reason: 'gmail_scope_not_granted', connector }
      }

      return { allowed: true, connector, grant, actingUserId: input.actingUserId }
    }

    return { allowed: true, connector }
  }
}

export class ToolBrokerService {
  private delegationProcessor: DelegationProcessor | null = null

  constructor(
    private agents: AgentRepository,
    private tickets: TicketRepository,
    private tools: ToolBrokerRepository,
    private audit: AuditRepository,
    private ticketService: TicketService,
    private authorizer: Authorizer,
    private grantService: ConnectorGrantService,
    private fileEditor: FileEditorService,
  ) {}

  /** Chat agent_ask: szinkron feldolgozás (pl. WikiAgentRuntime.processTicket). */
  setDelegationProcessor(processor: DelegationProcessor | null): void {
    this.delegationProcessor = processor
  }

  async invoke(input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> {
    const startedAt = Date.now()
    const ticketId = input.tool === 'board_write' ? input.args.ticketId : input.ticketId ?? null
    const actingUserId = await this.resolveActingUserId(input)
    const actingTenantId = actingUserId ? await this.resolveActingTenantId(actingUserId) : null

    const authorization = await this.authorizer.authorize({
      agentId: input.agentId,
      tool: input.tool,
      args: input.args as Record<string, unknown>,
      actingUserId,
      tenantId: actingTenantId,
    })

    if (!authorization.allowed) {
      return this.recordDenied(input, ticketId, authorization.connector?.id ?? null, authorization.reason, startedAt, actingUserId, null)
    }

    if (input.tool === 'gmail_send') {
      const approved = await this.checkGmailSendApproval(input, input.args)
      if (!approved) {
        return this.recordDenied(
          input,
          ticketId,
          authorization.connector.id,
          'human_approval_required',
          startedAt,
          actingUserId,
          authorization.grant?.id ?? null,
        )
      }
    }

    if (input.tool === 'board_write') {
      const ticket = await this.tickets.findById(input.args.ticketId)
      if (!ticket) {
        return this.recordDenied(input, ticketId, authorization.connector.id, 'ticket_not_found', startedAt, actingUserId, authorization.grant?.id ?? null)
      }
      if (ticket.agentId !== input.agentId) {
        return this.recordDenied(
          input,
          ticketId,
          authorization.connector.id,
          'ticket_not_accessible_for_agent',
          startedAt,
          actingUserId,
          authorization.grant?.id ?? null,
        )
      }
    }

    try {
      const result = await this.executeTool(input, authorization, actingTenantId)
      const latencyMs = Date.now() - startedAt
      const meta = resultMeta(result)

      await this.recordCall({
        input,
        ticketId,
        connectorId: authorization.connector.id,
        status: 'ok',
        latencyMs,
        policyDecision: 'allowed',
        resultMeta: meta,
        actingUserId,
        grantId: authorization.grant?.id ?? null,
      })

      return {
        denied: false,
        result,
        resultMeta: meta,
        latencyMs,
      }
    } catch (e) {
      const latencyMs = Date.now() - startedAt
      const message = e instanceof Error ? e.message : 'tool_call_failed'
      if (
        e instanceof GmailApiAuthError &&
        authorization.connector.authMode === 'user_delegated' &&
        authorization.grant &&
        actingUserId
      ) {
        await this.grantService.markGrantExpired({
          grantId: authorization.grant.id,
          connectorId: authorization.connector.id,
          actingUserId,
          metadata: { reason: 'provider_auth_error', status: e.status } as Prisma.JsonValue,
        })
        return this.recordDenied(
          input,
          ticketId,
          authorization.connector.id,
          'connector_grant_expired',
          startedAt,
          actingUserId,
          authorization.grant.id,
        )
      }

      await this.recordCall({
        input,
        ticketId,
        connectorId: authorization.connector.id,
        status: 'error',
        latencyMs,
        policyDecision: 'error',
        resultMeta: { error: message },
        actingUserId,
        grantId: authorization.grant?.id ?? null,
      })
      throw e
    }
  }

  private async executeTool(
    input: ToolBrokerInvokeInput,
    authorization: Extract<AuthorizationResult, { allowed: true }>,
    actingTenantId: string | null,
  ) {
    if (input.tool === 'kb_search') {
      return this.kbSearch(input.agentId, input.args, authorization.connector)
    }
    if (input.tool === 'board_write') return this.boardWrite(input)
    if (input.tool === 'ticket_create') return this.ticketCreate(input)
    if (input.tool === 'agent_ask') return this.agentAsk(input)
    if (input.tool === 'agent_resolve') return this.agentResolve(input.args)
    if (input.tool === 'agent_catalog') return this.agentCatalog(input.args)

    if (input.tool === 'http_api_get' || input.tool === 'http_api_request') {
      return this.executeHttpApiTool(input, authorization.connector)
    }

    if (input.tool.startsWith('file_') || input.tool.startsWith('xlsx_') || input.tool.startsWith('pdf_') || input.tool === 'docx_read') {
      return this.executeFileTool(input, authorization.connector, actingTenantId)
    }

    const accessToken = await this.resolveDelegatedAccessToken(input, authorization)
    const gmail = new GmailApiClient(accessToken)

    if (input.tool === 'gmail_search') {
      const res = await gmail.search(input.args)
      return { messages: res.messages }
    }
    if (input.tool === 'gmail_get_message') {
      return gmail.getMessage(input.args)
    }
    if (input.tool === 'gmail_create_draft') {
      return gmail.createDraft(input.args)
    }
    if (input.tool === 'gmail_send') {
      return gmail.send(input.args)
    }
    throw new Error(`Unknown delegated tool: ${input.tool}`)
  }

  private async executeHttpApiTool(
    input: Extract<ToolBrokerInvokeInput, { tool: 'http_api_get' | 'http_api_request' }>,
    connector: Connector,
  ): Promise<HttpApiCallResult> {
    const config = parseHttpApiConfig(connector.config)
    const apiKey = await resolveConnectorApiKey(connector.secretAlias)
    const client = new HttpApiClient(config, apiKey)

    if (input.tool === 'http_api_get') {
      return client.request({ method: 'GET', path: input.args.path, query: input.args.query })
    }
    return client.request({
      method: input.args.method,
      path: input.args.path,
      query: input.args.query,
      body: input.args.body,
    })
  }

  private async executeFileTool(
    input: ToolBrokerInvokeInput,
    connector: Connector,
    actingTenantId: string | null,
  ) {
    const workspaceId = input.ticketId ?? input.conversationId
    if (!workspaceId) throw new Error('file tools require a ticketId or conversationId')
    // A munkaterület tenant-kulcsa a cselekvő felhasználó tenantja kell legyen,
    // hogy egyezzen a feltöltési úttal (route + chat-bridge user.tenantId-t
    // használ). A globális workspace connector tenantId-je null, ezért korábban
    // a feltöltött fájlokat más kulcson kereste az agent. Fallback a connector
    // tenantra, majd 'global'-ra.
    const tenantId = actingTenantId ?? connector.tenantId ?? 'global'

    try {
      if (input.tool === 'file_read') return this.fileEditor.readFile(tenantId, workspaceId, input.args)
      if (input.tool === 'file_write') return this.fileEditor.writeFile(tenantId, workspaceId, input.args)
      if (input.tool === 'file_edit') return this.fileEditor.editFile(tenantId, workspaceId, input.args)
      if (input.tool === 'file_list') return this.fileEditor.listFiles(tenantId, workspaceId, input.args)
      if (input.tool === 'file_glob') return this.fileEditor.globFiles(tenantId, workspaceId, input.args)
      if (input.tool === 'file_search') return this.fileEditor.searchFiles(tenantId, workspaceId, input.args)
      if (input.tool === 'file_delete') return this.fileEditor.deleteFile(tenantId, workspaceId, input.args)
      if (input.tool === 'xlsx_read_sheet') return this.fileEditor.xlsxReadSheet(tenantId, workspaceId, input.args)
      if (input.tool === 'xlsx_write_cells') return this.fileEditor.xlsxWriteCells(tenantId, workspaceId, input.args)
      if (input.tool === 'xlsx_format_range') return this.fileEditor.xlsxFormatRange(tenantId, workspaceId, input.args)
      if (input.tool === 'xlsx_layout') return this.fileEditor.xlsxLayout(tenantId, workspaceId, input.args)
      if (input.tool === 'xlsx_create') return this.fileEditor.xlsxCreate(tenantId, workspaceId, input.args)
      if (input.tool === 'xlsx_append_rows') return this.fileEditor.xlsxAppendRows(tenantId, workspaceId, input.args)
      if (input.tool === 'docx_read') return this.fileEditor.docxRead(tenantId, workspaceId, input.args)
      if (input.tool === 'pdf_read') return this.fileEditor.pdfRead(tenantId, workspaceId, input.args)
      if (input.tool === 'pdf_create') return this.fileEditor.pdfCreate(tenantId, workspaceId, input.args)
    } catch (e) {
      if (e instanceof FileEditorError) {
        throw new Error(`${e.code}: ${e.message}`)
      }
      throw e
    }
    throw new Error(`Unknown file tool: ${input.tool}`)
  }

  private async resolveDelegatedAccessToken(
    input: ToolBrokerInvokeInput,
    authorization: Extract<AuthorizationResult, { allowed: true }>,
  ): Promise<string> {
    if (authorization.connector.authMode !== 'user_delegated' || !authorization.grant) {
      throw new Error('delegated_access_token_requires_grant')
    }
    const actingUserId = authorization.actingUserId ?? (await this.resolveActingUserId(input))
    if (!actingUserId) throw new Error('acting_user_required')
    return this.grantService.resolveAccessToken({
      connector: authorization.connector,
      grantId: authorization.grant.id,
      tokenRef: authorization.grant.tokenRef,
      actingUserId,
    })
  }

  private async resolveActingUserId(input: ToolBrokerInvokeInput): Promise<string | null> {
    if (input.ticketId) {
      const ticket = await this.tickets.findById(input.ticketId)
      if (ticket) {
        const payload = isRecord(ticket.payload) ? ticket.payload : null
        if (isRunAsAuthorized(payload)) {
          return readRunAsUserId(payload)
        }
        return null
      }
    }

    if (input.conversationId) {
      const conversation = await prisma.conversation.findUnique({
        where: { id: input.conversationId },
      })
      if (conversation) return conversation.createdById
    }

    if (input.actingUserId) return input.actingUserId

    return null
  }

  private async resolveActingTenantId(actingUserId: string): Promise<string | null> {
    const user = await prisma.user.findUnique({
      where: { id: actingUserId },
      select: { tenantId: true },
    })
    return user?.tenantId ?? null
  }

  private async checkGmailSendApproval(
    input: ToolBrokerInvokeInput,
    args: GmailSendArgs,
  ): Promise<boolean> {
    const approvalTicketId = args.approvalTicketId ?? input.ticketId
    if (!approvalTicketId) return false
    const ticket = await this.tickets.findById(approvalTicketId)
    if (!ticket || ticket.state !== 'approved') return false
    const payload = isRecord(ticket.payload) ? ticket.payload : {}
    const approvedRef = payload.gmailSendApproved
    if (typeof approvedRef !== 'string' || !approvedRef) return false
    return approvedRef === (args.draftId ?? args.to ?? '')
  }

  private async kbSearch(
    agentId: string,
    args: KbSearchArgs,
    connector: Connector,
  ): Promise<KbSearchResult> {
    const detail = await this.agents.findByIdWithDetails(agentId)
    if (!detail) throw new Error('Agent not found')

    const termStems = queryTermStems(args.query)

    const k = args.k ?? 5

    type ScoredChunk = { chunk: string; score: number; docId: string; sourceRef: string; memoryVersion: number | null }

    function scoreChunks(
      text: string,
      docId: string,
      sourceRef: string,
      memoryVersion: number | null,
      extraStems: Iterable<string> = [],
    ): ScoredChunk[] {
      const extraStemSet = new Set(extraStems)
      return text
        .split(/\n{2,}|\n(?=-\s+)/)
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => {
          const chunkStems = new Set(
            normalizeText(chunk)
              .split(/\s+/)
              .filter(Boolean)
              .map(stemToken),
          )
          for (const stem of extraStemSet) chunkStems.add(stem)
          const score = termStems.reduce((sum, stem) => sum + (chunkStems.has(stem) ? 1 : 0), 0)
          return { chunk, score, docId, sourceRef, memoryVersion }
        })
        .filter((item) => item.score > 0)
    }

    const memoryChunks = scoreChunks(
      detail.memoryContent ?? '',
      `memory:${detail.agent.memoryId}`,
      `memory:${detail.agent.memoryId}:v${detail.memoryVersion ?? 'unknown'}`,
      detail.memoryVersion,
    )

    // §4.9.1: egy agent több (akár megosztott) KB connectorhoz is köthető —
    // a retrieval az agenthez kötött ÖSSZES knowledge_base connector dokumentumait
    // uniózza, nem csak az authorizált egyét.
    const linkedKbConnectorIds = (await this.tools.findConnectorsForAgent(agentId))
      .filter((link) => link.connector.type === 'knowledge_base')
      .map((link) => link.connector.id)
    const connectorIds = linkedKbConnectorIds.length > 0 ? linkedKbConnectorIds : [connector.id]
    const documentLists = await Promise.all(
      connectorIds.map((id) => this.tools.findDocumentsForConnector(id)),
    )
    const flatDocs = documentLists.flat()
    const docChunks: ScoredChunk[] = flatDocs.flatMap((doc) =>
      scoreChunks(
        documentSearchCorpus(doc.filename, doc.extractedText),
        `doc:${doc.id}`,
        `doc:${doc.id}:${doc.filename}`,
        null,
        stemsFromText(filenameSearchText(doc.filename)),
      ),
    )

    let all = [...memoryChunks, ...docChunks]
      .sort((a, b) => b.score - a.score)
      .slice(0, k)

    // Ha nincs egyező chunk, próbáljuk a teljes korpuszban (fájlnév + törzs) —
    // pl. fájlnév-alapú kérdés vagy egyetlen kulcsszó (posnavigátor) a szövegben.
    if (all.length === 0 && flatDocs.length > 0) {
      const fallback = flatDocs
        .map((doc) => {
          const corpus = normalizeText(documentSearchCorpus(doc.filename, doc.extractedText))
          const filenameScore = stemsFromText(filenameSearchText(doc.filename)).filter((stem) =>
            termStems.includes(stem),
          ).length
          const contentScore = termStems.filter((stem) => corpus.includes(stem)).length
          return { doc, score: Math.max(filenameScore, contentScore) }
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)

      all = fallback.map(({ doc }) => {
        const body = doc.extractedText?.trim()
        const chunk = body
          ? body.split(/\n{2,}|\n(?=-\s+)/).map((part) => part.trim()).find(Boolean) ?? body
          : `[${doc.filename}]`
        return {
          chunk,
          score: 1,
          docId: `doc:${doc.id}`,
          sourceRef: `doc:${doc.id}:${doc.filename}`,
          memoryVersion: null,
        } satisfies ScoredChunk
      })
    }

    return {
      hits: all.map((item) => ({
        docId: item.docId,
        snippet: snippet(item.chunk),
        sourceRef: item.sourceRef,
        memoryVersion: item.memoryVersion,
      })),
    }
  }

  private async boardWrite(
    input: Extract<ToolBrokerInvokeInput, { tool: 'board_write' }>,
  ): Promise<BoardWriteResult> {
    const ticket = await this.tickets.findById(input.args.ticketId)
    if (!ticket) throw new Error('Ticket not found')

    const mergedPayload: Record<string, unknown> = isRecord(ticket.payload) ? { ...ticket.payload } : {}
    if (input.args.patch.payload) {
      Object.assign(mergedPayload, input.args.patch.payload)
    }

    if (
      shouldCompleteDelegation(mergedPayload, input.agentId, ticket.assigneeId, input.args.patch)
    ) {
      return await this.completeDelegationReturn(ticket, mergedPayload, input)
    }

    let current = ticket
    if (input.args.patch.payload) {
      current = await this.tickets.update(current.id, {
        payload: mergedPayload as Prisma.JsonValue,
      })
    }

    if (input.args.patch.state && input.args.patch.state !== current.state) {
      current = await this.ticketService.transition({
        ticketId: current.id,
        toState: input.args.patch.state,
        actor: { type: 'agent', agentId: input.agentId },
        agentVersion: input.agentVersion,
      })
    }

    return { ok: true, ticketId: current.id, state: current.state }
  }

  private async completeDelegationReturn(
    ticket: Ticket,
    mergedPayload: Record<string, unknown>,
    input: Extract<ToolBrokerInvokeInput, { tool: 'board_write' }>,
  ): Promise<BoardWriteResult> {
    const delegation = readDelegationPayload(mergedPayload)
    if (!delegation) throw new Error('Delegation payload missing')

    const requesterId = delegation.requesterAgentId
    const finalPayload: Record<string, unknown> = {
      ...mergedPayload,
      delegationReturned: true,
      answeredByAgentId: input.agentId,
      delegationCompletedAt: new Date().toISOString(),
    }

    if (ticket.lockToken) {
      await this.tickets.releaseDispatchLock(ticket.id, ticket.lockToken)
    }

    const fromState = ticket.state
    const updated = await this.tickets.update(ticket.id, {
      state: 'done',
      assigneeType: 'agent',
      assigneeId: requesterId,
      agentId: requesterId,
      payload: finalPayload as Prisma.JsonValue,
      lockToken: null,
      lockedAt: null,
    })

    await this.tickets.recordTransition({
      ticketId: ticket.id,
      fromState,
      toState: 'done',
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      note: `delegation completed; answer returned to requester ${requesterId}`,
    })

    await this.audit.append({
      actorType: 'agent',
      actorId: input.agentId,
      agentVersion: input.agentVersion,
      action: 'delegation.return',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: requesterId,
      outputRef: 'done',
      policyDecision: 'allowed',
      metadata: {
        answeredByAgentId: input.agentId,
        requesterAgentId: requesterId,
        parentTicketId: delegation.parentTicketId,
      } as Prisma.JsonValue,
    })

    if (delegation.parentTicketId) {
      await this.mergeDelegationIntoParent(
        delegation.parentTicketId,
        requesterId,
        ticket.id,
        finalPayload,
      )
    }

    return { ok: true, ticketId: updated.id, state: updated.state }
  }

  private async mergeDelegationIntoParent(
    parentTicketId: string,
    requesterId: string,
    childTicketId: string,
    childPayload: Record<string, unknown>,
  ) {
    const parent = await this.tickets.findById(parentTicketId)
    if (!parent) return

    const parentPayload = isRecord(parent.payload) ? parent.payload : {}
    const entry = {
      delegationTicketId: childTicketId,
      question: typeof childPayload.question === 'string' ? childPayload.question : '',
      answer: typeof childPayload.answer === 'string' ? childPayload.answer : null,
      answeredByAgentId: childPayload.answeredByAgentId,
      returnedAt: childPayload.delegationCompletedAt,
    }

    const delegatedAnswers: Prisma.JsonValue[] = Array.isArray(parentPayload.delegatedAnswers)
      ? [...(parentPayload.delegatedAnswers as Prisma.JsonValue[]), entry as Prisma.JsonValue]
      : [entry as Prisma.JsonValue]

    await this.tickets.update(parentTicketId, {
      payload: { ...parentPayload, delegatedAnswers } as Prisma.JsonValue,
      assigneeType: 'agent',
      assigneeId: requesterId,
      agentId: requesterId,
    })
  }

  private async ticketCreate(
    input: Extract<ToolBrokerInvokeInput, { tool: 'ticket_create' }>,
  ): Promise<TicketCreateResult> {
    const { args } = input

    // A modell néha nem-UUID értéket ad (pl. fájlnevet) UUID mezőkbe — ezt a
    // Prisma nyers „Error creating UUID" hibával dobná. Tisztán kezeljük.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (args.assigneeType === 'agent') {
      if (!args.assigneeId) throw new Error('assigneeId is required when assigneeType is agent')
      if (!UUID_RE.test(args.assigneeId)) {
        throw new Error(`assigneeId must be an agent UUID, got "${args.assigneeId}"`)
      }
      const assignee = await this.agents.findById(args.assigneeId)
      if (!assignee) throw new Error('Assignee agent not found')
    }
    const safeSourceDocumentId =
      args.sourceDocumentId && UUID_RE.test(args.sourceDocumentId) ? args.sourceDocumentId : null

    const workerAgentId = args.assigneeType === 'agent' ? args.assigneeId! : input.agentId
    const payload: Record<string, unknown> = {
      ...args.payload,
      source: 'agent_tool',
      createdByAgentId: input.agentId,
    }
    if (input.ticketId) payload.parentTicketId = input.ticketId
    if (input.conversationId) payload.conversationId = input.conversationId

    const parent = input.ticketId ? await this.tickets.findById(input.ticketId) : null
    if (parent) {
      const parentPayload = isRecord(parent?.payload) ? parent.payload : null
      if (isRunAsAuthorized(parentPayload)) {
        payload.runAsUserId = readRunAsUserId(parentPayload)
        payload[RUN_AS_AUTHORIZED_AT] = parentPayload![RUN_AS_AUTHORIZED_AT]
        payload[RUN_AS_AUTHORIZED_BY] = parentPayload![RUN_AS_AUTHORIZED_BY]
      }
    }

    const initialState: TicketState = args.assigneeType === 'agent' ? 'ready' : 'in_progress'

    let ticket = await this.tickets.create({
      tenantId: parent?.tenantId ?? null,
      type: 'interaction',
      title: args.title,
      state: initialState,
      assigneeType: args.assigneeType,
      assigneeId: args.assigneeType === 'agent' ? args.assigneeId! : null,
      agentId: workerAgentId,
      payload: payload as Prisma.JsonValue,
      sourceDocumentId: safeSourceDocumentId,
      executeAfter: null,
      dueBy: null,
      createdById: await systemUserId(),
    })

    if (args.assigneeType === 'human') {
      ticket = await this.ticketService.transition({
        ticketId: ticket.id,
        toState: 'awaiting_human',
        actor: { type: 'agent', agentId: input.agentId },
        agentVersion: input.agentVersion,
      })
    }

    return {
      ok: true,
      ticketId: ticket.id,
      state: ticket.state,
      assigneeType: args.assigneeType,
      assigneeId: ticket.assigneeId,
    }
  }

  private async agentAsk(
    input: Extract<ToolBrokerInvokeInput, { tool: 'agent_ask' }>,
  ): Promise<AgentAskResult> {
    const question = input.args.question.trim()
    if (!question) throw new Error('Question is required')

    if (input.args.targetAgentId === input.agentId) {
      throw new Error('Cannot delegate to the same agent — choose a different targetAgentId')
    }

    const target = await this.agents.findById(input.args.targetAgentId)
    if (!target) throw new Error('Target agent not found')
    if (target.role === 'orchestrator') {
      throw new Error('Target agent is orchestrator and cannot answer delegated tickets')
    }

    const payload: Record<string, unknown> = {
      delegation: true,
      requesterAgentId: input.agentId,
      question,
      source: 'agent_ask',
    }
    if (input.ticketId) payload.parentTicketId = input.ticketId
    if (input.conversationId) payload.conversationId = input.conversationId
    if (input.args.context && Object.keys(input.args.context).length > 0) {
      payload.context = input.args.context
    }

    const ticket = await this.tickets.create({
      tenantId: input.ticketId ? (await this.tickets.findById(input.ticketId))?.tenantId ?? null : null,
      type: 'interaction',
      title: `Delegálás: ${question.slice(0, 80)}`,
      state: 'ready',
      assigneeType: 'agent',
      assigneeId: input.args.targetAgentId,
      agentId: input.args.targetAgentId,
      payload: payload as Prisma.JsonValue,
      sourceDocumentId: null,
      executeAfter: null,
      dueBy: null,
      createdById: await systemUserId(),
    })

    const base: AgentAskResult = {
      ok: true,
      ticketId: ticket.id,
      state: ticket.state,
      targetAgentId: input.args.targetAgentId,
      requesterAgentId: input.agentId,
    }

    // Chat flow: szinkron delegálás — ne térjen vissza, amíg a célagent meg nem válaszolt.
    if (!this.delegationProcessor || !input.conversationId) {
      return base
    }

    try {
      await this.delegationProcessor({
        ticketId: ticket.id,
        targetAgentId: input.args.targetAgentId,
        requesterAgentId: input.agentId,
        actingUserId: input.actingUserId,
      })
    } catch (error) {
      return {
        ...base,
        completed: false,
        error: error instanceof Error ? error.message : 'delegation_failed',
      }
    }

    const finished = await this.tickets.findById(ticket.id)
    if (!finished) {
      return { ...base, completed: false, error: 'delegation_ticket_missing' }
    }

    const finishedPayload = isRecord(finished.payload) ? finished.payload : {}
    if (finishedPayload.delegationReturned !== true || typeof finishedPayload.answer !== 'string') {
      return {
        ...base,
        state: finished.state,
        completed: false,
        error: 'delegation_not_completed',
      }
    }

    return {
      ...base,
      state: finished.state,
      completed: true,
      answer: finishedPayload.answer,
      sources: finishedPayload.sources,
      rationale:
        typeof finishedPayload.rationale === 'string' ? finishedPayload.rationale : undefined,
      confidence:
        typeof finishedPayload.confidence === 'string' ? finishedPayload.confidence : undefined,
      answeredByAgentId:
        typeof finishedPayload.answeredByAgentId === 'string'
          ? finishedPayload.answeredByAgentId
          : input.args.targetAgentId,
    }
  }

  private async agentResolve(args: AgentResolveArgs): Promise<AgentResolveResult> {
    const query = normalizeText(args.query.trim())
    if (!query) throw new Error('Query is required')

    const limit = args.limit ?? 5
    const all = await this.agents.findMany()

    const scored = all
      .filter((agent) => agent.status === 'active')
      .map((agent) => {
        const persona = personaFor(agent.name)
        const score = scoreAgentForCatalogQuery(agent, args.query)
        return { agent, persona, score }
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return {
      agents: scored.map(({ agent, persona, score }) => ({
        agentId: agent.id,
        name: agent.name,
        nickname: persona.nickname,
        role: agent.role,
        trait: persona.trait,
        score,
      })),
    }
  }

  private async agentCatalog(args: AgentCatalogArgs): Promise<AgentCatalogResult> {
    const limitDefault = args.query?.trim() ? 5 : 25

    if (args.agentId) {
      const entry = await buildAgentCatalogEntry(args.agentId, this.agents, this.tools)
      return { agents: [entry] }
    }

    const all = await this.agents.findMany()
    let candidates = all.filter((agent) => agent.status === 'active')

    if (args.query?.trim()) {
      candidates = candidates
        .map((agent) => ({ agent, score: scoreAgentForCatalogQuery(agent, args.query!) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((row) => row.agent)
    }

    const limit = args.limit ?? limitDefault
    const selected = candidates.slice(0, limit)
    const agents = await Promise.all(
      selected.map((agent) => buildAgentCatalogEntry(agent.id, this.agents, this.tools)),
    )

    return { agents }
  }

  private async recordDenied(
    input: ToolBrokerInvokeInput,
    ticketId: string | null,
    connectorId: string | null,
    reason: string,
    startedAt: number,
    actingUserId: string | null = null,
    grantId: string | null = null,
  ): Promise<ToolBrokerInvokeResult> {
    const latencyMs = Date.now() - startedAt
    await this.recordCall({
      input,
      ticketId,
      connectorId,
      status: 'denied',
      latencyMs,
      policyDecision: reason,
      resultMeta: { denied: true, reason },
      actingUserId,
      grantId,
    })

    return { denied: true, reason, latencyMs }
  }

  private async recordCall(params: {
    input: ToolBrokerInvokeInput
    ticketId: string | null
    connectorId: string | null
    status: ToolCallStatus
    latencyMs: number
    policyDecision: string
    resultMeta: Record<string, unknown>
    actingUserId?: string | null
    grantId?: string | null
  }) {
    const sanitizedArgsMeta = {
      ...argsMeta(params.input),
      acting_user_id: params.actingUserId ?? params.input.actingUserId ?? null,
      grant_id: params.grantId ?? null,
    }
    const metadata = {
      tool: params.input.tool,
      status: params.status,
      argsMeta: sanitizedArgsMeta,
      resultMeta: params.resultMeta,
      acting_user_id: params.actingUserId ?? params.input.actingUserId ?? null,
      grant_id: params.grantId ?? null,
    }

    await this.tools.createToolCall({
      agentId: params.input.agentId,
      ticketId: params.ticketId,
      conversationId: params.input.conversationId ?? null,
      connectorId: params.connectorId,
      toolName: params.input.tool,
      status: params.status,
      argsMeta: sanitizedArgsMeta as Prisma.JsonValue,
      resultMeta: params.resultMeta as Prisma.JsonValue,
      latencyMs: params.latencyMs,
      policyDecision: params.policyDecision,
    })

    const targetType = params.ticketId ? 'ticket' : params.input.conversationId ? 'conversation' : 'tool'
    const targetId = params.ticketId ?? params.input.conversationId ?? params.connectorId

    await this.audit.append({
      actorType: 'agent',
      actorId: params.input.agentId,
      agentVersion: params.input.agentVersion,
      action: params.status === 'denied' ? 'tool.call.denied' : 'tool.call',
      targetType,
      targetId,
      modelUsed: null,
      inputRef: params.input.tool,
      outputRef: params.status,
      policyDecision: params.policyDecision,
      metadata: metadata as Prisma.JsonValue,
    })
  }
}
