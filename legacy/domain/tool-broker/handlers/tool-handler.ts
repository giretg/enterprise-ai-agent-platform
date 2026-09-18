/**
 * WP-8 — Tool Broker handler-regiszter.
 *
 * A `ToolBrokerService.invoke` KERET (authorize → speciális kapuk → audit)
 * változatlan marad; a korábbi óriás `executeTool` switch helyett tool-onkénti
 * handlerek adják a tool-specifikus végrehajtást. A tenant-izoláció,
 * capability-gate, `ToolCall`-rögzítés és audit a keretben marad — a handler
 * KIZÁRÓLAG a tool logikáját tartalmazza.
 *
 * Új tool = 1 handler-fájl + 1 registry-bejegyzés (nincs broker-mag módosítás).
 */
import type { Connector } from '@prisma/client'
import type { WebSearchEffectiveQuery } from '@/domain/web-search/web-search-types'
import type { WebSearchService } from '@/domain/web-search/web-search-service'
import type { FileEditorService } from '@/domain/file-editor/file-editor-service'
import type { SandboxAppService } from '@/domain/sandbox/sandbox-app-service'
import type { SandboxVersioningService } from '@/domain/sandbox-versioning/sandbox-versioning-service'
import type {
  AgentAskResult,
  AgentCatalogArgs,
  AgentCatalogResult,
  AgentResolveArgs,
  AgentResolveResult,
  AuthorizationResult,
  BoardWriteResult,
  HttpApiCallResult,
  KbGetPageArgs,
  KbGetPageResult,
  KbListIndexArgs,
  KbListIndexResult,
  KbSearchArgs,
  KbSearchResult,
  MemoryProposeResult,
  RepoOpenPullRequestResult,
  RepoPrepareResult,
  DocumentReadResult,
  GetDebugTraceResult,
  RunIndexResult,
  RunTraceResult,
  RunStatsResult,
  TulajdoniLapParseResult,
  TulajdoniLapEgyeztetesResult,
  TicketCreateResult,
  ToolBrokerInvokeInput,
  ToolExecutionResult,
  UserDirectoryResult,
  WebResearchDelegationResult,
} from '../tool-broker-service'

/** A sikeres authorizáció szűkített alakja — minden handler ezt kapja. */
export type AllowedAuthorization = Extract<AuthorizationResult, { allowed: true }>

/**
 * A handlerek felé kiajánlott broker-képességek. A keret (broker) építi fel és
 * adja át; a handlerek innen érik el a megosztott service-eket és a néhány közös
 * segéd-metódust (tenant-feloldás, delegált token). A választásvezérelt gate-ek
 * (gmail-approval, board-ownership, web_search-policy) a keretben maradnak.
 */
export interface HandlerContext {
  readonly fileEditor: FileEditorService
  readonly sandboxApps: SandboxAppService
  readonly sandboxVersioning: SandboxVersioningService
  readonly webSearch: WebSearchService

  resolveDelegatedAccessToken(
    input: ToolBrokerInvokeInput,
    authorization: AllowedAuthorization,
  ): Promise<string>
  resolveCallerTenantId(
    input: ToolBrokerInvokeInput,
    actingTenantId: string | null,
  ): Promise<string | null>
  resolveWorkspaceStorageTenantId(
    input: Pick<ToolBrokerInvokeInput, 'ticketId' | 'conversationId'>,
    actingTenantId: string | null,
    connectorTenantId: string | null | undefined,
  ): Promise<string>

