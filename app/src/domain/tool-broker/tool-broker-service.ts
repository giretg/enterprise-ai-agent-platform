import type {
  Agent,
  AgentRole,
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
import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { personaFor } from '@/lib/agent-persona'
import {
  buildAgentCatalogEntry,
  scoreAgentForCatalogQuery,
  type AgentCatalogEntry,
} from '@/lib/agent-catalog'
import { readDelegationPayload, shouldCompleteDelegation } from '@/lib/delegation-payload'
import { isAgentReachableFromTenant, filterAgentsByTenant } from '@/lib/tenant-reachability'
import {
  agentAnswerStructuredFromPayload,
  extractAgentAnswerDisplayBody,
} from '@/lib/playbook-v2/process-step-payload'
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
  type HtmlCreateResult,
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
  KnowledgeArtifactRepository,
  KnowledgeChunkRepository,
  KnowledgeChunkSearchHit,
  KnowledgeIndexEntry,
  KnowledgePageChunk,
  TicketRepository,
  ToolBrokerRepository,
} from '@/repositories/interfaces'
import type { OkfSourceRef } from '@/lib/kb-v3'
import type { TicketService } from '@/domain/ticket/ticket-service'
import type {
  XlsxRow,
  XlsxCellChange,
  CellStyle,
  XlsxSheetSpec,
} from '@/domain/file-editor/adapters/xlsx-adapter'
import type { PptxSlideSpec } from '@/domain/file-editor/adapters/pptx-adapter'
import type { WebSearchPolicyService } from '@/domain/web-search/web-search-policy-service'
import type { WebSearchService } from '@/domain/web-search/web-search-service'
import {
  WEB_SEARCH_CONTROLS_KEY,
  parseWebSearchConfig,
  type WebSearchArgs,
  type WebSearchEffectiveQuery,
  type WebSearchResult,
} from '@/domain/web-search/web-search-types'
import { KnownUrlRegistry } from '@/domain/web-research/known-url-registry'
import { validateWebResearchResult } from '@/domain/web-research/web-research-validator'
import type {
  WebResearchRequestArgs,
  WebResearchRequestResult,
  WebResearchResult,
  WebResearchSourceType,
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
export type HttpApiGetArgs = { connectorId?: string; path: string; query?: HttpApiQuery }
export type HttpApiRequestArgs = {
  connectorId?: string
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  query?: HttpApiQuery
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

type SandboxAppCreateResult = { appId: string; status: 'draft' }
type SandboxAppUpdateArtifactResult = {
  versionId: string
  version: number
  contentHash: string
  status: 'draft' | 'active'
  validationResult: { status?: string; warnings?: string[] }
}
type SandboxAppPreviewResult = { previewUrl: string; contentHash: string; expiresAt: string }
type SandboxAppExportResult = { filename: string; contentRef: string; contentHash: string; sizeBytes: number }

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

type SandboxCommitResult = { commitId: string; seq: number; treeHash: string }
type SandboxRequestPromotionResult = { promotionId: string; status: 'pending_approval'; fromCommitId: string }
type SandboxSnapshotResult = { snapshotId: string; status: 'available'; schemaHash: string }

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
  | (ToolInvokeBase & { tool: 'pdf_read'; args: PdfReadArgs })
  | (ToolInvokeBase & { tool: 'pdf_create'; args: PdfCreateArgs })
  | (ToolInvokeBase & { tool: 'pptx_create'; args: PptxCreateArgs })
  | (ToolInvokeBase & { tool: 'sandbox_app.create'; args: SandboxAppCreateArgs })
  | (ToolInvokeBase & { tool: 'sandbox_app.update_artifact'; args: SandboxAppUpdateArtifactArgs })
  | (ToolInvokeBase & { tool: 'sandbox_app.preview'; args: SandboxAppPreviewArgs })
  | (ToolInvokeBase & { tool: 'sandbox_app.export'; args: SandboxAppExportArgs })
  | (ToolInvokeBase & { tool: 'sandbox.commit'; args: SandboxCommitArgs })
  | (ToolInvokeBase & { tool: 'sandbox.request_promotion'; args: SandboxRequestPromotionArgs })
  | (ToolInvokeBase & { tool: 'sandbox.snapshot'; args: SandboxSnapshotArgs })
  | (ToolInvokeBase & { tool: 'web_search'; args: WebSearchArgs })
  | (ToolInvokeBase & { tool: 'web_research_request'; args: WebResearchArgs })

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
        | PdfReadResult
        | SandboxCommitResult
        | SandboxRequestPromotionResult
        | SandboxSnapshotResult
        | SandboxAppCreateResult
        | SandboxAppUpdateArtifactResult
        | SandboxAppPreviewResult
        | SandboxAppExportResult
        | WebSearchResult
        | WebResearchDelegationResult
      resultMeta: Record<string, unknown>
      latencyMs: number
    }

type ToolName = ToolBrokerInvokeInput['tool']

type AuthorizationResult =
  | { allowed: true; connector?: Connector; grant?: ConnectorGrant; actingUserId?: string; agentSecretAlias?: string | null }
  | { allowed: false; reason: string; connector?: Connector }

const TOOL_REQUIREMENTS: Partial<Record<
  ToolName,
  { connectorType: ConnectorType; accessMode: ConnectorAccessMode }
>> = {
  kb_search: { connectorType: 'knowledge_base', accessMode: 'read' },
  kb_list_index: { connectorType: 'knowledge_base', accessMode: 'read' },
  kb_get_page: { connectorType: 'knowledge_base', accessMode: 'read' },
  board_write: { connectorType: 'board', accessMode: 'write' },
  ticket_create: { connectorType: 'board', accessMode: 'write' },
  agent_ask: { connectorType: 'board', accessMode: 'write' },
  agent_resolve: { connectorType: 'board', accessMode: 'read' },
  agent_catalog: { connectorType: 'board', accessMode: 'read' },
  user_directory: { connectorType: 'board', accessMode: 'read' },
  gmail_search: { connectorType: 'gmail', accessMode: 'read' },
  gmail_get_message: { connectorType: 'gmail', accessMode: 'read' },
  mailbox_count: { connectorType: 'gmail', accessMode: 'read' },
  gmail_create_draft: { connectorType: 'gmail', accessMode: 'write' },
  gmail_send: { connectorType: 'gmail', accessMode: 'write' },
  http_api_get: { connectorType: 'http_api', accessMode: 'read' },
  http_api_request: { connectorType: 'http_api', accessMode: 'write' },
  repo_prepare: { connectorType: 'workspace', accessMode: 'write' },
  repo_open_pull_request: { connectorType: 'workspace', accessMode: 'write' },
  file_read: { connectorType: 'workspace', accessMode: 'read' },
  file_write: { connectorType: 'workspace', accessMode: 'write' },
  create_html: { connectorType: 'workspace', accessMode: 'write' },
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
  pptx_create: { connectorType: 'workspace', accessMode: 'write' },
  'sandbox_app.create': { connectorType: 'board', accessMode: 'write' },
  'sandbox_app.update_artifact': { connectorType: 'board', accessMode: 'write' },
  'sandbox_app.preview': { connectorType: 'board', accessMode: 'read' },
  'sandbox_app.export': { connectorType: 'board', accessMode: 'read' },
  'sandbox.commit': { connectorType: 'board', accessMode: 'write' },
  'sandbox.request_promotion': { connectorType: 'board', accessMode: 'write' },
  'sandbox.snapshot': { connectorType: 'board', accessMode: 'write' },
  web_search: { connectorType: 'web_search', accessMode: 'read' },
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * user_directory tiszta szűrője (DB-mentes, ezért determinisztikusan tesztelhető).
 * Az opcionális `query` a néven / szerepen (role + jobDescription) / e-mailen szűr,
 * ékezet- és kisbetű-függetlenül, ÉS-kapcsolt szótagokkal (minden keresőszónak
 * illeszkednie kell). A `limit` 1..100 közé szorítva (alapból 50).
 */
export function filterUserDirectory(
  entries: UserDirectoryEntry[],
  args: UserDirectoryArgs,
): UserDirectoryResult {
  const query = normalizeText((args.query ?? '').trim())
  const filtered = query
    ? entries.filter((u) => {
        const haystack = normalizeText(
          [u.name, u.jobDescription ?? '', u.role ?? '', u.email].join(' '),
        )
        return query.split(/\s+/).every((term) => haystack.includes(term))
      })
    : entries

  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100)
  return { users: filtered.slice(0, limit) }
}

// A tenant-elérhetőségi szabály immár a `@/lib/tenant-reachability` közös
// modulban él (a Tool Broker ÉS a Knowledge Base ugyanazt az invariánst
// használja). Itt re-exportáljuk a visszafelé kompatibilitás miatt (a
// tool-broker-tenant-isolation.test.ts innen importál); a modulon belüli
// használat a fenti importon keresztül történik.
export { isAgentReachableFromTenant, filterAgentsByTenant }

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

const REPO_WORKSPACE_PATH = 'repo'
const REPO_METADATA_PATH = `${REPO_WORKSPACE_PATH}/.repo_prepare.json`
const REPO_IMPORT_MAX_FILES = Number(process.env.REPO_PREPARE_MAX_FILES ?? 1200)
const REPO_IMPORT_MAX_TOTAL_BYTES = Number(process.env.REPO_PREPARE_MAX_TOTAL_BYTES ?? 12 * 1024 * 1024)
const REPO_IMPORT_MAX_FILE_BYTES = Number(process.env.REPO_PREPARE_MAX_FILE_BYTES ?? 512 * 1024)

const REPO_EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.vercel',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.cache',
  'vendor',
])

const REPO_SKIPPED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.mov', '.mp3', '.wav', '.exe', '.dll',
])

type GitHubRepoTarget = { owner: string; repo: string; ref?: string }
type GitHubRepoResponse = { default_branch?: string }
type GitHubCommitResponse = { sha: string; commit?: { tree?: { sha?: string } } }
type GitHubTreeItem = { path: string; mode: string; type: string; sha: string; size?: number }
type GitHubTreeResponse = { tree: GitHubTreeItem[]; truncated?: boolean }
type GitHubBlobResponse = { content: string; encoding: string; size?: number }
type RepoPrepareMetadata = {
  owner: string
  repo: string
  ref: string
  commitSha: string
  repoPath: string
  filesIndexed: number
  bytesWritten: number
  preparedAt: string
}

function parseGitHubRepoUrl(repoUrl: string): GitHubRepoTarget | null {
  try {
    const url = new URL(repoUrl.trim())
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (url.hostname === 'github.com' && parts.length >= 2) {
      return { owner: parts[0], repo: parts[1].replace(/\.git$/i, '') }
    }
    if (url.hostname === 'api.github.com' && parts[0] === 'repos' && parts.length >= 3) {
      return { owner: parts[1], repo: parts[2].replace(/\.git$/i, '') }
    }
  } catch {
    return null
  }
  return null
}

function validGitHubName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && !value.includes('..') && !value.includes('/')
}

