import type {
  Connector,
  Prisma,
} from '@prisma/client'

import { prisma } from '@/lib/db'
import type { WebFetchResult, WebFetchSourceType } from '@/domain/web-fetch/web-fetch-types'

import {
  isRunAsAuthorized,
  isScheduledTaskRunAsAuthorized,
  readRunAsUserId,
  SCHEDULED_TASK_ID,
} from '@/lib/run-as-payload'
import { GmailApiAuthError } from '@/domain/connector-grant/gmail-api-client'

import type { ConnectorGrantService } from '@/domain/connector-grant/connector-grant-service'
import type { FileEditorService } from '@/domain/file-editor/file-editor-service'

import type {
  AgentRepository,
  AuditRepository,
  KnowledgeArtifactRepository,
  KnowledgeChunkRepository,
  TicketRepository,
  ToolBrokerRepository,
} from '@/repositories/interfaces'

import type { TicketService } from '@/domain/ticket/ticket-service'
import type { MemoryProposalService } from '@/domain/memory/memory-proposal-service'
import type { WebSearchPolicyService } from '@/domain/web-search/web-search-policy-service'
import type { WebSearchService } from '@/domain/web-search/web-search-service'
import {
  parseWebSearchConfig,
  type WebSearchEffectiveQuery,
} from '@/domain/web-search/web-search-types'

// WP-8 — tool-onkénti handler-regiszter (az óriás executeTool switch kiváltása).
import { resolveToolHandler } from './handlers/registry'
import type { HandlerContext } from './handlers/tool-handler'
// WP-8 — a publikus tool-típusok külön fájlba (tool-broker-types.ts) kerültek;
// a magban belül használt nevek innen importálva, a teljes felület re-exportálva.
import type {
  AuthorizationResult,
  DelegationProcessor,
  GmailSendArgs,
  PlaybookTicketTransitioner,
  ToolBrokerInvokeInput,
  ToolBrokerInvokeResult,
  ToolExecutionResult,
} from './tool-broker-types'
// WP-8 — az authorizáció-koncern külön modulban (tool-broker-authorizer.ts);
// a mag a szükséges lookupokat importálja, a publikus felületet re-exportálja.
import {
  prismaWebSearchEnabledLookup,
  prismaWebFetchEnabledLookup,
  prismaWebResearchDelegationEnabledLookup,
  prismaTenantUserDirectoryLookup,
} from './tool-broker-authorizer'
import type {
  Authorizer,
  WebSearchEnabledLookup,
  WebFetchEnabledLookup,
  WebResearchDelegationEnabledLookup,
  TenantUserDirectoryLookup,
} from './tool-broker-authorizer'
// WP-8 — állapotmentes segédfüggvények külön modulban (tool-broker-support.ts).
import {
  isRecord,
  resultMeta,
} from './tool-broker-support'