  kbSearch(agentId: string, args: KbSearchArgs, connector: Connector): Promise<KbSearchResult>
  kbListIndex(agentId: string, args: KbListIndexArgs, connector: Connector): Promise<KbListIndexResult>
  kbGetPage(agentId: string, args: KbGetPageArgs, connector: Connector): Promise<KbGetPageResult>
  boardWrite(input: Extract<ToolBrokerInvokeInput, { tool: 'board_write' }>): Promise<BoardWriteResult>
  ticketCreate(
    input: Extract<ToolBrokerInvokeInput, { tool: 'ticket_create' }>,
    actingTenantId: string | null,
  ): Promise<TicketCreateResult>
  agentAsk(
    input: Extract<ToolBrokerInvokeInput, { tool: 'agent_ask' }>,
    actingTenantId: string | null,
  ): Promise<AgentAskResult>
  webResearchRequest(
    input: Extract<ToolBrokerInvokeInput, { tool: 'web_research_request' }>,
  ): Promise<WebResearchDelegationResult>
  /**
   * #142 — a felderítő toolok a HÍVÓ AGENT `view` jogán szűrnek, ezért a hívó
   * azonosítója a szerződés része (nem elég a tenant).
   */
  agentResolve(
    args: AgentResolveArgs,
    tenantId: string | null,
    callerAgentId: string,
  ): Promise<AgentResolveResult>
  agentCatalog(
    args: AgentCatalogArgs,
    tenantId: string | null,
    callerAgentId: string,
  ): Promise<AgentCatalogResult>
  userDirectory(
    input: Extract<ToolBrokerInvokeInput, { tool: 'user_directory' }>,
    actingTenantId: string | null,
  ): Promise<UserDirectoryResult>
  executeHttpApiTool(
    input: Extract<ToolBrokerInvokeInput, { tool: 'http_api_get' | 'http_api_request' }>,
    connector: Connector,
    actingTenantId: string | null,
    actingUserId: string | null,
    agentSecretAlias: string | null | undefined,
    delegatedAccessToken: string | undefined,
  ): Promise<HttpApiCallResult>
  repoPrepare(
    input: Extract<ToolBrokerInvokeInput, { tool: 'repo_prepare' }>,
    connector: Connector,
    actingTenantId: string | null,
  ): Promise<RepoPrepareResult>
  repoOpenPullRequest(
    input: Extract<ToolBrokerInvokeInput, { tool: 'repo_open_pull_request' }>,
    connector: Connector,
    actingTenantId: string | null,
  ): Promise<RepoOpenPullRequestResult>
  memoryPropose(
    input: Extract<ToolBrokerInvokeInput, { tool: 'memory_propose' }>,
    actingTenantId: string | null,
  ): Promise<MemoryProposeResult>
  documentRead(
    input: Extract<ToolBrokerInvokeInput, { tool: 'document_read' }>,
    actingUserId: string | null,
    actingTenantId?: string | null,
  ): Promise<DocumentReadResult>
  getDebugTrace(
    input: Extract<ToolBrokerInvokeInput, { tool: 'get_debug_trace' }>,
    actingTenantId: string | null,
    actingUserId: string | null,
  ): Promise<GetDebugTraceResult>
  runIndex(
    input: Extract<ToolBrokerInvokeInput, { tool: 'run_index' }>,
    actingTenantId: string | null,
    actingUserId: string | null,
  ): Promise<RunIndexResult>
  runTrace(
    input: Extract<ToolBrokerInvokeInput, { tool: 'run_trace' }>,
    actingTenantId: string | null,
    actingUserId: string | null,
  ): Promise<RunTraceResult>
  runStats(
    input: Extract<ToolBrokerInvokeInput, { tool: 'run_stats' }>,
    actingTenantId: string | null,
    actingUserId: string | null,
  ): Promise<RunStatsResult>
  tulajdoniLapParse(
    input: Extract<ToolBrokerInvokeInput, { tool: 'tulajdoni_lap_parse' }>,
    actingUserId: string | null,
    extras?: {
      authorization: AllowedAuthorization
      actingTenantId: string | null
    },
  ): Promise<TulajdoniLapParseResult>
  tulajdoniLapEgyeztetes(
    input: Extract<ToolBrokerInvokeInput, { tool: 'tulajdoni_lap_egyeztetes' }>,
    actingUserId: string | null,
    extras?: {
      authorization: AllowedAuthorization
      actingTenantId: string | null
    },
  ): Promise<TulajdoniLapEgyeztetesResult>
}

/** Minden handler-hívás egyetlen, immutábilis argumentum-csomagot kap. */
export interface ToolHandlerArgs {
  readonly ctx: HandlerContext
  readonly input: ToolBrokerInvokeInput
  readonly authorization: AllowedAuthorization
  readonly actingTenantId: string | null
  readonly actingUserId: string | null
  readonly webSearchEffective?: WebSearchEffectiveQuery
}

/**
 * Egy tool (vagy tool-csoport) végrehajtója. A `handles` predikátum dönti el,
 * hogy a handler melyik tool-neveket kezeli — így a prefix-csoportok (file_,
 * sandbox_app.) is egyetlen handlerbe foghatók.
 *
 * issue #195 WP-1 — az `execute` visszatérése TIPIZÁLT (`ToolExecutionResult`),
 * nem `unknown`: egy handler nem ígérhet olyat, amit a broker publikus felülete
 * nem ismer. A típus azonban csak fordításidejű állítás — a tényleges kimenetet
 * a broker határán futó KIMENETI SZERZŐDÉS (`tool-output-contract.ts`) validálja
 * futásidőben, az audit-rögzítés előtt.
 */
export interface ToolHandler {
  readonly id: string
  handles(tool: string): boolean
  execute(args: ToolHandlerArgs): Promise<ToolExecutionResult>
}