function resolveRepoTarget(args: RepoPrepareArgs, agent: Agent): GitHubRepoTarget {
  const direct =
    args.owner && args.repo
      ? { owner: args.owner, repo: args.repo, ref: args.ref }
      : args.repoUrl
        ? { ...parseGitHubRepoUrl(args.repoUrl), ref: args.ref }
        : null
  if (direct?.owner && direct.repo) {
    if (!validGitHubName(direct.owner) || !validGitHubName(direct.repo)) {
      throw new Error('repo_prepare invalid GitHub owner/repo')
    }
    return { owner: direct.owner, repo: direct.repo, ref: direct.ref }
  }

  const config = isRecord(agent.modelConfig) ? agent.modelConfig : {}
  const candidates = [
    config.repoUrl,
    config.repositoryUrl,
    config.githubRepoUrl,
    isRecord(config.repository) ? config.repository.url : undefined,
    isRecord(config.repo) ? config.repo.url : undefined,
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const parsed = parseGitHubRepoUrl(candidate)
    if (parsed) {
      return {
        ...parsed,
        ref:
          args.ref ??
          (isRecord(config.repository) && typeof config.repository.ref === 'string'
            ? config.repository.ref
            : undefined),
      }
    }
  }

  const structured = isRecord(config.repository)
    ? config.repository
    : isRecord(config.repo)
      ? config.repo
      : null
  if (structured && typeof structured.owner === 'string' && typeof structured.repo === 'string') {
    if (!validGitHubName(structured.owner) || !validGitHubName(structured.repo)) {
      throw new Error('repo_prepare invalid configured GitHub owner/repo')
    }
    return {
      owner: structured.owner,
      repo: structured.repo,
      ref: args.ref ?? (typeof structured.ref === 'string' ? structured.ref : undefined),
    }
  }

  throw new Error('repo_prepare requires repoUrl or owner+repo, or an agent modelConfig.repository')
}

function shouldSkipRepoPath(path: string, size = 0): boolean {
  const parts = path.split('/')
  if (parts.some((part) => REPO_EXCLUDED_DIRS.has(part))) return true
  if (size > REPO_IMPORT_MAX_FILE_BYTES) return true
  const lower = path.toLowerCase()
  return [...REPO_SKIPPED_EXTENSIONS].some((ext) => lower.endsWith(ext))
}

function decodeRepoMetadata(raw: string | null): RepoPrepareMetadata | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RepoPrepareMetadata>
    if (
      typeof parsed.owner === 'string' &&
      typeof parsed.repo === 'string' &&
      typeof parsed.ref === 'string' &&
      typeof parsed.commitSha === 'string'
    ) {
      return parsed as RepoPrepareMetadata
    }
  } catch {
    return null
  }
  return null
}

function assertUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false
  const text = buffer.toString('utf8')
  return !text.includes('\uFFFD')
}

/** Git blob SHA-1 (a GitHub tree/blob API ugyan\u00EDgy c\u00EDmzi a tartalmat), hogy a
 *  workspace-f\u00E1jlokat b\u00E1jt-egyenl\u0151s\u00E9g szerint tudjuk \u00F6sszevetni az import\u00E1lt
 *  snapshot blob-shaival \u2014 en\u00E9lk\u00FCl nem der\u00FClne ki, melyik f\u00E1jl v\u00E1ltozott. */
function gitBlobSha1(content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8')
  return createHash('sha1').update(Buffer.concat([header, content])).digest('hex')
}

function repoPrepareNextSteps(): string[] {
  return [
    'Use file_search under repoPath before reading files.',
    'Use file_glob for filename/path discovery.',
    'Use file_read only for the specific files you need.',
    'Use file_edit/file_write for workspace changes, then summarize exact changed paths.',
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

/**
 * KB-v3 §10 retrieval-összeállítás — tiszta, DB-mentes (ezért determinisztikusan
 * tesztelhető). Sorrend:
 *  1) published OKF-chunk full-text találatok (kurált, elöl — §9.1),
 *  2) legacy stem-scoring a memórián + a NEM-superseded nyers dokumentumokon (§11.3),
 *     k-ig feltöltve az OKF-találatok után,
 *  3) ha egyik sem adott találatot: teljes-korpusz (fájlnév + törzs) fallback a
 *     nem-superseded nyers dokumentumokon.
 * A `supersededDocIds` a §10.5 szerinti „publikált OKF van rá" dokumentumhalmaz —
 * ezek nyers `extractedText`-je nem jön vissza (nincs nyers + parafrázis duplázás).
 */
export function assembleKbHits(input: {
  query: string
  k: number
  memoryContent: string
  memoryId: string | null
  memoryVersion: number | null
  okfChunkHits: KnowledgeChunkSearchHit[]
  docs: Array<{ id: string; filename: string; extractedText: string | null }>
  supersededDocIds: Set<string>
}): KbSearchHit[] {
  const { query, k } = input
  const termStems = queryTermStems(query)

  // Egy fájlnév-stem egyezés ennyi tartalmi-stem egyezést ér — a keresett
  // dokumentumot a puszta cím-egyezés is a generikus tartalmi találatok elé emeli.
  const FILENAME_STEM_WEIGHT = 3

  type ScoredChunk = {
    chunk: string
    score: number
    docId: string
    sourceRef: string
    memoryVersion: number | null
  }

  function scoreChunks(
    text: string,
    docId: string,
    sourceRef: string,
    memoryVersion: number | null,
    filenameStems: Iterable<string> = [],
  ): ScoredChunk[] {
    // A fájlnév-stemek a legerősebb „ez a keresett dokumentum" jelzés (a fájlnév a
    // dokumentum egészére vonatkozik, nem egy chunkra). Ezért külön, magasabb
    // súllyal pontozzuk őket: egy hosszú/zajos query esetén így a cél-dokumentum
    // nem hígul fel a sok generikus tartalmi egyezés (más docok chunkjai) mögé.
    const filenameStemSet = new Set(filenameStems)
    return text
      .split(/\n{2,}|\n(?=-\s+)/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const chunkStems = new Set(
          normalizeText(chunk).split(/\s+/).filter(Boolean).map(stemToken),
        )
        const score = termStems.reduce((sum, stem) => {
          if (filenameStemSet.has(stem)) return sum + FILENAME_STEM_WEIGHT
          if (chunkStems.has(stem)) return sum + 1
          return sum
        }, 0)
        return { chunk, score, docId, sourceRef, memoryVersion }
      })
      .filter((item) => item.score > 0)
  }

  // 1) Elsődleges: published OKF-chunk full-text találatok navigálható path-szal +
  // oldal/section-szintű forrás-linkkel (§4.7/§9.1).
  const okfHits: KbSearchHit[] = input.okfChunkHits.map((hit) => {
    const ref = (isRecord(hit.sourceRef) ? hit.sourceRef : {}) as OkfSourceRef
    const source = {
      documentId: typeof ref.documentId === 'string' ? ref.documentId : undefined,
      filename: typeof ref.filename === 'string' ? ref.filename : undefined,
      page: typeof ref.page === 'number' ? ref.page : undefined,
      section: hit.section ?? (typeof ref.section === 'string' ? ref.section : undefined),
      cell: typeof ref.cell === 'string' ? ref.cell : undefined,
    }
    return {
      docId: source.documentId ? `doc:${source.documentId}` : `okf:${hit.artifactId}`,
      snippet: snippet(hit.text),
      // A fájlnév a sourceRef VÉGÉN áll, hogy a legacy `/:([^:]+)$/` kinyerés is működjön.
      sourceRef: `okf:${hit.path}:${source.filename ?? hit.title}`,
      memoryVersion: null,
      path: hit.path,
      title: hit.title,
      score: hit.score,
      source,
    } satisfies KbSearchHit
  })

  const memoryChunks = scoreChunks(
    input.memoryContent,
    `memory:${input.memoryId}`,
    `memory:${input.memoryId}:v${input.memoryVersion ?? 'unknown'}`,
    input.memoryVersion,
  )

  const flatDocs = input.docs.filter((doc) => !input.supersededDocIds.has(doc.id))
  const docChunks: ScoredChunk[] = flatDocs.flatMap((doc) =>
    scoreChunks(
      documentSearchCorpus(doc.filename, doc.extractedText),
      `doc:${doc.id}`,
      `doc:${doc.id}:${doc.filename}`,
      null,
      stemsFromText(filenameSearchText(doc.filename)),
    ),
  )

  // 2) Legacy stem-scoring (memória + nem-superseded nyers doc) — az OKF UTÁN sorolva.
  const legacyHits: KbSearchHit[] = [...memoryChunks, ...docChunks]
    .sort((a, b) => b.score - a.score)
    .map((item) => ({
      docId: item.docId,
      snippet: snippet(item.chunk),
      sourceRef: item.sourceRef,
      memoryVersion: item.memoryVersion,
    }))

  const hits: KbSearchHit[] = [...okfHits, ...legacyHits].slice(0, k)
  if (hits.length > 0) return hits

  // 3) Fallback (se OKF, se legacy chunk-egyezés): teljes korpusz a nem-superseded docokon.
  if (flatDocs.length === 0) return hits
  return flatDocs
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
    .map(({ doc }) => {
      const body = doc.extractedText?.trim()
      const chunk = body
        ? body.split(/\n{2,}|\n(?=-\s+)/).map((part) => part.trim()).find(Boolean) ?? body
        : `[${doc.filename}]`
      return {
        docId: `doc:${doc.id}`,
        snippet: snippet(chunk),
        sourceRef: `doc:${doc.id}:${doc.filename}`,
        memoryVersion: null,
      } satisfies KbSearchHit
    })
}

/** OKF chunk sourceRef (JSON) → tipizált citation-forrás (§4.7). */
function toKbSource(sourceRef: unknown, section: string | null): KbSource {
  const ref = (isRecord(sourceRef) ? sourceRef : {}) as OkfSourceRef
  return {
    documentId: typeof ref.documentId === 'string' ? ref.documentId : undefined,
    filename: typeof ref.filename === 'string' ? ref.filename : undefined,
    page: typeof ref.page === 'number' ? ref.page : undefined,
    section: section ?? (typeof ref.section === 'string' ? ref.section : undefined),
    cell: typeof ref.cell === 'string' ? ref.cell : undefined,
  }
}

/** Egy `path` mélysége az OKF-fában (`pages/01-foo.md` → 2). */
function pathDepth(path: string): number {
  return path.split('/').filter(Boolean).length
}

/**
 * §9.3 — `kb_list_index` tiszta összeállítója: a repo által adott published
 * oldalakat opcionálisan `maxDepth`-ig szűri (a `pathPrefix` szűrést a repo
 * végzi az indexen). DB-mentes, tesztelhető.
 */
export function assembleKbIndex(
  entries: KnowledgeIndexEntry[],
  maxDepth?: number,
): KbListIndexResult {
  const pages = entries
    .filter((e) => maxDepth === undefined || pathDepth(e.path) <= maxDepth)
    .map((e) => ({
      path: e.path,
      title: e.title,
      type: e.type,
      artifactId: e.artifactId,
    }))
  return { pages }
}

/**
 * §9.2 — `kb_get_page` tiszta összeállítója: egy oldal chunkjait (chunkIndex
 * sorrendben) egyetlen szöveggé fűzi, és az oldalcímet + a legelső chunk
 * forrás-linkjét adja vissza (§4.7). DB-mentes, tesztelhető.
 */
export function assembleKbPage(path: string, chunks: KnowledgePageChunk[]): KbGetPageResult {
  if (chunks.length === 0) return { found: false, path }
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
  const first = ordered[0]
  return {
    found: true,
    path,
    title: first.title,
    type: first.type,
    artifactId: first.artifactId,
    text: ordered.map((c) => c.text.trim()).filter(Boolean).join('\n\n'),
    source: toKbSource(first.sourceRef, first.section),
  }
}

function argsMeta(
  input: ToolBrokerInvokeInput,
  webSearchEffective?: WebSearchEffectiveQuery,
): Record<string, unknown> {
  const base = {
    ticketId: input.ticketId ?? null,
    conversationId: input.conversationId ?? null,
    actingUserId: input.actingUserId ?? null,
  }

  if (input.tool === 'kb_search') {
    return { ...base, queryLength: input.args.query.length, k: input.args.k ?? 5 }
  }

  if (input.tool === 'kb_list_index') {
    return {
      ...base,
      pathPrefix: input.args.pathPrefix ?? null,
      maxDepth: input.args.maxDepth ?? null,
    }
  }

  if (input.tool === 'kb_get_page') {
    return { ...base, path: input.args.path, artifactId: input.args.artifactId ?? null }
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

  if (input.tool === 'user_directory') {
    return {
      ...base,
      queryLength: input.args.query?.length ?? 0,
      limit: input.args.limit ?? null,
    }
  }

  if (input.tool === 'gmail_search') {
    return { ...base, queryLength: input.args.query.length, maxResults: input.args.maxResults ?? 10 }
  }

  if (input.tool === 'gmail_get_message') {
    return { ...base, messageId: input.args.id }
  }

  if (input.tool === 'mailbox_count') {
    return {
      ...base,
      connectorId: input.args.connectorId ?? null,
      queryLength: input.args.query?.length ?? 0,
      labelIds: input.args.labelIds ?? [],
      includeSpamTrash: input.args.includeSpamTrash ?? false,
    }
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
    return {
      ...base,
      connectorId: input.args.connectorId ?? null,
      method: 'GET',
      path: input.args.path,
      queryKeys: Object.keys(input.args.query ?? {}).sort(),
    }
  }

  if (input.tool === 'http_api_request') {
    return {
      ...base,
      connectorId: input.args.connectorId ?? null,
      method: input.args.method,
      path: input.args.path,
      queryKeys: Object.keys(input.args.query ?? {}).sort(),
      hasBody: input.args.body !== undefined,
    }
  }

  if (input.tool === 'repo_prepare') {
    return {
      ...base,
      hasRepoUrl: Boolean(input.args.repoUrl),
      owner: input.args.owner ?? null,
      repo: input.args.repo ?? null,
      ref: input.args.ref ?? null,
      forceRefresh: input.args.forceRefresh ?? false,
    }
  }

  if (input.tool === 'repo_open_pull_request') {
    return {
      ...base,
      titleLength: input.args.title.length,
      hasBody: Boolean(input.args.body),
      branch: input.args.branch ?? null,
      baseRef: input.args.baseRef ?? null,
      draft: input.args.draft ?? false,
    }
  }

  if (input.tool === 'file_read') return { ...base, path: input.args.path, offset: input.args.offset ?? 1, limit: input.args.limit ?? 2000 }
  if (input.tool === 'file_write') return { ...base, path: input.args.path, contentLength: input.args.content.length }
  if (input.tool === 'create_html') return { ...base, path: input.args.path, htmlLength: input.args.html.length }
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
  if (input.tool === 'pptx_create') return { ...base, path: input.args.path, slideCount: input.args.slides?.length ?? 0 }
  if (input.tool === 'sandbox_app.create') return { ...base, name: input.args.name, criticality: input.args.criticality ?? 'L1' }
  if (input.tool === 'sandbox_app.update_artifact') return { ...base, appId: input.args.appId, htmlLength: input.args.html.length, activate: input.args.activate ?? false }
  if (input.tool === 'sandbox_app.preview') return { ...base, appId: input.args.appId, version: input.args.version ?? null }
  if (input.tool === 'sandbox_app.export') return { ...base, appId: input.args.appId, version: input.args.version ?? null }
  // §8.2: kód/adattartalom SOHA nem kerül auditba — csak projekt-id, fájldarabszám, path-lista.
  if (input.tool === 'sandbox.commit')
    return {
      ...base,
      projectId: input.args.projectId,
      fileCount: input.args.files.length,
      paths: input.args.files.map((f) => f.path).slice(0, 50),
    }
  if (input.tool === 'sandbox.request_promotion')
    return { ...base, projectId: input.args.projectId, hasReason: Boolean(input.args.reason) }
  if (input.tool === 'sandbox.snapshot')
    return { ...base, projectId: input.args.projectId, env: 'test' }
  if (input.tool === 'web_search') {
    // I-WS-10/WS10: a nyers query SOSEM kerül auditba — csak hossz + hash. A
    // hash-t a policy.authorize() már kiszámolta (webSearchEffective.queryHash);
    // itt csak fallback, ha valamiért nem állt rendelkezésre (sosem fordulhat
    // elő egy 'ok' hívásnál, de defenzív).
    return {
      ...base,
      queryLength: input.args.query.length,
      queryHash:
        webSearchEffective?.queryHash ??
        createHash('sha256').update(input.args.query).digest('hex').slice(0, 16),
      domainsRequested: input.args.domains ?? [],
      recencyDays: input.args.recencyDays ?? null,
      maxResultsRequested: input.args.maxResults ?? null,
      hasPurpose: Boolean(input.args.purpose),
    }
  }
  if (input.tool === 'web_research_request') {
    return {
      ...base,
      objectiveHash: createHash('sha256').update(input.args.objective).digest('hex').slice(0, 16),
      allowedSourceTypes: input.args.allowedSourceTypes ?? [],
      knownDomain: input.args.knownDomain ?? null,
      maxSources: input.args.maxSources ?? null,
    }
  }

  return {
    ...base,
    ticketId: input.args.ticketId,
    requestedState: input.args.patch.state ?? null,
    payloadKeys: input.args.patch.payload ? Object.keys(input.args.patch.payload).sort() : [],
  }
}

function isWebSearchResult(value: unknown): value is WebSearchResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'queryMeta' in value &&
    'warnings' in value &&
    'results' in value &&
    Array.isArray((value as { results: unknown }).results)
  )
}