// WP-8 — a delegáció-törzsek külön modulban (tool-broker-delegation.ts); a keret
// (invoke) ezeket a handlerContexten át hívja, `this`-t átadva `self`-ként.
import {
  agentAsk,
  agentCatalog,
  agentResolve,
  boardWrite,
  executeHttpApiTool,
  kbGetPage,
  kbListIndex,
  kbSearch,
  memoryPropose,
  documentRead,
  tulajdoniLapParse,
  repoOpenPullRequest,
  repoPrepare,
  resolveCallerTenantId,
  resolveDelegatedAccessToken,
  resolveWorkspaceStorageTenantId,
  ticketCreate,
  tulajdoniLapEgyeztetes,
  userDirectory,
  webResearchRequest,
} from './tool-broker-delegation'
// WP-8 — az audit/telemetria choke-point külön modulban (tool-broker-audit.ts).
import { recordCall, recordDenied } from './tool-broker-audit'
import type { AgentAccessService } from '@/domain/agent-access/agent-access-service'
import { recordPrivacyGatewayAudit } from '@/domain/privacy/privacy-audit'
import {
  mergePrivacySpanCategories,
  type PrivacyGatewayMode,
  type PrivacyModeResolver,
} from '@/domain/privacy/privacy-mode'
import {
  allowsExternalRaw,
  type PrivacyCategoryActionResolver,
} from '@/domain/privacy/privacy-category-policy'
import { privacyScopeForCall } from '@/domain/privacy/privacy-scope'
import {
  resolveToolArgs,
  UnknownSurrogateError,
} from '@/domain/privacy/resolve-tool-args'
import { resolveEntityNamesInToolArgs } from '@/domain/privacy/resolve-tool-entity-names'
import type { ConnectorEntityResolver } from '@/domain/privacy/entity-resolve-contract'
import { connectorSupportsEntityResolution } from '@/domain/privacy/connector-privacy'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import type { DebugTraceService } from '@/domain/debug-log/debug-trace-service'
import type { ResolvedPrivacyCategoryPolicy } from '@/domain/privacy/privacy-category-policy'
// issue #97 — bizalmi regiszter (tool-nevenkénti TrustClass leképezés).
import { isSideEffectingTool, resolveTrustClass } from './tool-trust-registry'
// issue #195 — kikényszerített KIMENETI SZERZŐDÉS a broker határán (WP-1).
import {
  assertToolInputWithinLimits,
  ToolContractError,
} from './tool-output-contract'
import { resolveToolOutputContract } from './tool-output-contracts'
import { buildPrivacyAwareOutcomeChannels } from './tool-output-privacy'
export { AllowlistAuthorizer } from './tool-broker-authorizer'
export type {
  Authorizer,
  ActingUserLookup,
  RoleTemplateLookup,
} from './tool-broker-authorizer'

export * from './tool-broker-types'
export {
  filterUserDirectory,
  assembleKbHits,
  assembleKbIndex,
  assembleKbPage,
} from './tool-broker-support'
// A tenant-elérhetőségi invariáns közös modulból jön; re-export a visszafelé
// kompatibilitásért (a tool-broker-tenant-isolation.test.ts innen importál).
export { isAgentReachableFromTenant, filterAgentsByTenant } from '@/lib/tenant-reachability'
export type ConnectorEntityResolverFactory = (input: {
  connector: Connector
  agentSecretAlias?: string | null
  actingUserId?: string | null
  agentId: string
}) => Promise<ConnectorEntityResolver | null>

export class ToolBrokerService {
  delegationProcessor: DelegationProcessor | null = null
  playbookTransitioner: PlaybookTicketTransitioner | null = null
  private structuredPrivacyEngine: SurrogateEngine | null = null
  private debugTraceService: DebugTraceService | null = null
  private privacyModeResolver: PrivacyModeResolver | null = null
  private privacyCategoryActionResolver: PrivacyCategoryActionResolver | null = null
  private privacyPolicyResolver:
    | ((input: {
        tenantId: string | null
        agentId: string
        legacyAllowSensitiveExternalModel?: boolean | null
      }) => Promise<ResolvedPrivacyCategoryPolicy>)
    | null = null
  private connectorEntityResolverFactory: ConnectorEntityResolverFactory | null = null

  /** WP-8: a handlerek felé átadott, `this`-hez kötött broker-képességek. */
  private readonly handlerContext: HandlerContext

