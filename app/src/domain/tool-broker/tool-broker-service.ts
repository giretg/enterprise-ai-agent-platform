import type {
  Prisma,
} from '@prisma/client'

import { prisma } from '@/lib/db'

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
  userDirectory,
  webResearchRequest,
} from './tool-broker-delegation'
// WP-8 — az audit/telemetria choke-point külön modulban (tool-broker-audit.ts).
import { recordCall, recordDenied } from './tool-broker-audit'
// issue #97 — bizalmi regiszter (tool-nevenkénti TrustClass leképezés).
import { resolveTrustClass } from './tool-trust-registry'
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
export class ToolBrokerService {
  delegationProcessor: DelegationProcessor | null = null
  playbookTransitioner: PlaybookTicketTransitioner | null = null

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
      agentResolve: (args, tenantId) => agentResolve(this, args, tenantId),
      agentCatalog: (args, tenantId) => agentCatalog(this, args, tenantId),
      userDirectory: (input, actingTenantId) => userDirectory(this, input, actingTenantId),
      executeHttpApiTool: (input, connector, actingTenantId, actingUserId, agentSecretAlias, delegatedAccessToken) =>
        executeHttpApiTool(this, input, connector, actingTenantId, actingUserId, agentSecretAlias, delegatedAccessToken),
      repoPrepare: (input, connector, actingTenantId) =>
        repoPrepare(this, input, connector, actingTenantId),
      repoOpenPullRequest: (input, connector, actingTenantId) =>
        repoOpenPullRequest(this, input, connector, actingTenantId),
      memoryPropose: (input, actingTenantId) => memoryPropose(this, input, actingTenantId),
      documentRead: (input, actingUserId) => documentRead(this, input, actingUserId),
      tulajdoniLapParse: (input, actingUserId, extras) =>
        tulajdoniLapParse(this, input, actingUserId, extras),
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
        bypassSensitivity: agent?.allowSensitiveExternalModel ?? false,
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
      // issue #97 — bizalmi osztály a tool-nevenkénti regiszterből (determinisztikus,
      // args-független, az agent által nem befolyásolható).
      const trust = resolveTrustClass(input.tool)

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
      })

      return {
        denied: false,
        trust,
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

      await recordCall(this, {
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