function resultMeta(
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
    | PdfReadResult
    | SandboxAppCreateResult
    | SandboxAppUpdateArtifactResult
    | SandboxAppPreviewResult
    | SandboxAppExportResult
    | SandboxCommitResult
    | SandboxRequestPromotionResult
    | SandboxSnapshotResult
    | WebSearchResult
    | WebResearchDelegationResult,
): Record<string, unknown> {
  // 'in' nem szűri ki a Record<string, string> alakú eredménytípusokat (pl.
  // GmailGetMessageResult), ezért explicit type predicate kell a biztos narrowinghoz.
  if (isWebSearchResult(result)) {
    return {
      provider: result.queryMeta.provider,
      resultCount: result.queryMeta.resultCount,
      domainsEffective: result.queryMeta.domainsEffective,
      recencyDays: result.queryMeta.recencyDays ?? null,
      resultDomains: [...new Set(result.results.map((r) => r.domain))],
      warningCodes: result.warnings.map((w) => w.code),
    }
  }
  if ('status' in result && 'ok' in result && 'body' in result) {
    return { status: result.status, ok: result.ok }
  }

  if ('repoPath' in result && 'commitSha' in result) {
    return {
      status: result.status,
      repoPath: result.repoPath,
      owner: result.owner,
      repo: result.repo,
      ref: result.ref,
      commitSha: result.commitSha,
      filesIndexed: result.filesIndexed,
      filesWritten: result.filesWritten,
      filesSkipped: result.filesSkipped,
      bytesWritten: result.bytesWritten,
    }
  }

  if ('changed' in result) {
    return result.changed
      ? {
          changed: true,
          owner: result.owner,
          repo: result.repo,
          branch: result.branch,
          baseRef: result.baseRef,
          commitSha: result.commitSha,
          pullRequestUrl: result.pullRequestUrl,
          pullRequestNumber: result.pullRequestNumber,
          filesChanged: result.filesChanged,
          changedPaths: result.changedPaths,
        }
      : { changed: false, message: result.message }
  }

  if ('ok' in result && !('ticketId' in result) && (('result' in result) || ('error' in result))) {
    const research = result as WebResearchDelegationResult
    if (!research.ok) return { ok: false, error: research.error }
    return {
      ok: true,
      factCount: research.result.facts.length,
      sourceCount: research.result.sources.length,
      overallConfidence: research.result.overallConfidence,
      unverified: research.result.unverified,
    }
  }

  if ('hits' in result && Array.isArray(result.hits)) {
    return {
      hitCount: result.hits.length,
      // §13 — hány találat jött a published OKF-chunk indexből (path-szal) vs. legacy.
      okfHitCount: result.hits.filter((hit) => typeof hit.path === 'string').length,
      memoryVersions: [...new Set(result.hits.map((hit) => hit.memoryVersion))],
    }
  }

  // KB-v3 §9.2/§9.3 — OKF-navigáció (kb_list_index / kb_get_page) audit-metája.
  if ('pages' in result && Array.isArray(result.pages)) {
    return { pageCount: result.pages.length }
  }
  if ('found' in result && 'path' in result) {
    return {
      found: result.found,
      path: result.path,
      artifactId: result.artifactId ?? null,
      textLength: typeof result.text === 'string' ? result.text.length : 0,
    }
  }

  if ('messages' in result && Array.isArray(result.messages)) {
    return { messageCount: result.messages.length }
  }

  if ('count' in result && 'query' in result) {
    return { count: result.count, queryLength: result.query.length }
  }

  if ('users' in result && Array.isArray(result.users)) {
    return {
      userCount: result.users.length,
      roles: [...new Set(result.users.map((u) => u.role))],
    }
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

  if ('previewUrl' in result) return { previewUrl: result.previewUrl, contentHash: result.contentHash }
  if ('filename' in result && 'contentRef' in result) return { filename: result.filename, contentHash: result.contentHash, sizeBytes: result.sizeBytes }
  if ('appId' in result && 'status' in result && !('ticketId' in result)) return { appId: result.appId, status: result.status }
  if ('versionId' in result) return { versionId: result.versionId, version: result.version, status: result.status }

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

const ORCHESTRATOR_DELEGATION_TOOLS: ToolName[] = ['ticket_create', 'web_research_request']

/**
 * Az acting-user státusz-feloldása. Cserepont a determinisztikus teszteléshez
 * (G5 — suspended user), alapból a Postgres `users` táblát kérdezi.
 */
export type ActingUserLookup = (
  userId: string,
) => Promise<{ status: UserStatus } | null>

/**
 * A szerep-sablon (§3.5) tool-less invariánsának feloldása. Cserepont a
 * teszteléshez; alapból a `role_templates` táblát kérdezi (tenant-saját > rendszer).
 * Ha nincs sablon (pl. nem seedelt DB), a hívó a beégetett alapértelmezésre esik
 * vissza — orchestrator akkor is tool-less (sosem fail-open).
 */
export type RoleTemplateLookup = (
  key: AgentRole,
  tenantId: string | null,
) => Promise<{ toolAccessAllowed: boolean } | null>

const prismaRoleTemplateLookup: RoleTemplateLookup = async (key, tenantId) => {
  const templates = await prisma.roleTemplate.findMany({
    where: { key, OR: [{ tenantId }, { tenantId: null }] },
    select: { tenantId: true, toolAccessAllowed: true },
  })
  const tpl =
    templates.find((t) => t.tenantId === tenantId) ?? templates.find((t) => t.tenantId === null)
  return tpl ? { toolAccessAllowed: tpl.toolAccessAllowed } : null
}

/**
 * web_search kill-switch (Feature-spec — WebSearchTool §7.2, WS13). Cserepont a
 * teszteléshez; alapból a `platform_settings` táblát kérdezi.
 */
export type WebSearchEnabledLookup = () => Promise<boolean>
export type WebFetchEnabledLookup = () => Promise<boolean>
export type WebResearchDelegationEnabledLookup = () => Promise<boolean>

const prismaWebSearchEnabledLookup: WebSearchEnabledLookup = async () => {
  const row = await prisma.platformSetting.findUnique({ where: { key: WEB_SEARCH_CONTROLS_KEY } })
  const value = row?.value as { killSwitch?: boolean } | null
  return value?.killSwitch !== true
}

const prismaWebFetchEnabledLookup: WebFetchEnabledLookup = async () => {
  const row = await prisma.platformSetting.findUnique({ where: { key: 'web_fetch.controls' } })
  const value = row?.value as { enabled?: boolean } | null
  return value?.enabled === true
}

const prismaWebResearchDelegationEnabledLookup: WebResearchDelegationEnabledLookup = async () => {
  const row = await prisma.platformSetting.findUnique({ where: { key: 'web_egress.delegation.enabled' } })
  if (typeof row?.value === 'boolean') return row.value
  const value = row?.value as { enabled?: boolean } | null
  return value?.enabled === true
}

const prismaActingUserLookup: ActingUserLookup = async (userId) =>
  prisma.user.findUnique({ where: { id: userId }, select: { status: true } })

/**
 * user_directory feloldás — a tenant AKTÍV humán felhasználóit adja vissza a
 * hozzájuk rendelt szabad szöveges szereppel (`jobDescription`). Cserepont a
 * determinisztikus teszteléshez; alapból a Postgres `users` táblát kérdezi a hívó
 * tenantjára szűkítve (tenant-izoláció — sosem lát cross-tenant felhasználót).
 */
export type TenantUserDirectoryLookup = (
  tenantId: string | null,
) => Promise<UserDirectoryEntry[]>

const prismaTenantUserDirectoryLookup: TenantUserDirectoryLookup = async (tenantId) => {
  const rows = await prisma.user.findMany({
    where: { tenantId, status: 'active' },
    select: { id: true, name: true, email: true, role: true, jobDescription: true, status: true },
    orderBy: { name: 'asc' },
  })
  return rows.map((u) => ({
    userId: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    jobDescription: u.jobDescription,
    status: u.status,
  }))
}

export class AllowlistAuthorizer implements Authorizer {
  constructor(
    private tools: ToolBrokerRepository,
    private agents: AgentRepository,
    private grants: ConnectorGrantRepository,
    private lookupActingUser: ActingUserLookup = prismaActingUserLookup,
    private lookupRoleTemplate: RoleTemplateLookup = prismaRoleTemplateLookup,
  ) {}

  async authorize(input: {
    agentId: string
    tool: ToolName
    args?: Record<string, unknown>
    actingUserId?: string | null
    tenantId?: string | null
  }): Promise<AuthorizationResult> {
    const agent = await this.agents.findById(input.agentId)
    const effectiveTenantId = input.tenantId ?? agent?.tenantId ?? null
    if (agent?.tenantId && input.tenantId && agent.tenantId !== input.tenantId) {
      return { allowed: false, reason: 'tenant_isolation' }
    }

    let skipCapabilityCheck = false
    if (agent) {
      // §6: a Tool Broker ELSŐKÉNT a szerep-sablon `tool_access_allowed` mezőjét
      // nézi (adat-vezérelt, nem beégetett típus-elágazás). Ha nincs sablon (nem
      // seedelt DB), a beégetett alapértelmezésre esünk vissza — orchestrator akkor
      // is tool-less (defense-in-depth, sosem fail-open).
      const template = await this.lookupRoleTemplate(agent.role, effectiveTenantId)
      const toolAccessAllowed = template ? template.toolAccessAllowed : agent.role !== 'orchestrator'
      if (!toolAccessAllowed) {
        if (ORCHESTRATOR_DELEGATION_TOOLS.includes(input.tool)) {
          // Az orchestratornak nincs Tool Broker capability-sora (§3.5/I4), de
          // az egyetlen engedélyezett outbound művelete a ticket-nyitás.
          skipCapabilityCheck = true
        } else {
          return { allowed: false, reason: 'orchestrator_tool_less' }
        }
      }
    }

    if (!skipCapabilityCheck) {
      const capability = await this.tools.findCapability(input.agentId, input.tool)
      if (!capability?.allowed) {
        return { allowed: false, reason: 'capability_not_allowed' }
      }
    }

    if (input.tool === 'web_research_request') {
      return { allowed: true }
    }

    const requirement = TOOL_REQUIREMENTS[input.tool]
    if (!requirement) {
      return { allowed: false, reason: 'tool_not_configured' }
    }
    const requestedConnectorId =
      (input.tool === 'http_api_get' || input.tool === 'http_api_request' || input.tool === 'mailbox_count') &&
      typeof input.args?.connectorId === 'string'
        ? input.args.connectorId
        : null
    const link = requestedConnectorId
      ? await this.tools.findConnectorForAgentById(
          input.agentId,
          requestedConnectorId,
          requirement.connectorType,
          requirement.accessMode,
          effectiveTenantId,
        )
      : await this.tools.findConnectorForAgent(
          input.agentId,
          requirement.connectorType,
          requirement.accessMode,
          effectiveTenantId,
        )
    if (!link) {
      return {
        allowed: false,
        reason: requestedConnectorId
          ? `missing_${requirement.connectorType}_connector_${requirement.accessMode}_${requestedConnectorId}`
          : `missing_${requirement.connectorType}_connector_${requirement.accessMode}`,
      }
    }
    const { connector, agentSecretAlias } = link

    if (connector.tenantId !== null && connector.tenantId !== effectiveTenantId) {
      return { allowed: false, reason: 'tenant_isolation', connector }
    }

    // Provisioning §4.1 / P3 / PN5: egy draft (lifecycle_state != active) connector
    // a Tool Brokerben SOHA nem oldódik fel — egy fél kész draft nem futtatható élesben.
    if (connector.lifecycleState !== 'active') {
      return { allowed: false, reason: 'connector_not_active', connector }
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
        tenantId: connector.tenantId ?? effectiveTenantId,
        connectorId: connector.id,
        userId: input.actingUserId,
      })
      if (!grant) {
        return { allowed: false, reason: 'connector_grant_missing', connector }
      }

      if (
        connector.type === 'gmail' &&
        !gmailToolAllowedByScopes({
          tool: input.tool as Extract<ToolName, `gmail_${string}` | 'mailbox_count'>,
          args: input.args,
          scopes: grant.scopes,
        })
      ) {
        return { allowed: false, reason: 'gmail_scope_not_granted', connector }
      }

      return { allowed: true, connector, grant, actingUserId: input.actingUserId, agentSecretAlias }
    }

    return { allowed: true, connector, agentSecretAlias }
  }
}