  constructor(
    readonly agents: AgentRepository,
    readonly tickets: TicketRepository,
    readonly tools: ToolBrokerRepository,
    readonly audit: AuditRepository,
    readonly ticketService: TicketService,
    private authorizer: Authorizer,
    readonly grantService: ConnectorGrantService,
    readonly fileEditor: FileEditorService,
    private sandboxApps: import('@/domain/sandbox/sandbox-app-service').SandboxAppService,
    private sandboxVersioning: import('@/domain/sandbox-versioning/sandbox-versioning-service').SandboxVersioningService,
    private webSearch: WebSearchService,
    private webSearchPolicy: WebSearchPolicyService,
    // KB-v3 §9.1/§10 — published OKF-chunk full-text retrieval + superseded (§10.5).
    readonly knowledgeChunks: KnowledgeChunkRepository,
    readonly knowledgeArtifacts: KnowledgeArtifactRepository,
    readonly memoryProposal: MemoryProposalService,
    private isWebSearchEnabled: WebSearchEnabledLookup = prismaWebSearchEnabledLookup,
    readonly isWebFetchEnabled: WebFetchEnabledLookup = prismaWebFetchEnabledLookup,
    readonly isWebResearchDelegationEnabled: WebResearchDelegationEnabledLookup = prismaWebResearchDelegationEnabledLookup,
    readonly lookupTenantUserDirectory: TenantUserDirectoryLookup = prismaTenantUserDirectoryLookup,
    /**
     * Agent-hozzáférési gráf (#142). A `agent_ask`, `ticket_create` (agent-felelős),
     * `web_research_request`, `agent_catalog` és `agent_resolve` chokepointok ezen
     * keresztül döntenek. Ha nincs bekötve, a gráf-kapu FAIL-CLOSED: az agent→agent
     * elérés elutasításra kerül (`AGENT_NOT_FOUND`), nem nyílik meg korlátlanul.
     */
    readonly agentAccess?: AgentAccessService,
    /** A web-kutatás kizárólag ezen a kontrollált fetch-kapun olvashat külső tartalmat. */
    readonly webResearchFetch?: (input: {
      agentId: string
      tenantId: string | null
      url: string
      sourceType: WebFetchSourceType
      allowedSourceUrls: string[]
      fetchIndex: number
    }) => Promise<WebFetchResult>,
  ) {
    // WP-8: a handlerek felé kiajánlott broker-képességek. A tool-logika a keret
    // (invoke) authorize→gate→audit rétegén belül, változatlan viselkedéssel fut;
    // a handlerek innen érik el a megosztott service-eket és a közös segédeket.
    this.handlerContext = {
      fileEditor: this.fileEditor,
      sandboxApps: this.sandboxApps,
      sandboxVersioning: this.sandboxVersioning,
      webSearch: this.webSearch,
      resolveDelegatedAccessToken: (input, authorization) =>
        resolveDelegatedAccessToken(this, input, authorization),
      resolveCallerTenantId: (input, actingTenantId) =>
        resolveCallerTenantId(this, input, actingTenantId),
      resolveWorkspaceStorageTenantId: (input, actingTenantId, connectorTenantId) =>
        resolveWorkspaceStorageTenantId(this, input, actingTenantId, connectorTenantId),
      kbSearch: (agentId, args, connector) => kbSearch(this, agentId, args, connector),
      kbListIndex: (agentId, args, connector) => kbListIndex(this, agentId, args, connector),
      kbGetPage: (agentId, args, connector) => kbGetPage(this, agentId, args, connector),
      boardWrite: (input) => boardWrite(this, input),
      ticketCreate: (input, actingTenantId) => ticketCreate(this, input, actingTenantId),
      agentAsk: (input, actingTenantId) => agentAsk(this, input, actingTenantId),
      webResearchRequest: (input) => webResearchRequest(this, input),
      agentResolve: (args, tenantId, callerAgentId) => agentResolve(this, args, tenantId, callerAgentId),
      agentCatalog: (args, tenantId, callerAgentId) => agentCatalog(this, args, tenantId, callerAgentId),
      userDirectory: (input, actingTenantId) => userDirectory(this, input, actingTenantId),
      executeHttpApiTool: (input, connector, actingTenantId, actingUserId, agentSecretAlias, delegatedAccessToken) =>
        executeHttpApiTool(this, input, connector, actingTenantId, actingUserId, agentSecretAlias, delegatedAccessToken),
      repoPrepare: (input, connector, actingTenantId) =>
        repoPrepare(this, input, connector, actingTenantId),
      repoOpenPullRequest: (input, connector, actingTenantId) =>
        repoOpenPullRequest(this, input, connector, actingTenantId),
      memoryPropose: (input, actingTenantId) => memoryPropose(this, input, actingTenantId),
      documentRead: (input, actingUserId, actingTenantId) =>
        documentRead(this, input, actingUserId, actingTenantId ?? null),
      getDebugTrace: (input, actingTenantId, actingUserId) =>
        this.fetchDebugTrace(input, actingTenantId, actingUserId),
      tulajdoniLapParse: (input, actingUserId, extras) =>
        tulajdoniLapParse(this, input, actingUserId, extras),
      tulajdoniLapEgyeztetes: (input, actingUserId, extras) =>
        tulajdoniLapEgyeztetes(this, input, actingUserId, extras),
    }
  }

