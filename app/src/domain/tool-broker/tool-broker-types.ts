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
import type {
  RunIndexArgs,
  RunIndexHeader,
  RunIndexResult,
} from '@/domain/run-analysis/run-index-types'
import type { RunStatsArgs, RunStatsResult } from '@/domain/run-analysis/run-stats-types'
import type {
  RunTraceArgs,
  RunTraceGrain,
  RunTraceProcessResult,
  RunTraceResult,
  RunTraceSummary,
  RunTraceTimelineEntry,
} from '@/domain/run-analysis/run-trace-types'
import type { SettledToolOutcome, ToolEffectSummary } from './tool-output-contract'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type { TulajdoniLapNezet, TulajdoniLapView } from '@/lib/tulajdoni-lap'
import type {
  EgyeztetesNyilvantartasSor,
  EgyeztetesOsszegzes,
} from '@/lib/tulajdoni-lap-egyeztetes'
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
  PdfCreateResult,
  PptxCreateResult,
} from '@/domain/file-editor/file-editor-service'
import type {
  XlsxRow,
  XlsxCellChange,
  CellStyle,
  XlsxDataValidation,
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
  /**
   * A tool-sémában kötelező; opcionális marad a típusban a régi belső hívók
   * kompatibilitásáért. A domain-szűrő üres/hiányzó értékre fail-closed.
   */
  query?: string
  limit?: number
}

export type UserDirectoryEntry = {
  userId: string
  name: string
  role: string | null
  jobDescription: string | null
  status: string
}