export class ToolBrokerService {
  private static readonly AGENT_ANSWER_COMPLETION_STATES = new Set<string>([
    'done',
    'awaiting_human',
  ])

  private delegationProcessor: DelegationProcessor | null = null
  private playbookTransitioner: PlaybookTicketTransitioner | null = null

  constructor(
    private agents: AgentRepository,
    private tickets: TicketRepository,
    private tools: ToolBrokerRepository,
    private audit: AuditRepository,
    private ticketService: TicketService,
    private authorizer: Authorizer,
    private grantService: ConnectorGrantService,
    private fileEditor: FileEditorService,
    private sandboxApps: import('@/domain/sandbox/sandbox-app-service').SandboxAppService,
    private sandboxVersioning: import('@/domain/sandbox-versioning/sandbox-versioning-service').SandboxVersioningService,
    private webSearch: WebSearchService,
    private webSearchPolicy: WebSearchPolicyService,
    // KB-v3 §9.1/§10 — published OKF-chunk full-text retrieval + superseded (§10.5).
    private knowledgeChunks: KnowledgeChunkRepository,
    private knowledgeArtifacts: KnowledgeArtifactRepository,
    private isWebSearchEnabled: WebSearchEnabledLookup = prismaWebSearchEnabledLookup,
    private isWebFetchEnabled: WebFetchEnabledLookup = prismaWebFetchEnabledLookup,
    private isWebResearchDelegationEnabled: WebResearchDelegationEnabledLookup = prismaWebResearchDelegationEnabledLookup,
    private lookupTenantUserDirectory: TenantUserDirectoryLookup = prismaTenantUserDirectoryLookup,
  ) {}

  /** Chat agent_ask: szinkron feldolgozás (pl. WikiAgentRuntime.processTicket). */
  setDelegationProcessor(processor: DelegationProcessor | null): void {
    this.delegationProcessor = processor
  }