  /** Chat agent_ask: szinkron feldolgozás (pl. WikiAgentRuntime.processTicket). */
  setDelegationProcessor(processor: DelegationProcessor | null): void {
    this.delegationProcessor = processor
  }

  /** A folyamat-ticketek állapotváltását a Playbook state machine-hez köti (l. board_write). */
  setPlaybookTransitioner(transitioner: PlaybookTicketTransitioner | null): void {
    this.playbookTransitioner = transitioner
  }

  /**
   * APG-04/APG-05 — strukturált tool-output pszeudonimizáció a `modelText` csatornán,
   * és tool-argumentum feloldás a connector-hívás előtt. Hiányában mindkét ág
   * érintetlen (a meglévő hívások viselkedése nem változik).
   */
  setStructuredPrivacyEngine(engine: SurrogateEngine | null): void {
    this.structuredPrivacyEngine = engine
  }

  setDebugTraceService(service: DebugTraceService | null): void {
    this.debugTraceService = service
  }

  /**
   * APG-09 — platform → tenant → agent üzemmód. Hiányában ENFORCE (APG-04
   * tesztek viselkedése). Élesben a PlatformSettingsService oldja fel.
   */
  setPrivacyModeResolver(resolver: PrivacyModeResolver | null): void {
    this.privacyModeResolver = resolver
  }

  /** APG-11 — kategória-policy a web_search query-safety guardhoz. */
  setPrivacyCategoryActionResolver(resolver: PrivacyCategoryActionResolver | null): void {
    this.privacyCategoryActionResolver = resolver
  }

  /** APG-21 — teljes kategória-policy a debug-trace projectionhoz. */
  setPrivacyPolicyResolver(
    resolver:
      | ((input: {
          tenantId: string | null
          agentId: string
          legacyAllowSensitiveExternalModel?: boolean | null
        }) => Promise<ResolvedPrivacyCategoryPolicy>)
      | null,
  ): void {
    this.privacyPolicyResolver = resolver
  }

  /** APG-17 — connector `resolve()` a tool-boundary második védelmi vonalához. */
  setConnectorEntityResolverFactory(factory: ConnectorEntityResolverFactory | null): void {
    this.connectorEntityResolverFactory = factory
  }

