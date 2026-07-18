/**
 * WP-8 — Tool Broker publikus típus-felület.
 *
 * A tool-args/eredmény típusok, az `invoke` union bemenete/kimenete és az
 * `AuthorizationResult` a broker-magból (`tool-broker-service.ts`) kiemelve, hogy
 * a mag a <500 soros keretre apadjon. A `tool-broker-service.ts` `export *`-gal
 * továbbra is re-exportálja ezeket, így a meglévő importok változatlanul működnek.
 */
import type {
  AssigneeType,
  Connector,
  ConnectorGrant,
  TicketState,
} from '@prisma/client'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type {
  FileReadResult,
  FileWriteResult,
  HtmlCreateResult,
  FileEditResult,
  FileListResult,
  FileGlobResult,
  FileSearchResult,
  FileDeleteResult,
  XlsxReadSheetResult,
  XlsxWriteCellsResult,
  XlsxAppendRowsResult,
  XlsxFormatRangeResult,
  XlsxLayoutResult,
  XlsxCreateResult,
  DocxReadResult,
  DocxCreateResult,
  PdfReadResult,
} from '@/domain/file-editor/file-editor-service'
import type {
  XlsxRow,
  XlsxCellChange,
  CellStyle,
  XlsxSheetSpec,
} from '@/domain/file-editor/adapters/xlsx-adapter'
import type { PptxSlideSpec } from '@/domain/file-editor/adapters/pptx-adapter'
import type { DocxBlockSpec } from '@/domain/file-editor/adapters/docx-adapter'
import type { WebSearchArgs, WebSearchResult } from '@/domain/web-search/web-search-types'
import type {
  WebResearchRequestArgs,
  WebResearchRequestResult,
} from '@/domain/web-research/web-research-types'

export type KbSearchArgs = {
  query: string
  k?: number
}

export type KbSearchHit = {
  docId: string
  snippet: string
  sourceRef: string
  memoryVersion: number | null
  // KB-v3 §9.1 — OKF chunk citation (opcionális; csak published OKF chunk-találatnál).
  path?: string
  title?: string
  score?: number
  source?: {
    documentId?: string
    filename?: string
    page?: number
    section?: string
    cell?: string
  }
}

export type KbSearchResult = {
  hits: KbSearchHit[]
}

// KB-v3 §9.2/§9.3 — OKF-navigáció (kb_list_index → kb_get_page). Elsődleges
// retrieval-út a runtime többkörös tool-loopján (D-I).
export type KbSource = {
  documentId?: string
  filename?: string
  page?: number
  section?: string
  cell?: string
}

export type KbListIndexArgs = {
  pathPrefix?: string
  maxDepth?: number
}

export type KbListIndexEntry = {
  path: string
  title: string
  type: string
  artifactId: string
}

export type KbListIndexResult = {
  pages: KbListIndexEntry[]
}

export type KbGetPageArgs = {
  path: string
  artifactId?: string
}