  /** A folyamat-ticketek állapotváltását a Playbook state machine-hez köti (l. board_write). */
  setPlaybookTransitioner(transitioner: PlaybookTicketTransitioner | null): void {
    this.playbookTransitioner = transitioner
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
          authorization.connector?.id ?? null,
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
        return this.recordDenied(input, ticketId, authorization.connector?.id ?? null, 'ticket_not_found', startedAt, actingUserId, authorization.grant?.id ?? null)
      }
      if (ticket.agentId !== input.agentId) {
        return this.recordDenied(
          input,
          ticketId,
          authorization.connector?.id ?? null,
          'ticket_not_accessible_for_agent',
          startedAt,
          actingUserId,
          authorization.grant?.id ?? null,
        )
      }
    }

    let webSearchEffective: WebSearchEffectiveQuery | undefined
    if (input.tool === 'web_search') {
      if (!authorization.connector) throw new Error('web_search requires connector authorization')
      const config = parseWebSearchConfig(authorization.connector.config)
      const [enabled, ticketQueryCount, agentDayQueryCount] = await Promise.all([
        this.isWebSearchEnabled(),
        ticketId ? this.tools.countToolCallsForTicket(ticketId, 'web_search') : Promise.resolve(0),
        this.tools.countToolCallsForAgentSince(
          input.agentId,
          'web_search',
          new Date(Date.now() - 24 * 60 * 60 * 1000),
        ),
      ])
      const decision = this.webSearchPolicy.authorize(input.args, config, {
        enabled,
        ticketQueryCount,
        agentDayQueryCount,
      })
      if (!decision.allowed) {
        return this.recordDenied(
          input,
          ticketId,
          authorization.connector?.id ?? null,
          decision.reason,
          startedAt,
          actingUserId,
          authorization.grant?.id ?? null,
        )
      }
      webSearchEffective = decision.effective
    }

    try {
      const result = await this.executeTool(
        input,
        authorization,
        actingTenantId,
        actingUserId,
        webSearchEffective,
      )
      const latencyMs = Date.now() - startedAt
      const meta = resultMeta(result)

      await this.recordCall({
        input,
        ticketId,
        connectorId: authorization.connector?.id ?? null,
        status: 'ok',
        latencyMs,
        policyDecision: 'allowed',
        resultMeta: meta,
        actingUserId,
        grantId: authorization.grant?.id ?? null,
        webSearchEffective,
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
        authorization.connector?.authMode === 'user_delegated' &&
        authorization.grant &&
        actingUserId
      ) {
        await this.grantService.markGrantExpired({
          grantId: authorization.grant.id,
          connectorId: authorization.connector.id,
          actingUserId,
          tenantId: actingTenantId ?? authorization.connector.tenantId ?? null,
          metadata: { reason: 'provider_auth_error', status: e.status } as Prisma.JsonValue,
        })
        return this.recordDenied(
          input,
          ticketId,
          authorization.connector?.id ?? null,
          'connector_grant_expired',
          startedAt,
          actingUserId,
          authorization.grant.id,
        )
      }

      await this.recordCall({
        input,
        ticketId,
        connectorId: authorization.connector?.id ?? null,
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
    actingUserId: string | null,
    webSearchEffective?: WebSearchEffectiveQuery,
  ) {
    if (input.tool === 'kb_search') {
      if (!authorization.connector) throw new Error('kb_search requires connector authorization')
      return this.kbSearch(input.agentId, input.args, authorization.connector)
    }
    if (input.tool === 'kb_list_index') {
      if (!authorization.connector) throw new Error('kb_list_index requires connector authorization')
      return this.kbListIndex(input.agentId, input.args, authorization.connector)
    }
    if (input.tool === 'kb_get_page') {
      if (!authorization.connector) throw new Error('kb_get_page requires connector authorization')
      return this.kbGetPage(input.agentId, input.args, authorization.connector)
    }
    if (input.tool === 'board_write') return this.boardWrite(input)
    if (input.tool === 'ticket_create') return this.ticketCreate(input, actingTenantId)
    if (input.tool === 'agent_ask') return this.agentAsk(input, actingTenantId)
    if (input.tool === 'web_research_request') return this.webResearchRequest(input)
    if (input.tool === 'agent_resolve') {
      return this.agentResolve(input.args, await this.resolveCallerTenantId(input, actingTenantId))
    }
    if (input.tool === 'agent_catalog') {
      return this.agentCatalog(input.args, await this.resolveCallerTenantId(input, actingTenantId))
    }
    if (input.tool === 'user_directory') return this.userDirectory(input, actingTenantId)

    if (input.tool === 'web_search') {
      if (!authorization.connector) throw new Error('web_search requires connector authorization')
      const config = parseWebSearchConfig(authorization.connector.config)
      // agent_owned módban az agentConnector.secretAlias az irányadó (per-agent
      // kulcs); egyébként a connector szintű megosztott kulcs (lásd http_api minta).
      const effectiveAlias =
        authorization.connector.authMode === 'agent_owned' && authorization.agentSecretAlias
          ? authorization.agentSecretAlias
          : authorization.connector.secretAlias
      const { result } = await this.webSearch.search(webSearchEffective!, config, effectiveAlias)
      return result
    }

    if (input.tool === 'http_api_get' || input.tool === 'http_api_request') {
      if (!authorization.connector) throw new Error(`${input.tool} requires connector authorization`)
      // user_delegated http_api (auto-consent oauth2): a per-user grant access
      // tokenjét injektáljuk Bearerként — NEM a connector secretAlias-át (az a
      // client_secret, sosem mehet ki bearerként).
      const delegatedAccessToken =
        authorization.connector.authMode === 'user_delegated'
          ? await this.resolveDelegatedAccessToken(input, authorization)
          : undefined
      return this.executeHttpApiTool(
        input,
        authorization.connector,
        actingTenantId,
        actingUserId,
        authorization.agentSecretAlias,
        delegatedAccessToken,
      )
    }

    if (input.tool === 'repo_prepare') {
      if (!authorization.connector) throw new Error('repo_prepare requires connector authorization')
      return this.repoPrepare(input, authorization.connector, actingTenantId)
    }

    if (input.tool === 'repo_open_pull_request') {
      if (!authorization.connector) throw new Error('repo_open_pull_request requires connector authorization')
      return this.repoOpenPullRequest(input, authorization.connector, actingTenantId)
    }

    if (
      input.tool.startsWith('file_') ||
      input.tool.startsWith('xlsx_') ||
      input.tool.startsWith('pdf_') ||
      input.tool === 'pptx_create' ||
      input.tool === 'docx_read' ||
      input.tool === 'create_html'
    ) {
      if (!authorization.connector) throw new Error(`${input.tool} requires connector authorization`)
      return this.executeFileTool(input, authorization.connector, actingTenantId)
    }

    if (input.tool.startsWith('sandbox_app.')) {
      return this.executeSandboxAppTool(input, actingTenantId)
    }

    if (
      input.tool === 'sandbox.commit' ||
      input.tool === 'sandbox.request_promotion' ||
      input.tool === 'sandbox.snapshot'
    ) {
      return this.executeSandboxVersioningTool(input, actingTenantId)
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
    if (input.tool === 'mailbox_count') {
      const query = input.args.query ?? ''
      const res = await gmail.count({
        query,
        labelIds: input.args.labelIds,
        includeSpamTrash: input.args.includeSpamTrash,
      })
      return { count: res.count, query }
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
    actingTenantId: string | null,
    actingUserId: string | null,
    agentSecretAlias?: string | null,
    delegatedAccessToken?: string,
  ): Promise<HttpApiCallResult> {
    const config = parseHttpApiConfig(connector.config)
    // user_delegated (auto-consent oauth2): a per-user grant access token megy ki
    // Bearerként (config.auth = bearer). A connector secretAlias ilyenkor a
    // client_secret-et rejti, ezt SOHA nem oldjuk fel apiKey-ként.
    // agent_owned módban az agentConnector.secretAlias az irányadó (per-agent kulcs);
    // egyébként a connector szintű megosztott kulcs kerül felhasználásra.
    const effectiveAlias =
      connector.authMode === 'agent_owned' && agentSecretAlias
        ? agentSecretAlias
        : connector.secretAlias
    const defaultApiKey = delegatedAccessToken
      ? delegatedAccessToken
      : effectiveAlias
        ? await resolveConnectorApiKey(effectiveAlias)
        : undefined
    const client = new HttpApiClient(config, {
      defaultApiKey,
      resolveProfileApiKey: (_profile, secretAlias) => resolveConnectorApiKey(secretAlias),
    })
    const callId = randomUUID()
    const actingUser = actingUserId
      ? await prisma.user.findUnique({
          where: { id: actingUserId },
          select: { id: true, email: true, tenantId: true },
        })
      : null
    const context = {
      agent: { id: input.agentId, version: input.agentVersion },
      connector: { id: connector.id, name: connector.name },
      actingUser,
      tenant: actingTenantId ? { id: actingTenantId } : null,
      call: { id: callId, idempotencyKey: callId },
      now: { iso: new Date().toISOString() },
    }

    if (input.tool === 'http_api_get') {
      return client.request({
        method: 'GET',
        path: input.args.path,
        query: input.args.query,
        context,
      })
    }
    return client.request({
      method: input.args.method,
      path: input.args.path,
      query: input.args.query,
      body: input.args.body,
      context,
    })
  }

  private async repoPrepare(
    input: Extract<ToolBrokerInvokeInput, { tool: 'repo_prepare' }>,
    workspaceConnector: Connector,
    actingTenantId: string | null,
  ): Promise<RepoPrepareResult> {
    const workspaceId = input.ticketId ?? input.conversationId
    if (!workspaceId) throw new Error('repo_prepare requires a ticketId or conversationId')

    const agent = await this.agents.findById(input.agentId)
    if (!agent) throw new Error('repo_prepare agent not found')

    const target = resolveRepoTarget(input.args, agent)
    const token = await this.resolveGitHubTokenForAgent(input.agentId)
    const repoInfo = await this.githubJson<GitHubRepoResponse>(
      `/repos/${target.owner}/${target.repo}`,
      token,
    )
    const ref = target.ref ?? repoInfo.default_branch ?? 'main'
    const commit = await this.githubJson<GitHubCommitResponse>(
      `/repos/${target.owner}/${target.repo}/commits/${encodeURIComponent(ref)}`,
      token,
    )
    const commitSha = commit.sha
    const treeSha = commit.commit?.tree?.sha ?? commitSha

    const tenantId = actingTenantId ?? workspaceConnector.tenantId ?? 'global'
    const existingMetadata = decodeRepoMetadata(
      await this.fileEditor.readTextFileOrNull(tenantId, workspaceId, { path: REPO_METADATA_PATH }),
    )
    if (
      !input.args.forceRefresh &&
      existingMetadata?.owner === target.owner &&
      existingMetadata.repo === target.repo &&
      existingMetadata.ref === ref &&
      existingMetadata.commitSha === commitSha
    ) {
      return {
        ok: true,
        repoPath: REPO_WORKSPACE_PATH,
        status: 'already_current',
        owner: target.owner,
        repo: target.repo,
        ref,
        commitSha,
        filesIndexed: existingMetadata.filesIndexed ?? 0,
        filesWritten: 0,
        filesSkipped: 0,
        bytesWritten: existingMetadata.bytesWritten ?? 0,
        metadataPath: REPO_METADATA_PATH,
        nextSteps: repoPrepareNextSteps(),
      }
    }

    const tree = await this.githubJson<GitHubTreeResponse>(
      `/repos/${target.owner}/${target.repo}/git/trees/${treeSha}?recursive=1`,
      token,
    )
    if (tree.truncated) {
      throw new Error('repo_prepare GitHub tree is truncated; narrow the repo/ref or raise import limits')
    }

    const current = await this.fileEditor.listFiles(tenantId, workspaceId, {
      path: REPO_WORKSPACE_PATH,
      recursive: true,
    })
    await Promise.all(
      current.entries
        .filter((entry) => entry.type === 'file')
        .map((entry) => this.fileEditor.deleteFile(tenantId, workspaceId, { path: entry.path })),
    )

    const blobs = tree.tree.filter((item) => item.type === 'blob')
    const candidates = blobs
      .filter((item) => !shouldSkipRepoPath(item.path, item.size ?? 0))
      .slice(0, REPO_IMPORT_MAX_FILES)
    let filesWritten = 0
    let filesSkipped = blobs.length - candidates.length
    let bytesWritten = 0
    let nextIndex = 0

    const importOne = async (item: GitHubTreeItem) => {
      if (bytesWritten >= REPO_IMPORT_MAX_TOTAL_BYTES) {
        filesSkipped += 1
        return
      }
      const blob = await this.githubJson<GitHubBlobResponse>(
        `/repos/${target.owner}/${target.repo}/git/blobs/${item.sha}`,
        token,
      )
      if (blob.encoding !== 'base64') {
        filesSkipped += 1
        return
      }
      const buffer = Buffer.from(blob.content.replace(/\s+/g, ''), 'base64')
      if (buffer.length > REPO_IMPORT_MAX_FILE_BYTES || !assertUtf8Text(buffer)) {
        filesSkipped += 1
        return
      }
      if (bytesWritten + buffer.length > REPO_IMPORT_MAX_TOTAL_BYTES) {
        filesSkipped += 1
        return
      }
      await this.fileEditor.writeFile(tenantId, workspaceId, {
        path: `${REPO_WORKSPACE_PATH}/${item.path}`,
        content: buffer.toString('utf8'),
      })
      bytesWritten += buffer.length
      filesWritten += 1
    }

    const worker = async () => {
      while (nextIndex < candidates.length) {
        const item = candidates[nextIndex]
        nextIndex += 1
        await importOne(item)
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, () => worker()))

    const metadata: RepoPrepareMetadata = {
      owner: target.owner,
      repo: target.repo,
      ref,
      commitSha,
      repoPath: REPO_WORKSPACE_PATH,
      filesIndexed: filesWritten,
      bytesWritten,
      preparedAt: new Date().toISOString(),
    }
    await this.fileEditor.writeFile(tenantId, workspaceId, {
      path: REPO_METADATA_PATH,
      content: JSON.stringify(metadata, null, 2),
    })

    return {
      ok: true,
      repoPath: REPO_WORKSPACE_PATH,
      status: 'updated',
      owner: target.owner,
      repo: target.repo,
      ref,
      commitSha,
      filesIndexed: filesWritten,
      filesWritten,
      filesSkipped,
      bytesWritten,
      metadataPath: REPO_METADATA_PATH,
      nextSteps: repoPrepareNextSteps(),
    }
  }

  /**
   * Branch létrehozása + commit + PR megnyitása a `repo_prepare`-rel importált
   * workspace-klón és a jelenlegi bázisref FRISS állása közti diffből. A
   * diff-bázis szándékosan az import-kori snapshot (metadata.commitSha), NEM a
   * friss head — így csak a ténylegesen file_edit/file_write/file_delete-elt
   * fájlok kerülnek be, a commit/tree bázisa viszont a friss head-ről ágazik,
   * hogy ne írjunk felül közben történt remote változásokat.
   */
  private async repoOpenPullRequest(
    input: Extract<ToolBrokerInvokeInput, { tool: 'repo_open_pull_request' }>,
    workspaceConnector: Connector,
    actingTenantId: string | null,
  ): Promise<RepoOpenPullRequestResult> {
    const workspaceId = input.ticketId ?? input.conversationId
    if (!workspaceId) throw new Error('repo_open_pull_request requires a ticketId or conversationId')

    const tenantId = actingTenantId ?? workspaceConnector.tenantId ?? 'global'
    const metadata = decodeRepoMetadata(
      await this.fileEditor.readTextFileOrNull(tenantId, workspaceId, { path: REPO_METADATA_PATH }),
    )
    if (!metadata) {
      throw new Error(
        'repo_open_pull_request requires a prior repo_prepare in this workspace (no .repo_prepare.json found)',
      )
    }

    const token = await this.resolveGitHubTokenForAgent(input.agentId)
    const baseRef = input.args.baseRef ?? metadata.ref

    const importedTree = await this.githubJson<GitHubTreeResponse>(
      `/repos/${metadata.owner}/${metadata.repo}/git/trees/${metadata.commitSha}?recursive=1`,
      token,
    )
    if (importedTree.truncated) {
      throw new Error('repo_open_pull_request: imported GitHub tree is truncated; cannot diff reliably')
    }
    const originalShaByPath = new Map(
      importedTree.tree.filter((item) => item.type === 'blob').map((item) => [item.path, item.sha]),
    )

    const prefix = `${REPO_WORKSPACE_PATH}/`
    const current = await this.fileEditor.listFiles(tenantId, workspaceId, {
      path: REPO_WORKSPACE_PATH,
      recursive: true,
    })
    const currentRelPaths = current.entries
      .filter((entry) => entry.type === 'file' && entry.path !== REPO_METADATA_PATH)
      .map((entry) => entry.path.slice(prefix.length))

    const changes: Array<{ path: string; content: Buffer | null }> = []
    for (const relPath of currentRelPaths) {
      const buf = await this.fileEditor.readRawFile(tenantId, workspaceId, { path: `${prefix}${relPath}` })
      if (!buf) continue
      if (originalShaByPath.get(relPath) !== gitBlobSha1(buf)) {
        changes.push({ path: relPath, content: buf })
      }
    }
    const currentRelSet = new Set(currentRelPaths)
    for (const relPath of originalShaByPath.keys()) {
      if (!currentRelSet.has(relPath)) changes.push({ path: relPath, content: null })
    }

    if (changes.length === 0) {
      return {
        ok: true,
        changed: false,
        message:
          'Nincs változás a repo workspace-ben a legutóbbi repo_prepare óta — nincs mit commitolni/PR-ezni.',
      }
    }

    const baseCommit = await this.githubJson<GitHubCommitResponse>(
      `/repos/${metadata.owner}/${metadata.repo}/commits/${encodeURIComponent(baseRef)}`,
      token,
    )
    const baseHeadSha = baseCommit.sha
    const baseHeadTreeSha = baseCommit.commit?.tree?.sha ?? baseHeadSha

    const treeEntries = changes.map((change) =>
      change.content
        ? { path: change.path, mode: '100644', type: 'blob', content: change.content.toString('utf8') }
        : { path: change.path, mode: '100644', type: 'blob', sha: null },
    )
    const newTree = await this.githubRequestJson<{ sha: string }>(
      `/repos/${metadata.owner}/${metadata.repo}/git/trees`,
      token,
      'POST',
      { base_tree: baseHeadTreeSha, tree: treeEntries },
    )
    const newCommit = await this.githubRequestJson<{ sha: string }>(
      `/repos/${metadata.owner}/${metadata.repo}/git/commits`,
      token,
      'POST',
      { message: input.args.title, tree: newTree.sha, parents: [baseHeadSha] },
    )
    const branch = await this.createRepoBranch(
      metadata.owner,
      metadata.repo,
      token,
      input.args.branch,
      newCommit.sha,
    )
    const pr = await this.githubRequestJson<{ html_url: string; number: number }>(
      `/repos/${metadata.owner}/${metadata.repo}/pulls`,
      token,
      'POST',
      {
        title: input.args.title,
        body: input.args.body ?? '',
        head: branch,
        base: baseRef,
        draft: input.args.draft ?? false,
      },
    )

    return {
      ok: true,
      changed: true,
      owner: metadata.owner,
      repo: metadata.repo,
      baseRef,
      branch,
      commitSha: newCommit.sha,
      pullRequestUrl: pr.html_url,
      pullRequestNumber: pr.number,
      filesChanged: changes.length,
      changedPaths: changes.map((c) => c.path).sort(),
    }
  }

  private async createRepoBranch(
    owner: string,
    repo: string,
    token: string | null,
    requestedBranch: string | undefined,
    commitSha: string,
  ): Promise<string> {
    const base = requestedBranch?.trim() || `agent/pr-${Date.now().toString(36)}`
    let candidate = base
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'enterprise-ai-agent-platform',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ref: `refs/heads/${candidate}`, sha: commitSha }),
      })
      if (res.ok) return candidate
      if (res.status !== 422) {
        const detail = await res.text().catch(() => '')
        throw new Error(`GitHub API failed creating branch: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
      }
      candidate = `${base}-${attempt + 2}`
    }
    throw new Error('repo_open_pull_request: could not allocate a free branch name (too many collisions)')
  }

  private async githubJson<T>(path: string, token: string | null): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'enterprise-ai-agent-platform',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
    if (!res.ok) {
      throw new Error(`GitHub API failed: HTTP ${res.status}`)
    }
    return (await res.json()) as T
  }

  private async githubRequestJson<T>(
    path: string,
    token: string | null,
    method: 'POST' | 'PATCH',
    body: unknown,
  ): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'enterprise-ai-agent-platform',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`GitHub API failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
    }
    return (await res.json()) as T
  }

  private async resolveGitHubTokenForAgent(agentId: string): Promise<string | null> {
    const connectors = await this.tools.findConnectorsForAgent(agentId)
    const github = connectors.find(({ connector }) => {
      if (connector.type !== 'http_api') return false
      const config = isRecord(connector.config) ? connector.config : {}
      const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : ''
      const provider = typeof config.provider === 'string' ? config.provider.toLowerCase() : ''
      return provider.includes('github') || baseUrl.includes('api.github.com')
    })
    if (!github) return null
    const alias = github.agentSecretAlias ?? github.connector.secretAlias
    return alias ? resolveConnectorApiKey(alias) : null
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
      if (input.tool === 'create_html') return this.fileEditor.createHtml(tenantId, workspaceId, input.args)
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
      if (input.tool === 'pptx_create') return this.fileEditor.pptxCreate(tenantId, workspaceId, input.args)
    } catch (e) {
      if (e instanceof FileEditorError) {
        throw new Error(`${e.code}: ${e.message}`)
      }
      throw e
    }
    throw new Error(`Unknown file tool: ${input.tool}`)
  }

  private async executeSandboxAppTool(
    input: ToolBrokerInvokeInput,
    actingTenantId: string | null,
  ): Promise<SandboxAppCreateResult | SandboxAppUpdateArtifactResult | SandboxAppPreviewResult | SandboxAppExportResult> {
    const actor = { agentId: input.agentId, tenantId: actingTenantId }

    if (input.tool === 'sandbox_app.create') {
      const a = input.args as SandboxAppCreateArgs
      return this.sandboxApps.createSandboxApp(
        {
          name: a.name,
          description: a.description,
          criticality: a.criticality ?? 'L1',
          createdFromTicketId: a.createdFromTicketId ?? input.ticketId,
        },
        actor,
      )
    }

    if (input.tool === 'sandbox_app.update_artifact') {
      const a = input.args as SandboxAppUpdateArtifactArgs
      const result = await this.sandboxApps.upsertSandboxAppVersion(
        {
          appId: a.appId,
          html: a.html,
          changeSummary: a.changeSummary,
          activate: a.activate ?? true,
          sourceTicketId: input.ticketId,
        },
        actor,
      )
      const { validationResult, ...safe } = result
      return {
        ...safe,
        validationResult: {
          status: (validationResult as { status?: string }).status,
          warnings: (validationResult as { warnings?: string[] }).warnings ?? [],
        },
      }
    }

    if (input.tool === 'sandbox_app.preview') {
      const a = input.args as SandboxAppPreviewArgs
      return this.sandboxApps.getSandboxAppPreviewUrl(
        { appId: a.appId, version: a.version },
        actor,
      )
    }

    if (input.tool === 'sandbox_app.export') {
      const a = input.args as SandboxAppExportArgs
      return this.sandboxApps.exportSandboxApp(
        { appId: a.appId, version: a.version },
        actor,
      )
    }

    throw new Error(`Unknown sandbox_app tool: ${(input as { tool: string }).tool}`)
  }

  /**
   * Sandbox verziózás agent-toolok (SandboxVersioning-Graduation §5). Az agent
   * commitolhat, javasolhat promóciót és `test`-env snapshotot készíthet. A
   * SandboxVersioningService kikényszeríti, hogy az agent SOHA ne promótálhasson,
   * exportálhasson vagy live adathoz nyúljon — ezekhez nincs capability sem (§5.1).
   */
  private async executeSandboxVersioningTool(
    input: ToolBrokerInvokeInput & {
      tool: 'sandbox.commit' | 'sandbox.request_promotion' | 'sandbox.snapshot'
    },
    actingTenantId: string | null,
  ): Promise<SandboxCommitResult | SandboxRequestPromotionResult | SandboxSnapshotResult> {
    const actor = { agentId: input.agentId, tenantId: actingTenantId, agentVersion: input.agentVersion }

    if (input.tool === 'sandbox.commit') {
      const a = input.args as SandboxCommitArgs
      return this.sandboxVersioning.createSandboxCommit(
        {
          projectId: a.projectId,
          files: a.files,
          changeSummary: a.changeSummary,
          createdFromTicketId: a.createdFromTicketId ?? input.ticketId,
        },
        actor,
      )
    }

    if (input.tool === 'sandbox.request_promotion') {
      const a = input.args as SandboxRequestPromotionArgs
      return this.sandboxVersioning.requestPromotion({ projectId: a.projectId, reason: a.reason }, actor)
    }

    // sandbox.snapshot — az agentnek KIZÁRÓLAG `test` env (§5.1).
    const a = input.args as SandboxSnapshotArgs
    return this.sandboxVersioning.createDataSnapshot(
      { projectId: a.projectId, env: 'test', label: a.label },
      actor,
    )
  }

  private async resolveDelegatedAccessToken(
    input: ToolBrokerInvokeInput,
    authorization: Extract<AuthorizationResult, { allowed: true }>,
  ): Promise<string> {
    if (!authorization.connector) throw new Error('delegated_access_token_requires_connector')
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
      tenantId: (await this.resolveActingTenantId(actingUserId)) ?? authorization.connector.tenantId ?? null,
    })
  }

  private async resolveActingUserId(input: ToolBrokerInvokeInput): Promise<string | null> {
    const effectiveTicketId = input.tool === 'board_write' ? input.args.ticketId : input.ticketId
    if (effectiveTicketId) {
      const ticket = await this.tickets.findById(effectiveTicketId)
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

  /**
   * A hívó agent effektív tenant-kontextusa a tenant-izolációs döntésekhez
   * (agent felderítés/delegálás). A cselekvő felhasználó tenantja az elsődleges,
   * különben a hívó agent saját tenantja — a `user_directory` feloldásával
   * megegyező minta, hogy a humán- és az agent-directory ugyanazon a tenant-határon
   * lásson.
   */
  private async resolveCallerTenantId(
    input: ToolBrokerInvokeInput,
    actingTenantId: string | null,
  ): Promise<string | null> {
    if (actingTenantId) return actingTenantId
    const agent = await this.agents.findById(input.agentId)
    return agent?.tenantId ?? null
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

  /**
   * §4.9.1 / D-B: az agenthez kötött ÖSSZES knowledge_base connector a scope —
   * a retrieval (kb_search és a navigáció is) ezek unióján dolgozik, nem csak az
   * authorizált egyen. Ha nincs linkelt KB, az authorizált connector a fallback.
   */
  private async resolveKbConnectorScope(agentId: string, connector: Connector): Promise<string[]> {
    const linkedKbConnectorIds = (await this.tools.findConnectorsForAgent(agentId))
      .filter((link) => link.connector.type === 'knowledge_base')
      .map((link) => link.connector.id)
    return linkedKbConnectorIds.length > 0 ? linkedKbConnectorIds : [connector.id]
  }

  private async kbSearch(
    agentId: string,
    args: KbSearchArgs,
    connector: Connector,
  ): Promise<KbSearchResult> {
    const detail = await this.agents.findByIdWithDetails(agentId)
    if (!detail) throw new Error('Agent not found')

    const k = args.k ?? 5

    const connectorIds = await this.resolveKbConnectorScope(agentId, connector)

    const [okfChunkHits, supersededList, documentLists] = await Promise.all([
      this.knowledgeChunks.searchChunks({ connectorIds, query: args.query, limit: k }),
      this.knowledgeArtifacts.publishedSourceDocumentIds(connectorIds),
      Promise.all(connectorIds.map((id) => this.tools.findDocumentsForConnector(id))),
    ])

    const hits = assembleKbHits({
      query: args.query,
      k,
      memoryContent: detail.memoryContent ?? '',
      memoryId: detail.agent.memoryId,
      memoryVersion: detail.memoryVersion,
      okfChunkHits,
      docs: documentLists.flat(),
      supersededDocIds: new Set(supersededList),
    })

    return { hits }
  }

  /** §9.3 — az agent scope-jában elérhető published OKF-oldalak listája (navigáció). */
  private async kbListIndex(
    agentId: string,
    args: KbListIndexArgs,
    connector: Connector,
  ): Promise<KbListIndexResult> {
    const connectorIds = await this.resolveKbConnectorScope(agentId, connector)
    const entries = await this.knowledgeChunks.listIndex({
      connectorIds,
      pathPrefix: args.pathPrefix,
    })
    return assembleKbIndex(entries, args.maxDepth)
  }

  /** §9.2 — egy published OKF-oldal teljes tartalma + forrás-link (navigáció). */
  private async kbGetPage(
    agentId: string,
    args: KbGetPageArgs,
    connector: Connector,
  ): Promise<KbGetPageResult> {
    const connectorIds = await this.resolveKbConnectorScope(agentId, connector)
    const chunks = await this.knowledgeChunks.getPageChunks({
      connectorIds,
      path: args.path,
      artifactId: args.artifactId,
    })
    return assembleKbPage(args.path, chunks)
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

    let result: BoardWriteResult

    // Folyamat-lépés lezárása a Playbook state machine-en át: a kötelező kapuk és
    // az output-szerződés kikényszerülnek, és a ProcessService.advance tovább-lépteti
    // a Futást. A payload+state itt EGY átmenetben megy (a state machine az
    // outputPayload-ot merge-öli és a szerződés ellen ellenőrzi) — ezért NEM írjuk
    // meg előre a payloadot. Ha nincs bekötve a handler, a legacy útra esünk vissza.
    const isProcessTicket = Boolean(
      ticket.processInstanceId && ticket.playbookVersionId && ticket.playbookStepId,
    )
    if (
      this.playbookTransitioner &&
      isProcessTicket &&
      input.args.patch.state &&
      input.args.patch.state !== ticket.state
    ) {
      await this.playbookTransitioner.transitionTicket({
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
        toState: input.args.patch.state,
        actor: { type: 'agent', id: input.agentId },
        outputPayload: input.args.patch.payload,
      })
      const fresh = await this.tickets.findById(ticket.id)
      result = { ok: true, ticketId: ticket.id, state: fresh?.state ?? input.args.patch.state }
    } else {
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

      result = { ok: true, ticketId: current.id, state: current.state }
    }

    await this.maybeRecordAgentAnswerComment({
      ticketId: ticket.id,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
    })

    return result
  }

  /** Goose/board_write útvonal: agent-válasz a ticket-szálba (outputContract mezőkkel is). */
  private async maybeRecordAgentAnswerComment(input: {
    ticketId: string
    agentId: string
    agentVersion: number
  }): Promise<void> {
    const ticket = await this.tickets.findById(input.ticketId)
    if (!ticket || ticket.agentId !== input.agentId) return
    if (!ToolBrokerService.AGENT_ANSWER_COMPLETION_STATES.has(ticket.state)) return

    const payload = isRecord(ticket.payload) ? ticket.payload : {}
    const body = extractAgentAnswerDisplayBody(payload)
    if (!body) return

    const existing = await this.tickets.listComments(input.ticketId)
    const lastAgent = [...existing].reverse().find((comment) => comment.kind === 'agent_answer')
    if (lastAgent && lastAgent.body.trim() === body.trim()) return

    const agent = await this.agents.findById(input.agentId)
    await this.tickets.appendComment({
      ticketId: input.ticketId,
      kind: 'agent_answer',
      authorType: 'agent',
      authorAgentId: input.agentId,
      authorDisplayName: agent?.name ?? 'Agent',
      agentVersion: input.agentVersion,
      body,
      structured: agentAnswerStructuredFromPayload(payload) as Prisma.JsonObject,
    })
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
    actingTenantId: string | null,
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
      // Tenant-izoláció: a feladat a szülő-ticket (különben a cselekvő felhasználó)
      // tenantjában jön létre; cross-tenant agenthez SOHA nem rendelünk ticketet.
      // Ez az agent-felelős párja a humán-felelős ág alábbi tenant-ellenőrzésének.
      const assigneeRefTenantId =
        (input.ticketId ? (await this.tickets.findById(input.ticketId))?.tenantId ?? null : null) ??
        actingTenantId
      if (!isAgentReachableFromTenant(assignee.tenantId, assigneeRefTenantId)) {
        throw new Error('Assignee agent is not reachable from this tenant')
      }
    }
    // Humán felelős (a user_directory-ból): ha az agent egy konkrét humán
    // userId-t ad, validáljuk (létező, aktív, azonos tenant) és a ticketre
    // kötjük — így a feladat egy NEVESÍTETT emberhez kerül, nem csak a "human"
    // várólistára. Érvénytelen/ismeretlen id némán null (a ticket attól még
    // awaiting_human-ra megy).
    let humanAssigneeId: string | null = null
    if (args.assigneeType === 'human' && args.assigneeId && UUID_RE.test(args.assigneeId)) {
      const parentTenantId = input.ticketId
        ? (await this.tickets.findById(input.ticketId))?.tenantId ?? null
        : null
      const candidate = await prisma.user.findUnique({
        where: { id: args.assigneeId },
        select: { id: true, status: true, tenantId: true },
      })
      if (candidate && candidate.status === 'active' && candidate.tenantId === parentTenantId) {
        humanAssigneeId = candidate.id
      }
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
      assigneeId: args.assigneeType === 'agent' ? args.assigneeId! : humanAssigneeId,
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
    actingTenantId: string | null,
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

    // Tenant-izoláció: a delegálás-ticket a szülő-ticket (különben a cselekvő
    // felhasználó) tenantjában jön létre; cross-tenant agentnek SOHA nem delegálunk.
    const parentTenantId = input.ticketId
      ? (await this.tickets.findById(input.ticketId))?.tenantId ?? null
      : null
    const effectiveTenantId = parentTenantId ?? actingTenantId
    if (!isAgentReachableFromTenant(target.tenantId, effectiveTenantId)) {
      throw new Error('Target agent is not reachable from this tenant')
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
      tenantId: parentTenantId,
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

  private async webResearchRequest(
    input: Extract<ToolBrokerInvokeInput, { tool: 'web_research_request' }>,
  ): Promise<WebResearchDelegationResult> {
    const objective = input.args.objective.trim()
    if (!objective) throw new Error('objective is required')

    const requester = await this.agents.findById(input.agentId)
    const requesterVersion = requester?.currentVersion ?? input.agentVersion
    const objectiveHash = createHash('sha256').update(objective).digest('hex').slice(0, 16)

    if (!(await this.isWebResearchDelegationEnabled())) {
      await this.auditWebResearchBlocked(input.agentId, requesterVersion, 'delegation_disabled', { objectiveHash })
      return { ok: false, error: 'delegation_disabled' }
    }
    if (!(await this.isWebFetchEnabled())) {
      await this.auditWebResearchBlocked(input.agentId, requesterVersion, 'web_fetch_disabled', { objectiveHash })
      return { ok: false, error: 'web_fetch_disabled' }
    }

    const maxPerRequesterDay =
      Number(process.env.WEB_RESEARCH_MAX_PER_REQUESTER_DAY) > 0
        ? Number(process.env.WEB_RESEARCH_MAX_PER_REQUESTER_DAY)
        : 20
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const requesterDayUsed = await prisma.auditLog
      .count({
        where: {
          action: 'agent.web_research.requested',
          actorId: input.agentId,
          createdAt: { gte: since },
        },
      })
      .catch(() => 0)
    if (requesterDayUsed >= maxPerRequesterDay) {
      await this.auditWebResearchBlocked(input.agentId, requesterVersion, 'requester_daily_limit', { objectiveHash })
      return { ok: false, error: 'requester_daily_limit' }
    }

    const egressAgent = await this.resolveWebEgressAgent(requester?.tenantId ?? null)
    if (!egressAgent) {
      await this.auditWebResearchBlocked(input.agentId, requesterVersion, 'web_egress_agent_missing', { objectiveHash })
      return { ok: false, error: 'web_egress_agent_missing' }
    }

    const allowedSourceTypes = this.resolveResearchSourceTypes(input.args.allowedSourceTypes)
    await this.audit.append({
      actorType: 'agent',
      actorId: input.agentId,
      agentVersion: requesterVersion,
      action: 'agent.web_research.requested',
      targetType: 'web_research',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: {
        requesterAgentId: input.agentId,
        egressRoleAgentId: egressAgent.id,
        objectiveHash,
        contractVersion: 'web_research/v1',
        allowedSourceTypes,
      } as Prisma.JsonValue,
    })

    const maxSources = Math.max(
      1,
      Math.min(
        Number(input.args.maxSources) > 0 ? Math.floor(Number(input.args.maxSources)) : 4,
        Number(process.env.WEB_RESEARCH_MAX_SOURCES) > 0 ? Number(process.env.WEB_RESEARCH_MAX_SOURCES) : 8,
      ),
    )
    const query = input.args.knownDomain ? `${objective} site:${input.args.knownDomain}` : objective
    const search = await this.invoke({
      agentId: egressAgent.id,
      agentVersion: egressAgent.currentVersion,
      tool: 'web_search',
      args: { query, maxResults: maxSources * 2, purpose: 'web_research_request' },
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.ticketId ? { ticketId: input.ticketId } : {}),
      ...(input.actingUserId ? { actingUserId: input.actingUserId } : {}),
    })
    if (search.denied) {
      await this.auditWebResearchBlocked(egressAgent.id, egressAgent.currentVersion, 'NO_TRUSTED_SOURCE', {
        requesterAgentId: input.agentId,
        reason: search.reason,
        objectiveHash,
      })
      return { ok: false, error: 'NO_TRUSTED_SOURCE' }
    }

    const registry = new KnownUrlRegistry()
    const searchResult = search.result as WebSearchResult
    const usable = searchResult.results
      .filter((r) => this.isResearchSourceType(r.sourceType) && allowedSourceTypes.includes(r.sourceType))
      .slice(0, maxSources)
    if (usable.length === 0) {
      await this.auditWebResearchBlocked(egressAgent.id, egressAgent.currentVersion, 'NO_TRUSTED_SOURCE', {
        requesterAgentId: input.agentId,
        objectiveHash,
      })
      return { ok: false, error: 'NO_TRUSTED_SOURCE' }
    }

    const fetchedAt = new Date().toISOString()
    const sources = usable.map((source) => {
      registry.add(source.url, source.sourceType)
      const statementSeed = `${source.title}\n${source.snippet}`
      return {
        urlHash: createHash('sha256').update(source.url).digest('hex').slice(0, 16),
        host: source.domain.toLowerCase(),
        sourceType: source.sourceType as WebResearchSourceType,
        contentHash: createHash('sha256').update(statementSeed).digest('hex').slice(0, 16),
        fetchedAt,
      }
    })
    const facts = usable.map((source, index) => ({
      statement: `${source.title}: ${source.snippet}`.replace(/\s+/g, ' ').trim().slice(0, 1000),
      sourceIndices: [index],
      confidence: source.sourceType === 'official' || source.sourceType === 'vendor_doc' ? 'medium' as const : 'low' as const,
    }))
    const hasUnverified = sources.some((source) => source.sourceType === 'news' || source.sourceType === 'blog')
    const candidate: WebResearchResult = {
      objectiveEcho: objective.slice(0, 500),
      facts,
      sources,
      overallConfidence: hasUnverified ? 'medium' : 'medium',
      unverified: hasUnverified,
      provenance: {
        egressRoleAgentId: egressAgent.id,
        egressRoleAgentVersion: egressAgent.currentVersion,
        requesterAgentId: input.agentId,
        queryHash: objectiveHash,
        contractVersion: 'web_research/v1',
      },
    }

    const validation = validateWebResearchResult(candidate, {
      knownHosts: registry.hosts(),
      maxFacts: Number(process.env.WEB_RESEARCH_MAX_FACTS) > 0 ? Number(process.env.WEB_RESEARCH_MAX_FACTS) : 20,
      maxSources,
    })
    if (validation.status === 'failed') {
      await this.auditWebResearchBlocked(egressAgent.id, egressAgent.currentVersion, 'RESEARCH_VALIDATION_FAILED', {
        requesterAgentId: input.agentId,
        objectiveHash,
        errors: validation.errors,
      })
      return { ok: false, error: 'RESEARCH_VALIDATION_FAILED' }
    }

    const sourceHistogram: Record<string, number> = {}
    for (const source of validation.result.sources) {
      sourceHistogram[source.sourceType] = (sourceHistogram[source.sourceType] ?? 0) + 1
    }
    await this.audit.append({
      actorType: 'agent',
      actorId: egressAgent.id,
      agentVersion: egressAgent.currentVersion,
      action: 'agent.web_research.completed',
      targetType: 'web_research',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: validation.status === 'warned' ? 'warned' : 'allowed',
      metadata: {
        requesterAgentId: input.agentId,
        sourceCount: validation.result.sources.length,
        factCount: validation.result.facts.length,
        sourceHistogram,
        overallConfidence: validation.result.overallConfidence,
        unverified: validation.result.unverified,
        contractVersion: 'web_research/v1',
      } as Prisma.JsonValue,
    })

    return { ok: true, result: validation.result }
  }

  private async resolveWebEgressAgent(tenantId: string | null) {
    const candidates = await this.agents.findMany({ tenantId })
    for (const agent of candidates.filter((a) => a.status === 'active')) {
      const [searchCap, fetchCap] = await Promise.all([
        this.tools.findCapability(agent.id, 'web_search'),
        this.tools.findCapability(agent.id, 'web_fetch'),
      ])
      if (searchCap?.allowed && fetchCap?.allowed) return agent
    }
    return null
  }

  private resolveResearchSourceTypes(requested?: WebResearchSourceType[]): WebResearchSourceType[] {
    const bankPreset = process.env.PROVISIONING_BANK_PRESET === 'true'
    const policy: WebResearchSourceType[] = bankPreset
      ? ['official', 'vendor_doc']
      : ['official', 'vendor_doc', 'news', 'blog']
    if (!requested || requested.length === 0) return policy
    const requestedSet = new Set(requested)
    return policy.filter((sourceType) => requestedSet.has(sourceType))
  }

  private isResearchSourceType(value: string): value is WebResearchSourceType {
    return value === 'official' || value === 'vendor_doc' || value === 'news' || value === 'blog'
  }

  private async auditWebResearchBlocked(
    actorId: string,
    agentVersion: number | null,
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.append({
      actorType: 'agent',
      actorId,
      agentVersion,
      action: 'agent.web_research.blocked',
      targetType: 'web_research',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'blocked',
      metadata: { reason, ...metadata } as Prisma.JsonValue,
    })
  }

  private async agentResolve(
    args: AgentResolveArgs,
    effectiveTenantId: string | null,
  ): Promise<AgentResolveResult> {
    const query = normalizeText(args.query.trim())
    if (!query) throw new Error('Query is required')

    const limit = args.limit ?? 5
    // Tenant-izoláció: cross-tenant agent SOHA nem szivárog ki a felderítésbe.
    const all = filterAgentsByTenant(await this.agents.findMany(), effectiveTenantId)

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

  private async agentCatalog(
    args: AgentCatalogArgs,
    effectiveTenantId: string | null,
  ): Promise<AgentCatalogResult> {
    const limitDefault = args.query?.trim() ? 5 : 25

    if (args.agentId) {
      // Tenant-izoláció: cross-tenant agentet nem árulunk el (a teljes
      // capability-/connector-katalógusát sem) — nem-elérhető id némán üres.
      const agent = await this.agents.findById(args.agentId)
      if (!agent || !isAgentReachableFromTenant(agent.tenantId, effectiveTenantId)) {
        return { agents: [] }
      }
      const entry = await buildAgentCatalogEntry(args.agentId, this.agents, this.tools)
      return { agents: [entry] }
    }

    // Tenant-izoláció: a katalógus csak a saját tenant + megosztott agenteket listázza.
    const all = filterAgentsByTenant(await this.agents.findMany(), effectiveTenantId)
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

  /**
   * user_directory — a hívó agent tenantjához tartozó AKTÍV humán felhasználók
   * listája a szabad szöveges szerepükkel (`jobDescription`). A tenant a hívó
   * kontextusából oldódik fel (acting-user tenant, különben az agent tenantja) —
   * cross-tenant felhasználó SOHA nem szivárog ki. Az opcionális `query` a
   * néven / szerepen / e-mailen szűr (ékezet- és kisbetű-független).
   */
  private async userDirectory(
    input: Extract<ToolBrokerInvokeInput, { tool: 'user_directory' }>,
    actingTenantId: string | null,
  ): Promise<UserDirectoryResult> {
    const agent = await this.agents.findById(input.agentId)
    const tenantId = actingTenantId ?? agent?.tenantId ?? null

    const all = await this.lookupTenantUserDirectory(tenantId)
    return filterUserDirectory(all, input.args)
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
    webSearchEffective?: WebSearchEffectiveQuery
  }) {
    const requirement = TOOL_REQUIREMENTS[params.input.tool]
    const connectorType = requirement?.connectorType ?? null
    const accessMode = requirement?.accessMode ?? null
    const sanitizedArgsMeta = {
      ...argsMeta(params.input, params.webSearchEffective),
      acting_user_id: params.actingUserId ?? params.input.actingUserId ?? null,
      grant_id: params.grantId ?? null,
      connector_id: params.connectorId,
      connector_type: connectorType,
      access_mode: accessMode,
    }
    const metadata = {
      tool: params.input.tool,
      status: params.status,
      connector_id: params.connectorId,
      connector_type: connectorType,
      access_mode: accessMode,
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