  async invoke(input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> {
    const startedAt = Date.now()
    const ticketId = input.tool === 'board_write' ? input.args.ticketId : input.ticketId ?? null
    const actingUserId = await this.resolveActingUserId(input)
    const actingTenantId = actingUserId ? await this.resolveActingTenantId(input, actingUserId) : null

    const authorization = await this.authorizer.authorize({
      agentId: input.agentId,
      tool: input.tool,
      args: input.args as Record<string, unknown>,
      actingUserId,
      tenantId: actingTenantId,
    })

    if (!authorization.allowed) {
      return recordDenied(this, input, ticketId, authorization.connector?.id ?? null, authorization.reason, startedAt, actingUserId, null)
    }

    if (input.tool === 'gmail_send') {
      const approved = await this.checkGmailSendApproval(input, input.args)
      if (!approved) {
        return recordDenied(this, 
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
        return recordDenied(this, input, ticketId, authorization.connector?.id ?? null, 'ticket_not_found', startedAt, actingUserId, authorization.grant?.id ?? null)
      }
      if (ticket.agentId !== input.agentId) {
        return recordDenied(this, 
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
      const [enabled, scopedQueryCount, agentDayQueryCount, agent] = await Promise.all([
        this.isWebSearchEnabled(actingTenantId),
        ticketId
          ? this.tools.countToolCallsForTicket(ticketId, 'web_search')
          : input.conversationId
            ? this.tools.countToolCallsForConversation(input.conversationId, 'web_search')
            : Promise.resolve(0),
        this.tools.countToolCallsForAgentSince(
          input.agentId,
          'web_search',
          new Date(Date.now() - 24 * 60 * 60 * 1000),
        ),
        this.agents.findById(input.agentId),
      ])
      const decision = this.webSearchPolicy.authorize(input.args, config, {
        enabled,
        scopedQueryCount,
        agentDayQueryCount,
        bypassSensitivity: await this.webSearchBypassSensitivity(
          actingTenantId,
          input.agentId,
          input.args.query,
          agent?.allowSensitiveExternalModel ?? false,
        ),
      })
      if (!decision.allowed) {
        return recordDenied(this, 
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

    // issue #195 — a tool kimeneti szerződése. A `contract` a bemeneti méret-kapuhoz
    // (D7) már a handler-hívás ELŐTT kell, hogy egy kombinatorikus tool ne a workert
    // fagyassza le, hanem azonnal, érthető hibával álljon meg.
    const contract = resolveToolOutputContract(input.tool)

    try {
      // APG-05 §10.1 — feloldás az authorizer/kapuk UTÁN, a connector-hívás ELŐTT.
      // A nyers source ID csak a végrehajtott argumentumba kerül; a `recordCall`
      // az eredeti `input.args`-ot (surrogate-alak) naplózza.
      const executionInput = await this.resolveInvokeArgs(
        input,
        actingTenantId,
        authorization.connector?.tenantId ?? null,
        actingUserId,
        authorization.connector ?? null,
      )
      assertToolInputWithinLimits(executionInput.tool, executionInput.args, contract)

      const result = await this.executeTool(
        executionInput,
        authorization,
        actingTenantId,
        actingUserId,
        webSearchEffective,
      )
      // issue #97 — bizalmi osztály a tool-nevenkénti regiszterből (determinisztikus,
      // args-független, az agent által nem befolyásolható).
      const trust = resolveTrustClass(input.tool)
      // issue #195 D1–D6 — a KIMENETI SZERZŐDÉS KAPUJA + a kétcsatornás eredmény.
      // Szándékosan az audit- és a `ToolCall`-rögzítés ELŐTT fut: séma-sértés →
      // `ToolContractError` (`failed`), és a hibás eredmény nem kerül be sikerként.
      // APG-04: a pszeudonimizáció a szerződés-validáció UTÁN, csak a `modelText` ágon.
      const channels = await buildPrivacyAwareOutcomeChannels({
        tool: input.tool,
        trust,
        output: result,
        contract,
        sideEffecting: isSideEffectingTool(input.tool),
        connector: authorization.connector,
        conversationId: input.conversationId,
        ticketId,
        actingTenantId,
        engine: this.structuredPrivacyEngine,
        mode: await this.resolvePrivacyMode(actingTenantId, input.agentId),
        audit: this.audit,
      })
      const { outcome, outcomeReason, effect, modelText, machineData } = channels

      const latencyMs = Date.now() - startedAt
      const meta = {
        ...resultMeta(result),
        outcome,
        outcome_reason: outcomeReason,
        effect,
      }

      await recordCall(this, {
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
        trustClass: trust,
        outcome,
        effect,
      })

      return {
        denied: false,
        trust,
        outcome,
        outcomeReason,
        effect,
        modelText,
        machineData,
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
        return recordDenied(this, 
          input,
          ticketId,
          authorization.connector?.id ?? null,
          'connector_grant_expired',
          startedAt,
          actingUserId,
          authorization.grant.id,
        )
      }

      // issue #195 — a szerződés-sértés TIPIZÁLT `failed` kimenetel, nem néma
      // továbbengedés: az audit-sor megmondja, MELYIK szerződés bukott
      // (séma / bemeneti méret / munkamennyiség).
      const contractViolation = e instanceof ToolContractError ? e.code : null
      const unknownSurrogate = e instanceof UnknownSurrogateError
      const privacyDecision =
        unknownSurrogate && e.reason === 'denied'
          ? 'privacy.resolve.denied'
          : unknownSurrogate
            ? 'privacy.surrogate.unknown'
            : null
      await recordCall(this, {
        input,
        ticketId,
        connectorId: authorization.connector?.id ?? null,
        status: 'error',
        latencyMs,
        policyDecision: contractViolation ?? privacyDecision ?? 'error',
        resultMeta: {
          error: message,
          outcome: 'failed',
          ...(contractViolation ? { contract_violation: contractViolation } : {}),
        },
        actingUserId,
        grantId: authorization.grant?.id ?? null,
        outcome: 'failed',
      })
      throw e
    }
  }

  /**
   * APG-05 §10.1 + APG-17 §9 — álnév → source ID, majd nyers név → source ID
   * a connector-hívás előtt. Az eredeti `input` (surrogate-alak) érintetlen marad
   * az audit / `argsMeta` számára.
   */
  private async resolveInvokeArgs(
    input: ToolBrokerInvokeInput,
    actingTenantId: string | null,
    connectorTenantId: string | null,
    actingUserId: string | null,
    connector: Connector | null,
  ): Promise<ToolBrokerInvokeInput> {
    if (!this.structuredPrivacyEngine) return input
    const tenantId = actingTenantId ?? connectorTenantId
    if (!tenantId) return input
    const ticketId = input.tool === 'board_write' ? input.args.ticketId : input.ticketId ?? null
    const scope = privacyScopeForCall(input.conversationId, ticketId)
    if (!scope) return input

    const resolved = await resolveToolArgs({
      args: input.args,
      engine: this.structuredPrivacyEngine,
      tenantId,
      scope,
      requesterUserId: actingUserId,
    })
    if (!resolved.ok) throw new UnknownSurrogateError(resolved.surrogate, resolved.reason)

    let args = resolved.args
    let totalResolved = resolved.resolvedCount
    let byCategory = resolved.byCategory

    if (
      connector &&
      connectorSupportsEntityResolution(connector.config) &&
      this.connectorEntityResolverFactory
    ) {
      const entityResolver = await this.connectorEntityResolverFactory({
        connector,
        actingUserId,
        agentId: input.agentId,
      })
      if (entityResolver) {
        const entityResolved = await resolveEntityNamesInToolArgs({
          args,
          engine: this.structuredPrivacyEngine,
          tenantId,
          scope,
          connectorId: connector.id,
          connectorConfig: connector.config,
          resolver: entityResolver,
        })
        args = entityResolved.args
        totalResolved += entityResolved.resolvedCount
        byCategory = mergePrivacySpanCategories(byCategory, entityResolved.byCategory)
      }
    }

    if (totalResolved === 0) return input
    await recordPrivacyGatewayAudit(this.audit, {
      action: 'privacy.resolve.applied',
      tenantId,
      scope,
      summary: {
        spanCount: totalResolved,
        categories: (Object.keys(byCategory) as Array<keyof typeof byCategory>).sort(),
        byCategory,
      },
      mode: await this.resolvePrivacyMode(tenantId, input.agentId),
      actorType: actingUserId ? 'human' : 'system',
      actorId: actingUserId,
      ticketId,
    })
    return { ...input, args } as ToolBrokerInvokeInput
  }

  /** APG-21 — pszeudonimizált agent-turn trace a debugging AI számára. */
  async fetchDebugTrace(
    input: Extract<ToolBrokerInvokeInput, { tool: 'get_debug_trace' }>,
    actingTenantId: string | null,
    actingUserId: string | null,
  ): Promise<import('./tool-broker-types').GetDebugTraceResult> {
    if (!this.debugTraceService || !this.structuredPrivacyEngine || !this.privacyPolicyResolver) {
      throw new Error('debug_trace_unavailable')
    }
    const agent = await this.agents.findById(input.agentId)
    const mode = await this.resolvePrivacyMode(actingTenantId, input.agentId)
    const policy = await this.privacyPolicyResolver({
      tenantId: actingTenantId,
      agentId: input.agentId,
      legacyAllowSensitiveExternalModel: agent?.allowSensitiveExternalModel ?? undefined,
    })
    return this.debugTraceService.getProjectedTrace({
      agentTurnId: input.args.agentTurnId,
      tenantId: actingTenantId,
      requesterUserId: actingUserId,
      engine: this.structuredPrivacyEngine,
      mode,
      policy,
    })
  }

  private async resolvePrivacyMode(
    tenantId: string | null,
    agentId: string,
  ): Promise<PrivacyGatewayMode> {
    if (!this.privacyModeResolver) return 'enforce'
    return this.privacyModeResolver({ tenantId, agentId })
  }

  private async webSearchBypassSensitivity(
    tenantId: string | null,
    agentId: string,
    query: string,
    legacyAllowSensitiveExternalModel: boolean,
  ): Promise<boolean> {
    if (!this.privacyCategoryActionResolver) return legacyAllowSensitiveExternalModel
    const safety = this.webSearchPolicy.classifyQuery(query)
    if (!safety.blocked) return false
    const action = await this.privacyCategoryActionResolver({
      tenantId,
      agentId,
      category: safety.category ?? '',
      legacyAllowSensitiveExternalModel,
    })
    return allowsExternalRaw(action)
  }

  private async executeTool(
    input: ToolBrokerInvokeInput,
    authorization: Extract<AuthorizationResult, { allowed: true }>,
    actingTenantId: string | null,
    actingUserId: string | null,
    webSearchEffective?: WebSearchEffectiveQuery,
  ) {
    // WP-8: adat-vezérelt dispatch. A tenant-izoláció, capability-gate, a
    // speciális kapuk (gmail-approval, board-ownership, web_search-policy), a
    // ToolCall-rögzítés és az audit a KERETBEN (invoke) maradnak — a handler
    // kizárólag a tool-specifikus végrehajtást adja, változatlan viselkedéssel.
    const handler = resolveToolHandler(input.tool)
    if (!handler) throw new Error(`Unknown tool: ${input.tool}`)
    const result = await handler.execute({
      ctx: this.handlerContext,
      input,
      authorization,
      actingTenantId,
      actingUserId,
      webSearchEffective,
    })
    return result as ToolExecutionResult
  }

  async resolveActingUserId(input: ToolBrokerInvokeInput): Promise<string | null> {
    const effectiveTicketId = input.tool === 'board_write' ? input.args.ticketId : input.ticketId
    if (effectiveTicketId) {
      const ticket = await this.tickets.findById(effectiveTicketId)
      // A ticket ID-je kliens által befolyásolható az agent API-n. Csak a hívó
      // agenthez rendelt ticket viheti tovább a tárolt, explicit run-as jogot;
      // különben egy másik agent ticketjének user-grantját lehetne megszemélyesíteni.
      if (ticket?.agentId === input.agentId) {
        const payload = isRecord(ticket.payload) ? ticket.payload : null
        if (isRunAsAuthorized(payload)) {
          // Materializált scheduled futásnál a ticket-payload csak hivatkozás;
          // a tényleges, visszavonható felhatalmazás a ScheduledTask sor. Egy
          // visszavont vagy más tickethez kötött task sosem ad acting-user jogot.
          if (typeof payload?.[SCHEDULED_TASK_ID] === 'string') {
            const scheduledTask = await prisma.scheduledTask.findUnique({
              where: { id: payload[SCHEDULED_TASK_ID] },
            })
            if (!isScheduledTaskRunAsAuthorized({
              ticketId: ticket.id,
              ticketTenantId: ticket.tenantId,
              payload,
              scheduledTask,
            })) return null
          }
          return readRunAsUserId(payload)
        }
        return null
      }
    }

    if (input.conversationId) {
      const conversation = await prisma.conversation.findUnique({
        where: { id: input.conversationId },
        select: { agentId: true, createdById: true },
      })
      // A beszélgetéshez kötött user-grant is csak a saját agent beszélgetéséből
      // származhat, sosem egy beküldött idegen conversationId-ból.
      if (conversation?.agentId === input.agentId) return conversation.createdById
    }

    // Külső agent API-hívásban az actingUserId csak a kérés törzséből jöhetne,
    // ami nem hitelesített felhatalmazás. A belső chat/harness útvonalak
    // továbbra is explicit, szerveroldalról feloldott identitást adnak át.
    if (input.actingUserSource !== 'external_agent_api' && input.actingUserId) {
      return input.actingUserId
    }

    return null
  }

  /**
   * A user.tenantId oszlop csak a user *default* tenantját tükrözi — ha a user
   * tenant-váltóval egy másik (nem-default) tenant kontextusában dolgozik, ezt
   * csak a ticket/conversation tenantId-je rögzíti. Ezért a ticket/conversation
   * tenant elsőbbséget élvez, a user.tenantId csak akkor fallback, ha egyik sincs.
   */
  async resolveActingTenantId(input: ToolBrokerInvokeInput, actingUserId: string): Promise<string | null> {
    const contextTenantId = await this.resolveContextTenantId(input)
    if (contextTenantId) return contextTenantId

    const user = await prisma.user.findUnique({
      where: { id: actingUserId },
      select: { tenantId: true },
    })
    return user?.tenantId ?? null
  }

  private async resolveContextTenantId(input: ToolBrokerInvokeInput): Promise<string | null> {
    const effectiveTicketId = input.tool === 'board_write' ? input.args.ticketId : input.ticketId
    if (effectiveTicketId) {
      const ticket = await this.tickets.findById(effectiveTicketId)
      if (ticket?.agentId === input.agentId && ticket.tenantId) return ticket.tenantId
    }

    if (input.conversationId) {
      const conversation = await prisma.conversation.findUnique({
        where: { id: input.conversationId },
        select: { agentId: true, tenantId: true },
      })
      if (conversation?.agentId === input.agentId && conversation.tenantId) return conversation.tenantId
    }

    return null
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
   * Következmény-kapu kiváltásának rögzítése (risk-class). Magas kockázatú
   * eszközhívás emberi jóváhagyást igényel: a tool-loop NEM a `invoke`-ot hívja,
   * hanem ezt: a blokkolt hívás bekerül a meglévő audit-láncba (`tool.call.denied`
   * + `ToolCall` sor `trustClass`-szal), hogy egy incidensnél végigkövethető legyen.
   */
  async recordConsequenceGateBlock(input: ToolBrokerInvokeInput): Promise<void> {
    const startedAt = Date.now()
    const ticketId = input.tool === 'board_write' ? input.args.ticketId : input.ticketId ?? null
    await recordCall(this, {
      input,
      ticketId,
      connectorId: null,
      status: 'denied',
      latencyMs: Date.now() - startedAt,
      policyDecision: 'consequence_gate_risk',
      resultMeta: { denied: true, reason: 'risk_requires_approval' },
      trustClass: resolveTrustClass(input.tool),
    })
  }

}