export type KbGetPageResult = {
  found: boolean
  path: string
  title?: string
  type?: string
  text?: string
  artifactId?: string
  source?: KbSource
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

export type WebResearchArgs = WebResearchRequestArgs
export type WebResearchDelegationResult = WebResearchRequestResult

export type DelegationProcessInput = {
  ticketId: string
  targetAgentId: string
  requesterAgentId: string
  actingUserId?: string
}

export type DelegationProcessor = (input: DelegationProcessInput) => Promise<void>

/**
 * Folyamat-ticket állapotváltásának gazdája (a `TicketStateMachine` szűk nézete).
 * A `board_write` ezen keresztül zárja le a folyamat-lépéseket, hogy a kötelező
 * kapuk és az output-szerződés kikényszerüljenek, és a `ProcessService.advance`
 * ténylegesen tovább-léptesse a Futást (l. process-runtime-advance-gap). Ha nincs
 * bekötve, a `board_write` a legacy `TicketService.transition`-re esik vissza.
 */
export interface PlaybookTicketTransitioner {
  transitionTicket(input: {
    tenantId: string | null
    ticketId: string
    toState: string
    actor: { type: 'agent'; id?: string | null }
    outputPayload?: Record<string, unknown>
  }): Promise<unknown>
}

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

// user_directory — a tenanthoz tartozó humán felhasználók listája az agentnek
// (pl. a folyamat-agent innen keresi ki, ki az illetékes egy feladathoz, vagy
// kinek nyisson ticketet). A `jobDescription` a humán szabad szöveges szerepe.
export type UserDirectoryArgs = {
  query?: string
  limit?: number
}

export type UserDirectoryEntry = {
  userId: string
  name: string
  email: string
  role: string | null
  jobDescription: string | null
  status: string
}

export type UserDirectoryResult = {
  users: UserDirectoryEntry[]
}

// memory_propose — agent-memory-persistent-cross-conversation-spec.md §6.1.
// A `projectKey`/`tenantId` NEM agent-vezérelt mező (scope-injekció ellen):
// a broker/handler a futás kontextusából (conversationId → Conversation.projectKey,
// vagy ticketId → Ticket.processInstanceId → ProcessInstance.processDefinitionId)
// oldja fel, nem az args-ból.
export type MemoryProposeSourceRefArg = { type: string; id?: string; path?: string }
export type MemoryProposeArgs = {
  operation: 'create' | 'update' | 'supersede' | 'archive' | 'delete_request'
  type?: string
  workstreamKey?: string
  path?: string
  title?: string
  summary?: string
  text?: string
  tags?: string[]
  salienceHint?: string
  confidence?: string
  supersedes?: string
  reviewAfter?: string
  expiresAt?: string
  sourceRefs?: MemoryProposeSourceRefArg[]
  evidence?: string
  reason: string
}
export type MemoryProposeResult =
  | { ok: true; candidateId: string; status: 'proposed' }
  | { ok: false; reason: string }

/** Chat/ticket csatolmány oldal-/keresés-olvasás (extracted blocks). */
export type DocumentReadArgs = {
  documentId: string
  pages?: string
  query?: string
  maxChars?: number
  maxMatches?: number
}

export type DocumentReadResult = {
  documentId: string
  filename: string
  totalPages: number
  pages: Array<{ page?: number; heading: string; text: string }>
  truncated: boolean
  matchCount?: number
  hint?: string
}

export type GmailSearchArgs = { query: string; maxResults?: number }
export type GmailGetMessageArgs = { id: string }
export type MailboxCountArgs = {
  connectorId?: string
  query?: string
  labelIds?: string[]
  includeSpamTrash?: boolean
}
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
export type HttpApiHeaders = Record<string, string>
export type HttpApiGetArgs = { connectorId?: string; path: string; query?: HttpApiQuery; headers?: HttpApiHeaders }
export type HttpApiRequestArgs = {
  connectorId?: string
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  query?: HttpApiQuery
  headers?: HttpApiHeaders
  body?: unknown
}
export type HttpApiCallResult = { status: number; ok: boolean; body: unknown }

export type GmailSearchResult = { messages: Array<Record<string, string>> }
export type GmailGetMessageResult = Record<string, string>
export type MailboxCountResult = { count: number; query: string }
export type GmailCreateDraftResult = { draftId: string }
export type GmailSendResult = { messageId: string }

// ── Sandbox App Registry tool args (Feature-spec §5) ─────────────────────────
export type SandboxAppCreateArgs = {
  name: string
  description?: string
  criticality?: 'L0' | 'L1'
  createdFromTicketId?: string
}
export type SandboxAppUpdateArtifactArgs = {
  appId: string
  html: string
  changeSummary: string
  activate?: boolean
}
export type SandboxAppPreviewArgs = {
  appId: string
  version?: number
}
export type SandboxAppExportArgs = {
  appId: string
  version?: number
}
export type SandboxAppListArgs = {
  search?: string
  status?: 'draft' | 'active' | 'archived' | 'blocked'
  limit?: number
}
export type SandboxAppGetArgs = {
  appId: string
  version?: number
}

export type SandboxAppCreateResult = { appId: string; status: 'draft' }
export type SandboxAppUpdateArtifactResult = {
  versionId: string
  version: number
  contentHash: string
  status: 'draft' | 'active'
  validationResult: { status?: string; warnings?: string[] }
}
export type SandboxAppPreviewResult = { previewUrl: string; contentHash: string; expiresAt: string }
export type SandboxAppExportResult = { filename: string; contentRef: string; contentHash: string; sizeBytes: number }
export type SandboxAppListResult = {
  apps: Array<{
    appId: string
    name: string
    description?: string
    status: string
    activeVersion?: number
    createdByLabel: string
    updatedAt: string
  }>
}
export type SandboxAppGetResult = {
  appId: string
  name: string
  status: string
  version: number
  contentHash: string
  html: string
}

// Sandbox verziózás agent-toolok (SandboxVersioning-Graduation §5). Az agent
// commitolhat, javasolhat promóciót és test-env snapshotot készíthet — de SOHA
// nem promótálhat, nem exportálhat és nem nyúl live adathoz (a service kikényszeríti).
export type SandboxCommitArgs = {
  projectId: string
  files: Array<{ path: string; contentRef: string }>
  changeSummary: string
  createdFromTicketId?: string
}
export type SandboxRequestPromotionArgs = { projectId: string; reason?: string }
export type SandboxSnapshotArgs = { projectId: string; label?: string }

export type SandboxCommitResult = { commitId: string; seq: number; treeHash: string }
export type SandboxRequestPromotionResult = { promotionId: string; status: 'pending_approval'; fromCommitId: string }
export type SandboxSnapshotResult = { snapshotId: string; status: 'available'; schemaHash: string }

export type FileReadArgs = { path: string; offset?: number; limit?: number }
export type FileWriteArgs = { path: string; content: string }
export type HtmlCreateArgs = { path: string; html: string; title?: string }
export type FileEditArgs = { path: string; old_string: string; new_string: string; replace_all?: boolean }
export type FileListArgs = { path?: string; recursive?: boolean }
export type FileGlobArgs = { pattern: string }
export type FileSearchArgs = { pattern: string; path?: string; glob?: string; ignore_case?: boolean; max_results?: number }
export type FileDeleteArgs = { path: string }
export type RepoPrepareArgs = {
  repoUrl?: string
  owner?: string
  repo?: string
  ref?: string
  forceRefresh?: boolean
}
export type RepoPrepareResult = {
  ok: true
  repoPath: string
  status: 'already_current' | 'updated'
  owner: string
  repo: string
  ref: string
  commitSha: string
  filesIndexed: number
  filesWritten: number
  filesSkipped: number
  bytesWritten: number
  metadataPath: string
  nextSteps: string[]
}
export type RepoOpenPullRequestArgs = {
  title: string
  body?: string
  branch?: string
  baseRef?: string
  draft?: boolean
}
export type RepoOpenPullRequestResult =
  | {
      ok: true
      changed: false
      message: string
    }
  | {
      ok: true
      changed: true
      owner: string
      repo: string
      baseRef: string
      branch: string
      commitSha: string
      pullRequestUrl: string
      pullRequestNumber: number
      filesChanged: number
      changedPaths: string[]
    }
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
export type DocxCreateArgs = {
  path: string
  title?: string
  author?: string
  subject?: string
  blocks: DocxBlockSpec[]
}
export type PdfReadArgs = { path: string; page_range?: string }
export type PdfCreateArgs = {
  path: string
  source_xlsx?: string
  sheet?: string
  title?: string
  headers?: string[]
  rows?: Array<Array<string | number | boolean | null>>
}
export type PptxCreateArgs = {
  path: string
  title?: string
  author?: string
  subject?: string
  slides: PptxSlideSpec[]
}

type ToolInvokeBase = {
  agentId: string
  agentVersion: number
  ticketId?: string
  conversationId?: string
  actingUserId?: string
  /**
   * Az `actingUserId` csak megbízható, szerveroldali futás-kontektsusból
   * származhat. Az agent API-kulcs birtokosa nem választhat felhasználót.
   */
  actingUserSource?: 'trusted_internal' | 'external_agent_api'
}

export type ToolBrokerInvokeInput =
  | (ToolInvokeBase & { tool: 'kb_search'; args: KbSearchArgs })
  | (ToolInvokeBase & { tool: 'kb_list_index'; args: KbListIndexArgs })
  | (ToolInvokeBase & { tool: 'kb_get_page'; args: KbGetPageArgs })
  | (ToolInvokeBase & { tool: 'board_write'; args: BoardWriteArgs })
  | (ToolInvokeBase & { tool: 'ticket_create'; args: TicketCreateArgs })
  | (ToolInvokeBase & { tool: 'agent_ask'; args: AgentAskArgs })
  | (ToolInvokeBase & { tool: 'agent_resolve'; args: AgentResolveArgs })
  | (ToolInvokeBase & { tool: 'agent_catalog'; args: AgentCatalogArgs })
  | (ToolInvokeBase & { tool: 'user_directory'; args: UserDirectoryArgs })
  | (ToolInvokeBase & { tool: 'gmail_search'; args: GmailSearchArgs })
  | (ToolInvokeBase & { tool: 'gmail_get_message'; args: GmailGetMessageArgs })
  | (ToolInvokeBase & { tool: 'mailbox_count'; args: MailboxCountArgs })
  | (ToolInvokeBase & { tool: 'gmail_create_draft'; args: GmailCreateDraftArgs })
  | (ToolInvokeBase & { tool: 'gmail_send'; args: GmailSendArgs })
  | (ToolInvokeBase & { tool: 'http_api_get'; args: HttpApiGetArgs })
  | (ToolInvokeBase & { tool: 'http_api_request'; args: HttpApiRequestArgs })
  | (ToolInvokeBase & { tool: 'repo_prepare'; args: RepoPrepareArgs })
  | (ToolInvokeBase & { tool: 'repo_open_pull_request'; args: RepoOpenPullRequestArgs })
  | (ToolInvokeBase & { tool: 'file_read'; args: FileReadArgs })
  | (ToolInvokeBase & { tool: 'file_write'; args: FileWriteArgs })
  | (ToolInvokeBase & { tool: 'create_html'; args: HtmlCreateArgs })
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
  | (ToolInvokeBase & { tool: 'docx_create'; args: DocxCreateArgs })
  | (ToolInvokeBase & { tool: 'pdf_read'; args: PdfReadArgs })
  | (ToolInvokeBase & { tool: 'pdf_create'; args: PdfCreateArgs })
  | (ToolInvokeBase & { tool: 'pptx_create'; args: PptxCreateArgs })
  | (ToolInvokeBase & { tool: 'sandbox_app.create'; args: SandboxAppCreateArgs })
  | (ToolInvokeBase & { tool: 'sandbox_app.update_artifact'; args: SandboxAppUpdateArtifactArgs })
  | (ToolInvokeBase & { tool: 'sandbox_app.preview'; args: SandboxAppPreviewArgs })
  | (ToolInvokeBase & { tool: 'sandbox_app.export'; args: SandboxAppExportArgs })
  | (ToolInvokeBase & { tool: 'sandbox_app.list'; args: SandboxAppListArgs })
  | (ToolInvokeBase & { tool: 'sandbox_app.get'; args: SandboxAppGetArgs })
  | (ToolInvokeBase & { tool: 'sandbox.commit'; args: SandboxCommitArgs })
  | (ToolInvokeBase & { tool: 'sandbox.request_promotion'; args: SandboxRequestPromotionArgs })
  | (ToolInvokeBase & { tool: 'sandbox.snapshot'; args: SandboxSnapshotArgs })
  | (ToolInvokeBase & { tool: 'web_search'; args: WebSearchArgs })
  | (ToolInvokeBase & { tool: 'web_research_request'; args: WebResearchArgs })
  | (ToolInvokeBase & { tool: 'memory_propose'; args: MemoryProposeArgs })
  | (ToolInvokeBase & { tool: 'document_read'; args: DocumentReadArgs })

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
        | KbListIndexResult
        | KbGetPageResult
        | BoardWriteResult
        | TicketCreateResult
        | AgentAskResult
        | AgentResolveResult
        | AgentCatalogResult
        | UserDirectoryResult
        | GmailSearchResult
        | GmailGetMessageResult
        | MailboxCountResult
        | GmailCreateDraftResult
        | GmailSendResult
        | HttpApiCallResult
        | RepoPrepareResult
        | RepoOpenPullRequestResult
        | FileReadResult
        | FileWriteResult
        | HtmlCreateResult
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
        | DocxCreateResult
        | PdfReadResult
        | SandboxCommitResult
        | SandboxRequestPromotionResult
        | SandboxSnapshotResult
        | SandboxAppCreateResult
        | SandboxAppUpdateArtifactResult
        | SandboxAppPreviewResult
        | SandboxAppExportResult
        | SandboxAppListResult
        | SandboxAppGetResult
        | WebSearchResult
        | WebResearchDelegationResult
        | MemoryProposeResult
        | DocumentReadResult
      resultMeta: Record<string, unknown>
      latencyMs: number
    }

/** A sikeres tool-végrehajtás nyers eredménye (a handlerek uniója). */
export type ToolExecutionResult = Extract<ToolBrokerInvokeResult, { denied: false }>['result']

export type ToolName = ToolBrokerInvokeInput['tool']

export type AuthorizationResult =
  | { allowed: true; connector?: Connector; grant?: ConnectorGrant; actingUserId?: string; agentSecretAlias?: string | null }
  | { allowed: false; reason: string; connector?: Connector }