/** Belső keresési rekord; az e-mail soha nem kerülhet a tool-válaszba. */
export type UserDirectorySearchEntry = UserDirectoryEntry & {
  email: string
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

/** APG-21 — agent-turn debug trace pszeudonimizált projectionnel (spec §12). */
export type GetDebugTraceArgs = {
  agentTurnId: string
}

export type GetDebugTraceResult = {
  traceId: string
  agentTurnId: string
  conversationId: string
  projection: Record<string, unknown>
}

/**
 * RA-03 … RA-06 — a Futás-elemző három olvasó toolja. A bemenet/kimenet KANONIKUS
 * alakja a `src/domain/run-analysis/*-types.ts` fájlokban él; itt csak
 * re-exportáljuk, hogy a broker publikus felülete egyben maradjon. Külön másolat
 * elcsúszna a valóditól (a folyamat-nézet lapozása épp így maradt volna ki).
 */
export type {
  RunIndexArgs,
  RunIndexHeader,
  RunIndexResult,
  RunTraceArgs,
  RunTraceGrain,
  RunTraceProcessResult,
  RunTraceResult,
  RunTraceSummary,
  RunTraceTimelineEntry,
}

/** RA-06 — futás-aggregátumok szkóp alapján (Run Analyst `run_stats`). */
export type {
  RunStatsArgs,
  RunStatsDenialReason,
  RunStatsLatencyRow,
  RunStatsOutcomeCell,
  RunStatsOutcomeLabel,
  RunStatsPromptCache,
  RunStatsRepeatedSourceKey,
  RunStatsResult,
  RunStatsSkillLoad,
  RunStatsToolOutcomeRow,
} from '@/domain/run-analysis/run-stats-types'

/**
 * Magyar e-hiteles tulajdoni lap strukturált kinyerése egy feltöltött PDF-ből.
 * Chat csatolmány: `documentId` (UUID). Board/ticket workspace: `path` (fájlnév).
 * A `nezet` a kimenet méretét szabja: alapból összefoglaló, részletet külön kérni kell.
 */
export type TulajdoniLapParseArgs = {
  /** Document UUID — chat/csatolmány. Workspace fájlnévhez használd a `path`-ot. */
  documentId?: string
  /** Ticket/chat workspace PDF elérési út (pl. a Fájlok panelen feltöltött név). */
  path?: string
  nezet?: TulajdoniLapNezet
  csakHatalyos?: boolean
  limit?: number
  offset?: number
  raw?: boolean
  /**
   * Teljes, verziózott agent-handoff JSON a workspace-be. Ha meg van adva, a
   * következő agent ezt adhatja át `feldolgozottLapPath`-ként az egyeztetőnek.
   */
  kimenet?: string
}

export type TulajdoniLapParseResult = TulajdoniLapView & {
  documentId: string | null
  path?: string
  filename: string
  /** A létrehozott teljes handoff JSON útvonala; csak `kimenet` mellett. */
  kimenet: string | null
}

/**
 * Egy hívásos egyeztetés (issue #161): lap-parse → párosítás → opcionális Excel.
 * A nyilvántartás oldala vagy közvetlenül jön (`nyilvantartas`), vagy egy
 * munkaterület-beli JSON fájlból (`nyilvantartasPath`) — utóbbi a nagy
 * névsoroknál kíméli a modell kontextusát.
 */
export type TulajdoniLapEgyeztetesArgs = {
  documentId?: string
  path?: string
  /**
   * A `tulajdoni_lap_parse` által készített teljes, verziózott handoff JSON.
   * Megadásakor az egyeztető nem olvassa és nem parse-olja újra a PDF-et.
   */
  feldolgozottLapPath?: string
  nyilvantartas?: EgyeztetesNyilvantartasSor[]
  nyilvantartasPath?: string
  /**
   * Ha megadod: Excel munkafüzet a munkaterületre (pl. `egyeztetes.xlsx`).
   * Ha nincs: NEM készül Excel — a válasz JSON (`osszegzes` + `eltero`) a
   * deliverable (pl. Ostoros Föld frissítő skill). A skill dönti el a kimenetet, nem a tool.
   */
  kimenet?: string
  /**
   * Csonka-lista védelem felülírása. Csak akkor true, ha http_api_get_all után
   * is ugyanez a sorok száma (a nyilvántartás tényleg ennyi).
   */
  confirmNyilvantartasComplete?: boolean
  /** Parcel id a determinisztikus `fold_muveletek.json` path-okhoz. */
  parcelId?: string
  /**
   * Lefedettség-ellenőrzés: a proposal / alkalmazott ownership id-k JSON path-ja
   * (pl. `proposal_items_extract.json`). Document nélkül is hívható
   * (`coverageMuveletekPath` + ez) — ilyenkor NEM fut újra a lap-parse.
   */
  coverageAppliedPath?: string
  /** Terv path a coverage-hez; alapértelmezés: `fold_muveletek.json`. */
  coverageMuveletekPath?: string
}

/** Két workspace JSON-lista determinisztikus egyeztetése (issue #179). */
export type ReconcileRecordsArgs = {
  leftPath: string
  rightPath: string
  outputPath: string
  keyFields: string[]
  /** Mező → normalizálás a kulcs-összehasonlításhoz. */
  normalize?: Record<string, 'trim' | 'lower' | 'hu-name' | 'year'>
  /** Összevetendő mezők (string = exact, vagy { field, mode, epsilon }). */
  compareFields?: Array<string | { field: string; mode?: 'exact' | 'number' | 'fraction'; epsilon?: number }>
  /** Gyorsítócímke: ezek fraction módú compareFields-ek. */
  fractionFields?: string[]
  /** Gyorsítócímke: mező → abszolút szám-tűrés. */
  numberTolerances?: Record<string, number>
}

export type ReconcileRecordsResult = {
  ok: boolean
  outputPath: string
  summary: {
    total: number
    rendben: number
    modositas: number
    ujRekord: number
    torles: number
    ellenorzes: number
    uncertain: number
  }
  uncertainCount: number
  message: string
  uncertain: Array<{
    note: string
    left: Record<string, unknown>
    right: Record<string, unknown>
  }>
}

export type TulajdoniLapEgyeztetesResult = {
  ok: boolean
  /** A lap ellenőrzése bukott (hányadösszeg ≠ 1) — ilyenkor nem készül tábla. */
  figyelmeztetes: string | null
  path: string | null
  meta: TulajdoniLapView['meta']
  osszesites: TulajdoniLapView['osszesites']
  egyeztetes: EgyeztetesOsszegzes | null
  /**
   * Eltérő sorok — a modellnek SZÁNDÉKOSAN kompakt / mintavételezett
   * (hosszú `megjegyzes` nélkül), hogy a 12k inline-küszöb alatt maradjon.
   * A teljes lista az `elteroPath` fájlban van (Föld PATCH/DELETE forrás).
   */
  eltero: Array<{
    nev: string
    statusz: string
    hanyadLap: string | null
    hanyadNyilvantartas: string | null
    azonosito: string | null
  }>
  /** Teljes kompakt eltérő lista a munkaterületen — Föld-írás / extract forrás. */
  elteroPath: string | null
  /** Az `elteroPath` / teljes eltérő lista elemszáma (nem a mintáé). */
  elteroDb: number
  /**
   * Determinisztikus Föld Ownership terv (DELETE→PATCH→POST, teljes `items`).
   * A modell EBBŐL hívja az `http_api_request`-eket — ne szerkessze az id-ket.
   */
  muveletekPath: string | null
  muveletekDb: number
  /** `coverageAppliedPath` megadásakor: terv id-k ⊆ proposal id-k. */
  coverage: {
    ok: boolean
    expected: number
    applied: number
    missing: Array<{ ownershipId: string; nev: string; action: string }>
    extra: string[]
    message: string
  } | null
  szeljegyDb: number
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

export type GoogleDriveSearchArgs = {
  query?: string
  nameContains?: string
  mimeTypes?: string[]
  modifiedAfter?: string
  driveId?: string
  pageSize?: number
  pageToken?: string
}
export type GoogleDriveGetFileArgs = { fileId: string }
export type GoogleDriveReadFileArgs = { fileId: string; maxBytes?: number; sheetName?: string }
export type GoogleDriveListDrivesArgs = { pageSize?: number; pageToken?: string }
export type GoogleDriveCreateFolderArgs = {
  name: string
  parentFolderId?: string
  idempotencyKey: string
}
export type GoogleDriveUploadFileArgs = {
  artifactRef: string
  name?: string
  parentFolderId?: string
  convertToGoogleType?: 'doc' | 'sheet' | 'slides'
  idempotencyKey: string
}
export type GoogleDriveUpdateFileArgs = {
  fileId: string
  artifactRef?: string
  textContent?: string
  expectedModifiedTime?: string
  idempotencyKey: string
}
export type GoogleDriveRenameFileArgs = { fileId: string; newName: string; idempotencyKey: string }
export type GoogleDriveMoveFileArgs = {
  fileId: string
  destinationFolderId: string
  idempotencyKey: string
}
export type GoogleDriveCopyFileArgs = {
  fileId: string
  newName?: string
  parentFolderId?: string
  idempotencyKey: string
}
export type GoogleDriveTrashFileArgs = { fileId: string }
export type GoogleDriveRestoreFileArgs = { fileId: string }
export type GoogleDriveShareFileArgs = {
  fileId: string
  recipientType: 'user' | 'group'
  emailAddress: string
  role: 'reader' | 'commenter' | 'writer'
  sendNotificationEmail?: boolean
  emailMessage?: string
}
export type GoogleDocsApplyEditsArgs = {
  fileId: string
  operations: Array<Record<string, unknown>>
}
export type GoogleSheetsWriteRangeArgs = {
  fileId: string
  range: string
  values: unknown[][]
  mode?: 'replace' | 'append'
}
export type GoogleSlidesApplyEditsArgs = {
  fileId: string
  operations: Array<Record<string, unknown>>
}

export type HttpApiQuery = Record<string, string | number | boolean>
export type HttpApiHeaders = Record<string, string>
export type HttpApiGetArgs = {
  connectorId?: string
  path: string
  query?: HttpApiQuery
  headers?: HttpApiHeaders
  /** Csak a broker állítja: szerver által adott next-link eredeti endpointja. */
  continuationOf?: string
}
export type HttpApiGetAllArgs = {
  connectorId?: string
  path: string
  query?: HttpApiQuery
  headers?: HttpApiHeaders
  pageParam?: string
  pageSizeParam?: string
  pageSize?: number
  startPage?: number
  maxPages?: number
  arrayPath?: string
}
export type HttpApiRequestArgs = {
  connectorId?: string
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  query?: HttpApiQuery
  headers?: HttpApiHeaders
  body?: unknown
}
export type HttpApiCallResult = {
  status: number
  ok: boolean
  body: unknown
  hint?: string
  truncated?: boolean
  linkHeader?: string
}
export type HttpApiGetAllResult = {
  ok: boolean
  path: string
  pageCount: number
  itemCount: number
  items: unknown[]
  error?: string
  /**
   * Honnan jött a lista és teljes-e a lapozás. A csonka lista a legveszélyesebb
   * csendes hiba (egy oldalnyi névsorból hamis „új rekord" egyeztetés lesz),
   * ezért a kimeneti szerződés ebből ad `partial` kimenetelt (issue #195).
   */
  provenance?: {
    sourceTool: string
    paginationComplete: boolean
    strategy?: 'cursor' | 'page' | 'offset' | 'next_link' | 'none'
    stopReason?: string
  }
}

export type GmailSearchResult = { messages: Array<Record<string, string>> }
export type GmailGetMessageResult = Record<string, string>
export type MailboxCountResult = { count: number; query: string }
export type GmailCreateDraftResult = { draftId: string }
export type GmailSendResult = { messageId: string }

export type GoogleDriveFileSummary = {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  size?: string
  webViewLink?: string
  driveId?: string
  trashed?: boolean
  parents?: string[]
}

export type GoogleDriveSearchResult = {
  files: GoogleDriveFileSummary[]
  nextPageToken?: string
}
export type GoogleDriveGetFileResult = GoogleDriveFileSummary
export type GoogleDriveReadFileResult = {
  file: GoogleDriveFileSummary
  contentType: string
  text?: string
  truncated: boolean
  warnings: string[]
}
export type GoogleDriveListDrivesResult = {
  drives: Array<{ id: string; name: string }>
  nextPageToken?: string
}
export type GoogleDriveCreateFolderResult = { file: GoogleDriveFileSummary; created: boolean }
export type GoogleDriveUploadFileResult = { file: GoogleDriveFileSummary; created: boolean }
export type GoogleDriveUpdateFileResult = {
  file: GoogleDriveFileSummary
  conflict?: boolean
}
export type GoogleDriveCopyFileResult = { file: GoogleDriveFileSummary; created: boolean }
export type GoogleDriveShareFileResult = { permissionId: string }
export type GoogleDocsApplyEditsResult = { ok: true; fileId: string }
export type GoogleSheetsWriteRangeResult = { ok: true; fileId: string; updatedCells?: number }
export type GoogleSlidesApplyEditsResult = { ok: true; fileId: string }

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
export type FileDeleteArgs = { path: string; confirm?: boolean }
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
  dataValidations?: XlsxDataValidation[]
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

export type ToolInvokeBase = {
  agentId: string
  agentVersion: number
  ticketId?: string
  conversationId?: string
  /**
   * issue #237 — melyik chat-forduló hívta. A `ToolCall.agentTurnId` ebből
   * töltődik; ticket/task úton üresen marad.
   */
  agentTurnId?: string
  actingUserId?: string
  /**
   * Az `actingUserId` csak megbízható, szerveroldali futás-kontektsusból
   * származhat. Az agent API-kulcs birtokosa nem választhat felhasználót.
   */
  actingUserSource?: 'trusted_internal' | 'external_agent_api'
  /**
   * Abszolút határidő (epoch ms), ameddig a hívónak MÉG van kerete. Ma csak a
   * szinkron `agent_ask` figyeli: a delegált agent futása a hívó fordulójának
   * faliórájából fogy, és határidő nélkül egyetlen kérdés elviheti a keret
   * negyedét — a felhasználó ilyenkor válasz helyett „folytasd"-ot ír. A
   * túllépés NEM hiba: a ticket megmarad, a válasz aszinkron érkezik meg.
   */
  deadlineAt?: number
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
  | (ToolInvokeBase & { tool: 'google_drive_search'; args: GoogleDriveSearchArgs })
  | (ToolInvokeBase & { tool: 'google_drive_get_file'; args: GoogleDriveGetFileArgs })
  | (ToolInvokeBase & { tool: 'google_drive_read_file'; args: GoogleDriveReadFileArgs })
  | (ToolInvokeBase & { tool: 'google_drive_list_drives'; args: GoogleDriveListDrivesArgs })
  | (ToolInvokeBase & { tool: 'google_drive_create_folder'; args: GoogleDriveCreateFolderArgs })
  | (ToolInvokeBase & { tool: 'google_drive_upload_file'; args: GoogleDriveUploadFileArgs })
  | (ToolInvokeBase & { tool: 'google_drive_update_file'; args: GoogleDriveUpdateFileArgs })
  | (ToolInvokeBase & { tool: 'google_drive_rename_file'; args: GoogleDriveRenameFileArgs })
  | (ToolInvokeBase & { tool: 'google_drive_move_file'; args: GoogleDriveMoveFileArgs })
  | (ToolInvokeBase & { tool: 'google_drive_copy_file'; args: GoogleDriveCopyFileArgs })
  | (ToolInvokeBase & { tool: 'google_drive_trash_file'; args: GoogleDriveTrashFileArgs })
  | (ToolInvokeBase & { tool: 'google_drive_restore_file'; args: GoogleDriveRestoreFileArgs })
  | (ToolInvokeBase & { tool: 'google_drive_share_file'; args: GoogleDriveShareFileArgs })
  | (ToolInvokeBase & { tool: 'google_docs_apply_edits'; args: GoogleDocsApplyEditsArgs })
  | (ToolInvokeBase & { tool: 'google_sheets_write_range'; args: GoogleSheetsWriteRangeArgs })
  | (ToolInvokeBase & { tool: 'google_slides_apply_edits'; args: GoogleSlidesApplyEditsArgs })
  | (ToolInvokeBase & { tool: 'http_api_get'; args: HttpApiGetArgs })
  | (ToolInvokeBase & { tool: 'http_api_get_all'; args: HttpApiGetAllArgs })
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
  | (ToolInvokeBase & { tool: 'tulajdoni_lap_parse'; args: TulajdoniLapParseArgs })
  | (ToolInvokeBase & {
      tool: 'tulajdoni_lap_egyeztetes'
      args: TulajdoniLapEgyeztetesArgs
    })
  | (ToolInvokeBase & { tool: 'reconcile_records'; args: ReconcileRecordsArgs })
  | (ToolInvokeBase & { tool: 'get_debug_trace'; args: GetDebugTraceArgs })
  | (ToolInvokeBase & { tool: 'run_index'; args: RunIndexArgs })
  | (ToolInvokeBase & { tool: 'run_trace'; args: RunTraceArgs })
  | (ToolInvokeBase & { tool: 'run_stats'; args: RunStatsArgs })

/**
 * Bizalmi osztály MINDEN eszköz-eredményen (issue #97). Determinisztikus, a
 * tool-nevenkénti regiszter (`tool-trust-registry.ts`) adja, NEM az agent és nem
 * a hívási hely választja. Erős union a Tool Broker publikus felületén, hogy egy
 * fogyasztó kihagyása fordításidőben kiderüljön.
 *   - `trusted`            — platform-determinisztikus eredmény (pl. board_write
 *                            visszaigazolás, sandbox commit-eredmény).
 *   - `internal`           — a tenant belső rendszeréből (pl. tudásbázis, user
 *                            directory) — nem szigorú kezelés, de a különbség rögzített.
 *   - `external_untrusted` — kívülről beszedett adat (bejövő levél, webtartalom,
 *                            ügyfél-feltöltés, harmadik fél API-ja). ADAT marad,
 *                            sosem utasítás.
 */
export type TrustClass = 'trusted' | 'internal' | 'external_untrusted'

export type ToolBrokerInvokeResult =
  | {
      denied: true
      reason: string
      latencyMs: number
      /** Grant-hiány kártyához — ha a connector feloldódott, de a user-grant nem. */
      connectorId?: string | null
      /**
       * D1 (issue #195) — az elutasított hívás kimenetele mindig `failed`: nem
       * futott le, tehát semmit nem végzett el. Így a fogyasztó egyetlen mezőből
       * dönthet, anélkül hogy a `denied` ágat külön kellene kezelnie.
       */
      outcome: 'failed'
    }
  | {
      denied: false
      /**
       * A tool-eredmény bizalmi osztálya (issue #97). Kötelező mező: minden
       * fogyasztónak (chat-tool-loop, wiki/general-task/agent-chat runtime, agent
       * tools API) kezelnie kell, mielőtt az eredmény a modell elé kerül.
       */
      trust: TrustClass
      /**
       * D1 (issue #195) — KÖTELEZŐ kimenetel. Az `empty` és a `partial` nem hiba,
       * hanem TÉNY: az agent és a felhasználó eddig épp azt nem tudta meg, hogy az
       * eszköz „sikeresen semmit nem csinált". A `failed` kivételként bukik ki, ide
       * nem jut el.
       */
      outcome: SettledToolOutcome
      /** Miért `empty` / `partial` — hétköznapi magyarul. `ok`-nál `null`. */
      outcomeReason: string | null
      /** D4 — a MÉRT mellékhatás (olvasó toolnál `null`). */
      effect: ToolEffectSummary | null
      /**
       * D5 — a MODELLNEK szánt csatorna: bizalmi osztály szerint BECSOMAGOLVA
       * (`envelopeToolResultForModel`), méret-kapuval, és a kimenetel hétköznapi
       * nyelvű közlésével. Aki a modellnek ad tool-eredményt, EZT adja.
       */
      modelText: string
      /**
       * D5 — a GÉPI csatorna: strukturált adat a munkaterületnek, downstream
       * toolnak, egyeztetésnek, exportnak. SOHA nem burkolt, és soha nem megy
       * közvetlenül a modellhez — így a burkolat elvi szinten nem kerülhet gépi
       * útra (a korábbi `unwrapExternalDataEnvelope` folt szükségtelenné vált).
       */
      machineData: unknown
      /**
       * @deprecated WP-2 — a `machineData` alias-a, egy migrációs körig megtartva,
       * hogy a fogyasztók átállítása ne legyen big-bang. Új kód a `machineData`
       * (gépi) vagy a `modelText` (modell) mezőt használja.
       */
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
        | GoogleDriveSearchResult
        | GoogleDriveGetFileResult
        | GoogleDriveReadFileResult
        | GoogleDriveListDrivesResult
        | GoogleDriveCreateFolderResult
        | GoogleDriveUploadFileResult
        | GoogleDriveUpdateFileResult
        | GoogleDriveCopyFileResult
        | GoogleDriveShareFileResult
        | GoogleDocsApplyEditsResult
        | GoogleSheetsWriteRangeResult
        | GoogleSlidesApplyEditsResult
        | HttpApiCallResult
        | HttpApiGetAllResult
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
        | PdfCreateResult
        | PptxCreateResult
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
        | TulajdoniLapParseResult
        | TulajdoniLapEgyeztetesResult
        | ReconcileRecordsResult
        | GetDebugTraceResult
        | RunIndexResult
        | RunTraceResult
        | RunStatsResult
      resultMeta: Record<string, unknown>
      latencyMs: number
    }

/** A sikeres tool-végrehajtás nyers eredménye (a handlerek uniója). */
export type ToolExecutionResult = Extract<ToolBrokerInvokeResult, { denied: false }>['result']

export type ToolName = ToolBrokerInvokeInput['tool']

export type AuthorizationResult =
  | { allowed: true; connector?: Connector; grant?: ConnectorGrant; actingUserId?: string; agentSecretAlias?: string | null }
  | { allowed: false; reason: string; connector?: Connector }
