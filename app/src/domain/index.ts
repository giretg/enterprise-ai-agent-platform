import {
  ModelGateway,
  type AgentSensitivityPolicyReader,
  type AgentTenantResolver,
} from '@/domain/gateway/model-gateway'
import { RoutingEngine } from '@/domain/gateway/routing-engine'
import { BudgetEngine } from '@/domain/gateway/budget-engine'
import { BookkeeperAgentRuntime } from '@/domain/agent/bookkeeper-runtime'
import { AgentChatRuntime } from '@/domain/agent/agent-chat-runtime'
import { GeneralTaskRuntime } from '@/domain/agent/general-task-runtime'
import { WikiAgentRuntime } from '@/domain/agent/wiki-runtime'
import { TicketService } from '@/domain/ticket/ticket-service'
import { MemoryRetrievalService } from '@/domain/memory/memory-retrieval-service'
import { MemoryProposalService } from '@/domain/memory/memory-proposal-service'
import { MemoryApprovalService } from '@/domain/memory/memory-approval-service'
import { MemoryRollbackService } from '@/domain/memory/memory-rollback-service'
import { MemoryMaintenanceService } from '@/domain/memory/memory-maintenance-service'
import { TrainingService } from '@/domain/training/training-service'
import { SelfEvolutionGuard } from '@/domain/training/self-evolution-guard'
import { AuditChainService } from '@/domain/audit/audit-chain-service'
import { WriteGateService } from '@/domain/writegate/write-gate-service'
import { EvalService } from '@/domain/eval/eval-service'
import {
  DispatcherService,
  dispatchBudgetFromEnv,
  type HarnessLauncher,
} from '@/domain/dispatcher/dispatcher-service'
import { MonitorDispatchAlertNotifier } from '@/domain/dispatcher/dispatch-alert-notifier'
import { PlatformSettingsService } from '@/domain/platform-settings/platform-settings-service'
import { CloudRunJobHarnessLauncher, cloudRunConfigFromEnv } from '@/domain/dispatcher/cloud-run-job-launcher'
import {
  DockerLocalHarnessLauncher,
  dockerLocalConfigFromEnv,
} from '@/domain/dispatcher/docker-local-harness-launcher'
import { LocalWikiHarnessLauncher } from '@/domain/dispatcher/local-wiki-harness-launcher'
import { AllowlistAuthorizer, ToolBrokerService } from '@/domain/tool-broker/tool-broker-service'
import { createPlatformSurrogateEngine } from '@/domain/privacy/create-surrogate-engine'
import { ConversationPrivacyResolveAccess } from '@/domain/privacy/resolve-access'
import { resolveChannelOutboundText } from '@/domain/privacy/resolve-display-text'
import {
  buildUserInputEntityResolution,
  createConnectorEntityResolver,
} from '@/domain/privacy/entity-resolution-runtime'
import { allowsExternalRaw } from '@/domain/privacy/privacy-category-policy'
import { ConsequenceApprovalService } from '@/domain/tool-broker/consequence-approval-service'
import { WebSearchPolicyService } from '@/domain/web-search/web-search-policy-service'
import { WebSearchService } from '@/domain/web-search/web-search-service'
import { HttpSearchProviderAdapter, StubSearchProviderAdapter } from '@/domain/web-search/search-provider-adapter'
import { findPlatformWebSearchConnector } from '@/domain/web-search/web-search-connector-service'
import { parseWebSearchConfig, type WebSearchAdapterResolver, type WebSearchResult } from '@/domain/web-search/web-search-types'
import { WebFetchService } from '@/domain/web-fetch/web-fetch-service'
import { performAuditedWebFetch } from '@/domain/web-fetch/audited-web-fetch'
import { resolveWebFetchLimitsFromEnv } from '@/domain/web-fetch/web-fetch-types'
import { ConnectorGrantService } from '@/domain/connector-grant/connector-grant-service'
import { WorkspaceStorage } from '@/domain/file-editor/workspace-storage'
import { FileEditorService } from '@/domain/file-editor/file-editor-service'
import { WorkspaceLifecycleService } from '@/domain/file-editor/workspace-lifecycle-service'
import { RecipeService } from '@/domain/recipe/recipe-service'
import { SkillService } from '@/domain/skill/skill-service'
import { ConversationService } from '@/domain/conversation/conversation-service'
import { DebugLogExportService } from '@/domain/debug-log/debug-log-export-service'
import { DebugTraceService } from '@/domain/debug-log/debug-trace-service'
import { RunIndexService } from '@/domain/run-analysis/run-index-service'
import { RunTraceService } from '@/domain/run-analysis/run-trace-service'
import { RunStatsService } from '@/domain/run-analysis/run-stats-service'
import { ChannelBotService } from '@/domain/channel/channel-bot-service'
import { ChannelLinkingService } from '@/domain/channel/channel-linking-service'
import { ChannelTurnService } from '@/domain/channel/channel-turn-service'
import { AgentChatChannelRuntime } from '@/domain/channel/channel-agent-runtime-adapter'
import { ChannelNotificationService } from '@/domain/channel/channel-notification-service'
import { ChannelAgentAccessService } from '@/domain/channel/channel-agent-access-service'
import {
  ChannelApprovalService,
  type ApprovalInitiatorNotifier,
  type ApprovalRecipientDirectory,
  type ApprovalTicketReader,
  type ApprovalTransitioner,
} from '@/domain/channel/channel-approval-service'
import type { ApprovalAction } from '@/domain/channel/channel-approval-token'
import type { CompiledSpec } from '@/domain/playbook/playbook-compiler'
import { meetsMinRole } from '@/lib/iam-policy'
import { ChannelMetricsService } from '@/domain/channel/channel-metrics-service'
import { ChannelRetentionService } from '@/domain/channel/channel-retention-service'
import { TelegramOutboundTransport } from '@/domain/channel/channel-outbound-transport'
import { TelegramMonitorNotifier } from '@/lib/notify/telegram-monitor-notifier'
import { notifyChannelTurnReady } from '@/lib/channel-notify'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { PlaybookService } from '@/domain/playbook/playbook-service'
import { PlaybookV2Service } from '@/domain/playbook/playbook-v2-service'
import { ProcessService } from '@/domain/playbook/process-service'
import { MonitorProcessAlertNotifier } from '@/domain/playbook/process-alert-notifier'
import { ProcessDefinitionService } from '@/domain/playbook/process-definition-service'
import { TicketStateMachine } from '@/domain/playbook/ticket-state-machine'
import { IamService } from '@/domain/iam/iam-service'
import { TenantService } from '@/domain/tenant/tenant-service'
import { SandboxAppService } from '@/domain/sandbox/sandbox-app-service'
import { GcsArtifactStore } from '@/domain/sandbox/artifact-store'
import { SandboxVersioningService } from '@/domain/sandbox-versioning/sandbox-versioning-service'
import { GcsCodeTreeStore, GcsDataSnapshotStore } from '@/domain/sandbox-versioning/stores'
import { ScheduledTaskService } from '@/domain/scheduled-task/scheduled-task-service'
import { MonitorService } from '@/domain/monitor/monitor-service'
import { DeadlineCollector } from '@/domain/monitor/collectors/deadline-collector'
import { BoardBacklogCollector } from '@/domain/monitor/collectors/board-collector'
import { ConnectorCountCollector } from '@/domain/monitor/collectors/connector-count-collector'
import { KnowledgeBaseService } from '@/domain/knowledge-base/knowledge-base-service'
import { ProvisioningService } from '@/domain/provisioning/provisioning-service'
import { HttpSandboxConnectionTester } from '@/domain/provisioning/sandbox-connection-tester'
import {
  isTrustedExternalConnectorSecretAlias,
  parseTrustedConnectorSecretAliasPolicy,
} from '@/domain/provisioning/connector-secret-alias-policy'
import {
  ProvisioningAssistant,
  PROVISIONING_DRAFT_CAPABILITIES,
} from '@/domain/provisioning/provisioning-assistant'
import { PlaybookAuthorAgent } from '@/domain/playbook/playbook-author-agent'
import { AgentScaffoldAgent } from '@/domain/agents/agent-scaffold-agent'
import { SkillDistillerAgent } from '@/domain/skill/skill-distiller-agent'
import { SkillReviewAgent } from '@/domain/skill/skill-review-agent'
import {
  AuditOnlyMonitorNotifier,
  RoutingMonitorNotifier,
} from '@/lib/notify/monitor-notifier'
import { WebhookChatNotifier } from '@/lib/notify/webhook-chat-notifier'
import { repositories } from '@/repositories/postgres'
import { resolveConnectorApiKey } from '@/domain/connector/http-api-client'
import { createTtlSecretCache } from '@/lib/crypto/ttl-secret-cache'
import { prisma } from '@/lib/db'
import { AgentAccessService } from '@/domain/agent-access/agent-access-service'
import { isWebEgressAgent } from '@/lib/platform-agent-registry'
import { AGENT_GRAPH_NODE_SELECT } from '@/domain/agent-access/agent-graph-node-select'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { SpecSyncService } from '@/domain/connector-self-update/spec-sync'
import { SelfUpdatingConnectorService } from '@/domain/connector-self-update/self-update-service'

const playbookService = new PlaybookService(repositories.playbooks, repositories.audit)
const selfUpdatingConnectorService = new SelfUpdatingConnectorService(
  repositories.selfUpdatingConnectors,
  new SpecSyncService({
    resolveHostIps: async (host) => (await lookup(host, { all: true })).map((entry) => entry.address),
  }),
  {
    append: async (event) => {
      await repositories.audit.append({
        actorType: event.actorId ? 'human' : 'system',
        actorId: event.actorId,
        agentVersion: null,
        action: event.action,
        targetType: 'connector',
        targetId: event.connectorId,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: event.policyDecision,
        metadata: (event.metadata ?? {}) as import('@prisma/client').Prisma.JsonValue,
        tenantId: event.tenantId,
      })
    },
  },
)
// Hibapolicy spec §4.2/WP-4 — a tenant-default lekérdezője function-ként injektált (mint a
// `ticketService` ticket-type-config lekérdezője lejjebb), mert a `platformSettingsService`
// csak KÉSŐBB (ebben a fájlban) épül fel — a closure csak publish-hívásnál fut le, akkorra
// már biztosan létezik (ugyanaz a lazy-referencia minta, mint a dispatcherService-nél).
const playbookV2Service = new PlaybookV2Service(
  repositories.playbooksV2,
  repositories.audit,
  (tenantId) => platformSettingsService.getTenantDefaultErrorPolicy(tenantId),
)
// Proaktív értesítés Telegramra (#77, D7/D11): a Monitor-riasztás a csatorna HARMADIK bejáratán
// (ChannelNotificationService) megy ki — a Monitor sosem hívja közvetlenül a Telegramot. A kimenő
// átvitel UGYANAZ a deny-by-default Telegram-adapter, mint az összekötésé; a bot-token a
// platform-bot titok-referenciájából oldódik fel, a hívás pillanatában.
const channelNotificationService = new ChannelNotificationService({
  bots: repositories.channelBots,
  identities: repositories.channelIdentities,
  transport: new TelegramOutboundTransport({
    resolveBotToken: async () => {
      const bot = await repositories.channelBots.findPlatformBot('telegram')
      if (!bot) throw new Error('no platform telegram bot registered')
      return resolveConnectorApiKey(bot.accessKeySecretRef)
    },
    resolveHostIps: async (host) => (await lookup(host, { all: true })).map((e) => e.address),
  }),
  audit: repositories.audit,
})
const monitorNotifier = new RoutingMonitorNotifier(
  {
    chat: new WebhookChatNotifier(),
    // `telegram:<userId>` → az adott platform-felhasználó AKTÍV, azonos szervezetű kötése.
    telegram: new TelegramMonitorNotifier({ notifications: channelNotificationService }),
  },
  new AuditOnlyMonitorNotifier(),
)
// Lazy referencia: a `dispatcherService` lejjebb, ProcessService-en TÚL épül fel (a
// local-wiki launcher a wiki/generalTask runtime-okra épít, azok meg a processService-re
// hivatkoznak toolBrokerServicen át) — kör nélkül csak függvényreferenciával adható át.
// A closure csak akkor fut le, amikor egy ticket ready lesz, tehát a modul-inicializálás
// végére `dispatcherService` már biztosan létezik (TDZ csak azonnali hívásnál számítana).
const processService = new ProcessService(
  repositories.processes,
  repositories.playbooksV2,
  repositories.tickets,
  repositories.audit,
  // §7 Folyamat-alapú indítás: szerep→agent feloldás + alkalmasság-ellenőrzés.
  repositories.processDefinitions,
  repositories.agents,
  repositories.toolBroker,
  repositories.users,
  // §4.3/§4.8 — emberi szerep tenant-tagság (membership-modell) a resolveUserForRole cross-tenant kapujához.
  repositories.tenantMemberships,
  new MonitorProcessAlertNotifier(monitorNotifier),
  (ticketId: string) => dispatcherService.dispatchTicket(ticketId),
)
const processDefinitionService = new ProcessDefinitionService(
  repositories.processDefinitions,
  repositories.playbooksV2,
  repositories.agents,
  repositories.toolBroker,
  repositories.rolePermissions,
  repositories.users,
  // §4.3/§4.8 — emberi szerep tenant-tagsági kapu az aktiváláskor.
  repositories.tenantMemberships,
  repositories.audit,
)
const ticketStateMachine = new TicketStateMachine(
  repositories.tickets,
  repositories.playbooksV2,
  repositories.processes,
  repositories.audit,
  processService,
)
const platformSettingsService = new PlatformSettingsService(
  repositories.platformSettings,
  repositories.audit,
)

async function resolveAgentRole(agentId: string | null): Promise<'worker' | 'orchestrator'> {
  if (!agentId) return 'worker'
  const agent = await repositories.agents.findById(agentId)
  return agent?.role === 'orchestrator' ? 'orchestrator' : 'worker'
}

const ticketService = new TicketService(
  repositories.tickets,
  repositories.audit,
  playbookService,
  resolveAgentRole,
  (type) => platformSettingsService.getTicketTypeConfig(type),
)

const conversationService = new ConversationService(
  repositories.conversations,
  repositories.tickets,
  repositories.audit,
  playbookService,
)

const debugLogExportService = new DebugLogExportService(
  prisma,
  conversationService,
  repositories.tickets,
  repositories.audit,
  repositories.toolBroker,
)
const debugTraceService = new DebugTraceService(
  prisma,
  repositories.toolBroker,
  repositories.audit,
  new ConversationPrivacyResolveAccess(repositories.conversations, repositories.tickets),
)
const runIndexService = new RunIndexService(prisma, repositories.audit)
const runTraceService = new RunTraceService(prisma, repositories.audit)
const runStatsService = new RunStatsService(prisma, repositories.audit, runIndexService)
// A `channelBotService` a kimenő átvitel UTÁN épül (a beüzemelő `setWebhook`/`getMe` hívások
// ugyanazon az egress-őrzött kapun mennek ki) — l. lejjebb, a `telegramOutboundTransport` alatt.
// A chat-futásidőt a linking-szolgáltatás egy sink-en át éri el (a bekötött üzenet forduló-sorba
// írása, D8). A `ChannelTurnService` az `AgentChatRuntime` UTÁN épül (az függ tőle), ezért a
// sink egy késleltetett referencián keresztül delegál — a bejövő üzenet csak futásidőben ér ide.
let channelTurnServiceRef: ChannelTurnService | null = null
// Csatorna összekötés/visszavonás (#72, D12). A varrat kimenete a befecskendezett kimenő
// átvitel (Telegram vagy teszt-dublőr); a webhook titkos fejléc a bot referenciájából oldódik
// fel; a deep-link a platform-bot Telegram-felhasználónevéből épül (env). A platform-oldali
// értesítés a `user_notifications` sorba kerül (D12 story 3).
const telegramBotUsername = process.env.TELEGRAM_BOT_USERNAME?.trim() || 'YourPlatformBot'
// A bejövő webhook titok-feloldását EGYETLEN, megosztott TTL-cache fedi (a részletes indoklás
// a `ttl-secret-cache.ts` modul-dokumentációjában). Azért ITT, wiring-szinten képződik, hogy a
// linking- ÉS a jóváhagyó-belépő UGYANAZT a cache-példányt ossza (a `webhookSecretRef` kulcson):
// az egyik úton bemelegített titok a másikat is kiszolgálja. TTL env-ből hangolható.
//
// A `0` ÉRVÉNYES beállítás: azt jelenti, hogy "ne cache-elj" (minden kérés újra feloldja a
// titkot) — ez az üzemeltető kikapcsoló kapcsolója, ha egy rotációnak azonnal érvényesülnie
// kell. Ezért NEM `Number(...) || 60_000`: az a `0`-t némán 60 mp-re írná át, és a kikapcsolás
// hatástalan maradna. Csak a hiányzó/értelmezhetetlen/negatív érték esik vissza az alapra.
// (Az ÜRES env-érték — `CHANNEL_WEBHOOK_SECRET_TTL_MS=` egy .env-ben — "nincs beállítva",
// nem `0`: különben egy odaírt, de kitöltetlen sor kapcsolná ki csendben a cache-t.)
const rawWebhookSecretTtl = process.env.CHANNEL_WEBHOOK_SECRET_TTL_MS?.trim()
const parsedWebhookSecretTtl = rawWebhookSecretTtl ? Number(rawWebhookSecretTtl) : Number.NaN
const webhookSecretTtlMs =
  Number.isFinite(parsedWebhookSecretTtl) && parsedWebhookSecretTtl >= 0
    ? parsedWebhookSecretTtl
    : 60_000
const resolveWebhookSecretCached = createTtlSecretCache(
  (secretRef) => resolveConnectorApiKey(secretRef),
  webhookSecretTtlMs,
)
// A kimenő átvitel (D11) EGYETLEN példány — a linking-varrat, a worker-varrat ÉS a megőrzési
// takarítás is ezen küld, hogy ne legyen második, dublőrözhetetlen kijárat a Telegram felé.
const telegramOutboundTransport = new TelegramOutboundTransport({
  resolveBotToken: async () => {
    const bot = await repositories.channelBots.findPlatformBot('telegram')
    if (!bot) throw new Error('no platform telegram bot registered')
    return resolveConnectorApiKey(bot.accessKeySecretRef)
  },
  resolveHostIps: async (host) => (await lookup(host, { all: true })).map((e) => e.address),
})
// A platform-bot regisztrációja ÉS beüzemelése (#70/#71, D3/D14). A beüzemelő hívások
// (`setWebhook`, `getMe`, `getWebhookInfo`) a KÖZÖS kimenő kapun mennek ki — nincs második,
// egress-őr nélküli kijárat a Telegram felé. A webhook-cím a publikus app-címből épül: ha az
// nincs beállítva, a beüzemelő képernyő ezt kimondja, ahelyett hogy egy localhost-címet kötne be.
const channelBotService = new ChannelBotService({
  bots: repositories.channelBots,
  audit: repositories.audit,
  transport: telegramOutboundTransport,
  resolveWebhookSecret: (bot) => resolveWebhookSecretCached(bot.webhookSecretRef),
  resolveWebhookUrl: (channelType) =>
    `${resolvePublicAppOrigin()}/api/channels/${channelType}/webhook`,
  resolveBotUsername: () => ({
    username: telegramBotUsername,
    configured: Boolean(process.env.TELEGRAM_BOT_USERNAME?.trim()),
  }),
  isPublicAppUrlConfigured: () => Boolean(process.env.NEXT_PUBLIC_APP_URL?.trim()),
})
const channelLinkingService = new ChannelLinkingService({
  bots: repositories.channelBots,
  identities: repositories.channelIdentities,
  sessions: repositories.channelSessions,
  linkTokens: repositories.channelLinkTokens,
  onTurnEnqueued: notifyChannelTurnReady,
  transport: telegramOutboundTransport,
  // A bot saját kimenő üzeneteit rögzítjük a megőrzési takarításhoz (D4/#78).
  outboundLog: repositories.channelOutboundMessages,
  audit: repositories.audit,
  notifier: {
    async linkEstablished({ userId, tenantId, orgName, channelType }) {
      const org = orgName?.trim() ? `„${orgName.trim()}"` : 'a szervezeted'
      await repositories.userNotifications.create({
        userId,
        tenantId,
        kind: 'channel.link.established',
        title: 'Telegram-fiók összekötve',
        body:
          `A(z) ${org} szervezethez most egy Telegram-fiók lett összekötve a nevedben. ` +
          'Ha nem te voltál, a Fiókom oldalon azonnal szüntesd meg az összekötést.',
        metadata: { channelType },
      })
    },
  },
  resolveOrgName: async (tenantId) => {
    if (!tenantId) return null
    const tenant = await repositories.tenants.findById(tenantId)
    return tenant?.displayName ?? null
  },
  resolveWebhookSecret: (bot) => resolveWebhookSecretCached(bot.webhookSecretRef),
  buildDeepLink: (jti) => `https://t.me/${telegramBotUsername}?start=${jti}`,
  isChannelEnabled: (tenantId) => platformSettingsService.isChannelEnabledForTenant(tenantId),
  linkedMessageSink: {
    enqueueInbound: (input) => {
      if (!channelTurnServiceRef) throw new Error('channel turn service not initialized')
      return channelTurnServiceRef.enqueueInbound(input)
    },
  },
})
// A `ChannelTurnService` (a worker MÁSODIK munkatípusa, #73/#74, D8) az `AgentChatRuntime` UTÁN
// épül fel lejjebb (az agent-futáshoz szüksége van rá) — l. `channelTurnServiceRef` fent.
// Üzemeltetői metrikák (#78, story 59) — az audit-láncból és a csatorna-táblák állapotából.
const channelMetricsService = new ChannelMetricsService({
  audit: repositories.audit,
  metrics: repositories.channelMetrics,
  bots: repositories.channelBots,
})
// A bot saját kimenő üzeneteinek megőrzési takarítása (#78, D4) — a közös kimenő átvitelen.
const channelRetentionService = new ChannelRetentionService({
  outbound: repositories.channelOutboundMessages,
  transport: telegramOutboundTransport,
  audit: repositories.audit,
})
// Csatorna-agent-hozzáférés (#75, D5/D9/D13/D54). A metszet bal oldala (platform-jog) az
// agent-registry szervezeti szűrése (a per-felhasználó dedikálás élesítésekor magától
// szigorodik — #70 Further Notes 1); a kill-switch a szervezeti Telegram-kapcsoló.
const channelAgentAccessService = new ChannelAgentAccessService({
  grants: repositories.channelAgentGrants,
  identities: repositories.channelIdentities,
  agents: {
    async listForTenant(tenantId) {
      const agents = await repositories.agents.findMany({ tenantId })
      return agents.map((a) => ({ id: a.id, name: a.name, usable: a.status === 'active' }))
    },
    async findInTenant(agentId, tenantId) {
      const agent = await repositories.agents.findById(agentId, tenantId)
      if (!agent) return null
      return { id: agent.id, name: agent.name, usable: agent.status === 'active' }
    },
  },
  isChannelEnabled: (tenantId) => platformSettingsService.isChannelEnabledForTenant(tenantId),
  audit: repositories.audit,
})

// Eseményvezérelt jóváhagyás Telegram-gombokkal (#76, D5/D6/D11/D14). A ticket-állapotgép
// `awaiting_human` eseményére (l. `processService.setAwaitingHumanSink` lentebb) a felelős /
// jóváhagyói kör jogosultság-tudatos gombokat kap; a koppintás a KÖZÖS állapotgépet lépteti.
// A jogosultsági modell TÜKRÖZI a webes utat (`transitionProcessTicket`): a jóváhagyó jogot a
// tenant-szerep (`operator`+) képviseli, és ugyanaz a `roles:[tenant-szerep]` megy az állapotgépnek.
const approvalTicketReader: ApprovalTicketReader = {
  async load({ ticketId, tenantId }) {
    const ticket = await repositories.tickets.findById(ticketId)
    if (!ticket || ticket.tenantId !== tenantId) return null
    let requiredActorRole: string | null = null
    let allowedActions: ApprovalAction[] = ['approve', 'reject']
    if (ticket.playbookVersionId && ticket.playbookStepId) {
      const version = await repositories.playbooksV2.findVersion(tenantId, ticket.playbookVersionId)
      const compiled = version?.compiledSpec as CompiledSpec | undefined
      if (compiled) {
        if (ticket.requiredGateId) {
          const gate = compiled.gates.find((g) => g.gateId === ticket.requiredGateId)
          requiredActorRole = gate?.requiredActorRole ?? null
        }
        const rule = compiled.ticketRules.find((r) => r.stepId === ticket.playbookStepId)
        if (rule) {
          // Csak azok az egy-koppintásos döntések, amelyekre van `awaiting_human`→X átmenet
          // a compiled specben (a `needs_info` szerkezetileg kizárt — nem egy-koppintásos).
          const toStates = new Set(
            rule.allowedTransitions.filter((t) => t.fromState === 'awaiting_human').map((t) => t.toState),
          )
          const filtered = (['approve', 'reject'] as ApprovalAction[]).filter((a) =>
            toStates.has(a === 'approve' ? 'approved' : 'rejected'),
          )
          if (filtered.length > 0) allowedActions = filtered
        }
      }
    }
    return {
      ticketId: ticket.id,
      tenantId: ticket.tenantId,
      state: ticket.state,
      gateId: ticket.requiredGateId,
      stepId: ticket.playbookStepId,
      requiredActorRole,
      // A gate-ticketet a rendszer hozza létre (createdById = rendszer-user); nem-rendszer ticketnél
      // a valós kezdeményező. A „saját kérés jóváhagyása tiltott" élő kapu ehhez méri a koppintót.
      initiatorUserId: ticket.createdById,
      assigneeUserId: ticket.assigneeType === 'human' ? ticket.assigneeId : null,
      title: ticket.title,
      detailUrl: null,
      allowedActions,
    }
  },
}
const approvalRecipientDirectory: ApprovalRecipientDirectory = {
  async listApprovers({ tenantId }) {
    if (!tenantId) return []
    const members = await repositories.tenantMemberships.findByTenant(tenantId, { status: 'active' })
    // A jóváhagyói kör: az `operator`+ (rank ≥ operator) tagok — mint a webes jóváhagyó-kapu.
    return members
      .filter((m) => meetsMinRole(m.role, 'operator'))
      .map((m) => ({ userId: m.userId, roles: [m.role] }))
  },
  async rolesForUser({ userId, tenantId }) {
    if (!tenantId) return []
    const m = await repositories.tenantMemberships.findByTenantAndUser(tenantId, userId)
    return m && m.status === 'active' ? [m.role] : []
  },
}
const approvalTransitioner: ApprovalTransitioner = {
  async decide({ ticketId, tenantId, toState, actorUserId, roles, gateId }) {
    try {
      await ticketStateMachine.transitionTicket({
        tenantId,
        ticketId,
        toState,
        actor: { type: 'user', id: actorUserId, roles },
        // Kapu-ághoz a jóváhagyási bizonyíték a döntés csatornája (evidenceRequired kapu esetén kell).
        approvalEvidence: gateId ? { channel: 'telegram', decidedVia: 'button' } : undefined,
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : 'transition_failed' }
    }
  },
}
const approvalInitiatorNotifier: ApprovalInitiatorNotifier = {
  async decisionMade({ initiatorUserId, tenantId, ticketId, decision, title }) {
    const approved = decision === 'approve'
    await repositories.userNotifications.create({
      userId: initiatorUserId,
      tenantId,
      kind: 'channel.approval.decided',
      title: approved ? 'Kérésedet jóváhagyták' : 'Kérésedet elutasították',
      body: `A(z) „${title}" kérésről döntöttek Telegramon: ${approved ? 'Jóváhagyva' : 'Elutasítva'}.`,
      metadata: { ticketId, decision },
    })
  },
}
const channelApprovalService = new ChannelApprovalService({
  bots: repositories.channelBots,
  identities: repositories.channelIdentities,
  prompts: repositories.channelApprovalPrompts,
  tickets: approvalTicketReader,
  recipients: approvalRecipientDirectory,
  transitioner: approvalTransitioner,
  transport: telegramOutboundTransport,
  audit: repositories.audit,
  resolveWebhookSecret: (bot) => resolveWebhookSecretCached(bot.webhookSecretRef),
  initiatorNotifier: approvalInitiatorNotifier,
})
// #76 prefactor — a ProcessService `awaiting_human` eseménye a jóváhagyó-szolgáltatáshoz köt
// (a runtime NEM hív közvetlenül Telegramot, D11). Best-effort: a `notifyAwaitingHuman` sosem dob,
// és a négyórás elakadás-figyelő biztonsági hálóként FÜGGETLENÜL megmarad.
processService.setAwaitingHumanSink({
  awaitingHuman: async (event) => {
    await channelApprovalService.notifyAwaitingHuman({
      ticketId: event.ticketId,
      tenantId: event.tenantId,
    })
  },
})

const connectorGrantService = new ConnectorGrantService(repositories.connectorGrants, repositories.audit)
const workspaceBucket = process.env.WORKSPACE_BUCKET ?? 'platform-workspace-prod'
const workspaceStorage = new WorkspaceStorage(workspaceBucket)
const fileEditorService = new FileEditorService(workspaceStorage)
const workspaceLifecycleService = new WorkspaceLifecycleService(
  repositories.connectors,
  (bucket) => new WorkspaceStorage(bucket),
)
const toolAuthorizer = new AllowlistAuthorizer(
  repositories.toolBroker,
  repositories.agents,
  repositories.connectorGrants,
)
const routingEngine = new RoutingEngine(repositories.modelRoutingPolicies)
const budgetEngine = new BudgetEngine(repositories.modelBudgets, repositories.modelCalls)
// Sensitivity router: a kategória-policy `allow` akcióját a gateway az agentId-ból
// oldja fel (APG-11). A régi boolean mező csak a resolver legacy overlaye.
const agentSensitivityPolicy: AgentSensitivityPolicyReader = {
  async actionForCategory(agentId: string, category: string) {
    const agent = await repositories.agents.findById(agentId)
    return platformSettingsService.resolvePrivacyCategoryAction({
      tenantId: agent?.tenantId ?? null,
      agentId,
      category,
      legacyAllowSensitiveExternalModel: agent?.allowSensitiveExternalModel ?? false,
    })
  },
  async allowsSensitiveExternalModel(agentId: string): Promise<boolean> {
    const action = await agentSensitivityPolicy.actionForCategory!(agentId, 'email')
    return allowsExternalRaw(action)
  },
}
// A keret- és routing-kapu szervezet-helyessége: a futásidejű hívási helyek nem
// visznek `tenantId`-t, ezért a gateway az agentből oldja fel. Enélkül egy másik
// szervezet napi kerete állította meg ezt az agentet.
const agentTenantResolver: AgentTenantResolver = {
  async tenantIdForAgent(agentId: string): Promise<string | null> {
    const agent = await repositories.agents.findById(agentId)
    return agent?.tenantId ?? null
  },
}
const modelGateway = new ModelGateway(
  repositories.audit,
  repositories.modelCalls,
  undefined,
  undefined,
  routingEngine,
  budgetEngine,
  undefined, // sensitivityPolicy → env (sensitivityPolicyFromEnv)
  repositories.platformSettings, // D11 — model.pricing tarifa a valódi costEstimate-hez
  agentSensitivityPolicy,
  agentTenantResolver,
)
// Tartós agent-memória (agent-memory-persistent-cross-conversation-spec.md
// WP-2/WP-4): a retrieval service pure, a proposal service a T1 candidate-írást
// végzi — mindkettő a chat/task/bookkeeper runtime-okba és a Tool Brokerbe injektálva.
const memoryRetrievalService = new MemoryRetrievalService(repositories.memoryChunks)
const memoryProposalService = new MemoryProposalService(
  repositories.agents,
  repositories.memoryCandidates,
  repositories.memoryChunks,
  repositories.audit,
)
const bookkeeperRuntime = new BookkeeperAgentRuntime(
  repositories.agents,
  repositories.documents,
  repositories.tickets,
  modelGateway,
  ticketService,
  conversationService,
  repositories.audit,
  memoryRetrievalService,
)
const writeGateService = new WriteGateService(repositories.audit)
const evalService = new EvalService()
const selfEvolutionGuard = new SelfEvolutionGuard(repositories.audit)
const trainingService = new TrainingService(
  repositories.tickets,
  repositories.audit,
  ticketService,
  writeGateService,
  evalService,
  repositories.agents,
  selfEvolutionGuard,
)
// Tartós agent-memória — WP-6 (agent-memory-persistent-cross-conversation-spec.md
// §6.3/§9.4): candidate → T2 chunk jóváhagyás, inline write-gate consume vagy
// ticket-elágazással (a `TrainingService.approveTraining` mintáját követi).
const memoryApprovalService = new MemoryApprovalService(
  repositories.agents,
  repositories.memoryCandidates,
  repositories.memoryChunks,
  repositories.audit,
  writeGateService,
  evalService,
  repositories.rolePermissions,
  repositories.tickets,
  ticketService,
  repositories.memoryVersions,
)
// Tartós agent-memória — WP-8 (agent-memory-persistent-cross-conversation-spec.md
// §9.3/§8): manifest-alapú, append-only rollback + proposal-only maintenance job.
const memoryRollbackService = new MemoryRollbackService(
  repositories.memoryChunks,
  repositories.memoryVersions,
  repositories.audit,
)
const memoryMaintenanceService = new MemoryMaintenanceService(
  repositories.memoryChunks,
  repositories.memoryCandidates,
  repositories.audit,
  repositories.agents,
)
const sandboxAppBucket = process.env.SANDBOX_APP_BUCKET ?? 'platform-sandbox-apps-prod'
const sandboxAppService = new SandboxAppService(
  repositories.sandboxApps,
  repositories.tickets,
  repositories.conversations,
  repositories.audit,
  new GcsArtifactStore(sandboxAppBucket),
)

// Sandbox verziózás / promóció / graduation (SandboxVersioning-Graduation §2.1).
// Két külön immutable object-store sín (kód-fa + adat-snapshot). A `contentRef`
// feloldás a File Editor workspace-tárból történik: `workspace:<tenant>/<ticket>/<path>`,
// vagy `inline:<content>` az agent által előkészített literál tartalomhoz.
const sandboxCodeBucket = process.env.SANDBOX_CODE_BUCKET ?? 'platform-sandbox-code-prod'
const sandboxDataBucket = process.env.SANDBOX_DATA_BUCKET ?? 'platform-sandbox-data-prod'
const sandboxContentResolver = async (contentRef: string): Promise<string> => {
  if (contentRef.startsWith('inline:')) return contentRef.slice('inline:'.length)
  if (contentRef.startsWith('workspace:')) {
    const rest = contentRef.slice('workspace:'.length)
    const slash1 = rest.indexOf('/')
    const slash2 = rest.indexOf('/', slash1 + 1)
    if (slash1 < 0 || slash2 < 0) throw new Error(`Invalid workspace contentRef: ${contentRef}`)
    const tenantId = rest.slice(0, slash1)
    const ticketId = rest.slice(slash1 + 1, slash2)
    const filePath = rest.slice(slash2 + 1)
    const buf = await workspaceStorage.read(tenantId, ticketId, filePath)
    if (buf == null) throw new Error(`workspace content not found: ${contentRef}`)
    return buf.toString('utf8')
  }
  throw new Error(`Unsupported contentRef scheme: ${contentRef}`)
}
const sandboxVersioningService = new SandboxVersioningService(
  repositories.sandboxVersioning,
  new GcsCodeTreeStore(sandboxCodeBucket),
  new GcsDataSnapshotStore(sandboxDataBucket),
  repositories.audit,
  sandboxContentResolver,
)
// Web Search Tool (Feature-spec — WebSearchTool §8.3, D-WS-7): a tenant connector saját
// custom kulcsot, a tenant nélküli system agent a külön platform connectort használja.
const webSearchAdapterResolver: WebSearchAdapterResolver = async (config, secretAlias) => {
  if (config.provider === 'stub') {
    return new StubSearchProviderAdapter()
  }

  if (config.provider === 'platform_hosted_search') {
    const platformConnector = await findPlatformWebSearchConnector()
    if (!platformConnector) return new StubSearchProviderAdapter()
    const platformConfig = parseWebSearchConfig(platformConnector.config)
    const apiUrl = platformConfig.providerApiUrl?.trim()
    if (!apiUrl || !platformConnector.secretAlias) return new StubSearchProviderAdapter()
    const apiKey = await resolveConnectorApiKey(platformConnector.secretAlias)
    return new HttpSearchProviderAdapter({
      apiUrl,
      apiKey,
      providerName: 'platform_hosted_search',
      providerType: apiUrl.includes('brave') ? 'brave' : 'bing',
    })
  }

  if (config.provider === 'custom_search_api') {
    const apiUrl = config.providerApiUrl?.trim()
    if (!apiUrl) return new StubSearchProviderAdapter()
    if (!secretAlias) {
      throw new Error('custom_search_api requires connector secret-ref')
    }
    const apiKey = await resolveConnectorApiKey(secretAlias)
    return new HttpSearchProviderAdapter({
      apiUrl,
      apiKey,
      providerName: 'custom_search_api',
      providerType: apiUrl.includes('brave') ? 'brave' : 'bing',
    })
  }

  return new StubSearchProviderAdapter()
}
const webSearchPolicyService = new WebSearchPolicyService()
const webSearchService = new WebSearchService(webSearchAdapterResolver, webSearchPolicyService)
/**
 * Agent-hozzáférési gráf (Access-Policy §agent-scope, #142). Az agent-oldali olvasó
 * SZÁNDÉKOSAN szűk: csak a döntéshez és az org-ábrához kellő mezőket adja, így a
 * policy-mag nem függ az `AgentRepository` teljes felületétől, és nem overfetch-el.
 */
const agentAccessService = new AgentAccessService({
  agents: {
    findById: async (agentId) => {
      const agent = await prisma.agent.findUnique({
        where: { id: agentId },
        select: AGENT_GRAPH_NODE_SELECT,
      })
      return agent ?? null
    },
    listForTenant: async (tenantId) =>
      prisma.agent.findMany({
        where: { tenantId },
        select: AGENT_GRAPH_NODE_SELECT,
        orderBy: { name: 'asc' },
      }),
    setRestrictions: (input) => repositories.agents.updateAccessRestrictions(input),
  },
  grants: repositories.agentAccessGrants,
  audit: repositories.audit,
})
// A restriction dry-run user-oldali alanyai: a tenant AKTÍV tagjai.
agentAccessService.tenantMemberReader = async (tenantId) => {
  const rows = await prisma.tenantMembership.findMany({
    where: { tenantId, status: 'active', user: { status: 'active' } },
    select: { userId: true },
  })
  return rows.map((r) => r.userId)
}

const toolBrokerService = new ToolBrokerService(
  repositories.agents,
  repositories.tickets,
  repositories.toolBroker,
  repositories.audit,
  ticketService,
  toolAuthorizer,
  connectorGrantService,
  fileEditorService,
  sandboxAppService,
  sandboxVersioningService,
  webSearchService,
  webSearchPolicyService,
  repositories.knowledgeChunks,
  repositories.knowledgeArtifacts,
  memoryProposalService,
  (tenantId) => platformSettingsService.isWebSearchEnabledForTenant(tenantId),
  () => platformSettingsService.isWebFetchEnabled(),
  undefined,
  undefined,
  agentAccessService,
  // A web-kutatási delegáció egress-nyelője. A KÖZÖS `performAuditedWebFetch` garantálja,
  // hogy minden letöltési kísérlet — sikeres és blokkolt egyaránt — hash-only audit-eseményt
  // (`web_fetch.request`/`web_fetch.blocked`) kap, és a napi egress-keret (perAgentDayUsed) e
  // úton is érvényre jut. Korábban ez a closure a fetch-et audit ÉS keret-könyvelés nélkül
  // hívta, így a delegált webes egress láthatatlan volt a naplóban és a napi keret alól kicsúszott.
  async ({ agentId, tenantId, url, sourceType, allowedSourceUrls, fetchIndex }) =>
    performAuditedWebFetch(
      {
        countRecentAgentFetches: (id) =>
          prisma.auditLog.count({
            where: {
              action: 'web_fetch.request',
              actorId: id,
              createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            },
          }),
        webFetch: async (perAgentDayUsed) =>
          webFetchService.fetch({
            url,
            sourceType,
            allowedSourceUrls,
            allowlistHosts: await resolveEgressAllowlist(tenantId),
            enabled: await platformSettingsService.isWebFetchEnabled(),
            maxContentChars: 20_000,
            // A napi plafon a KONFIGURÁLHATÓ `webFetchBudgetMax.perAgentDay` (spec §9.3: „az
            // elsődleges korlát a maxFetchesPerAgentDay") — nem fix érték, hogy egy admin által
            // csökkentett keret a delegációs úton is hasson. A per-request forrás-korlátot a hívó
            // `maxSources` slice-a adja (spec §9.3), a `perDiscoveryMax` csak a felső biztonsági plafon.
            budget: {
              perDiscoveryUsed: fetchIndex,
              perDiscoveryMax: WEB_RESEARCH_MAX_SOURCES_CEILING,
              perAgentDayUsed,
              perAgentDayMax: webFetchBudgetMax.perAgentDay,
            },
          }),
        audit: repositories.audit,
        resolveAgentVersion: async (id) => (await repositories.agents.findById(id))?.currentVersion ?? null,
        hashPrefix: sha256Prefix,
      },
      { agentId, url, sourceType },
    ),
)
const surrogateEngine = createPlatformSurrogateEngine(
  repositories.audit,
  repositories.conversations,
  repositories.tickets,
  repositories.surrogateVault,
  repositories.conversationPrivacyKeys,
)
toolBrokerService.setStructuredPrivacyEngine(surrogateEngine)
toolBrokerService.setDebugTraceService(debugTraceService)
toolBrokerService.setRunIndexService(runIndexService)
toolBrokerService.setRunTraceService(runTraceService)
toolBrokerService.setRunStatsService(runStatsService)
toolBrokerService.setPrivacyModeResolver(({ tenantId, agentId }) =>
  platformSettingsService.resolvePrivacyGatewayMode({ tenantId, agentId }),
)
toolBrokerService.setSensitivityModeResolver(({ tenantId, agentId }) =>
  platformSettingsService.resolveSensitivityLayerMode({ tenantId, agentId }),
)
toolBrokerService.setConnectorEntityResolverFactory(async ({ connector, agentSecretAlias, actingUserId, agentId }) =>
  createConnectorEntityResolver({
    binding: { connector, agentSecretAlias: agentSecretAlias ?? null },
    actingUserId,
    agentId,
  }),
)
modelGateway.setPrivacyEngine(surrogateEngine)
sandboxAppService.setSurrogateEngine(surrogateEngine)
modelGateway.setPrivacyModeResolver(({ tenantId, agentId }) =>
  platformSettingsService.resolvePrivacyGatewayMode({ tenantId, agentId }),
)
modelGateway.setSensitivityModeResolver(({ tenantId, agentId }) =>
  platformSettingsService.resolveSensitivityLayerMode({ tenantId, agentId }),
)
modelGateway.setEntityResolutionProvider(async ({ agentId }) => {
  const bindings = await repositories.toolBroker.findConnectorsForAgent(agentId)
  return buildUserInputEntityResolution({ bindings, agentId })
})
toolBrokerService.setPrivacyCategoryActionResolver(({ tenantId, agentId, category, legacyAllowSensitiveExternalModel }) =>
  platformSettingsService.resolvePrivacyCategoryAction({
    tenantId,
    agentId,
    category,
    legacyAllowSensitiveExternalModel,
  }),
)
toolBrokerService.setPrivacyPolicyResolver(({ tenantId, agentId, legacyAllowSensitiveExternalModel }) =>
  platformSettingsService.resolvePrivacyCategoryPolicy({
    tenantId,
    agentId,
    legacyAllowSensitiveExternalModel: legacyAllowSensitiveExternalModel ?? undefined,
  }),
)
const consequenceApprovalService = new ConsequenceApprovalService(
  repositories.consequenceApprovals,
  repositories.conversations,
  repositories.agents,
  repositories.audit,
  toolBrokerService,
  repositories.tickets,
)
const knowledgeBaseService = new KnowledgeBaseService(
  repositories.tickets,
  repositories.documents,
  repositories.agents,
  repositories.audit,
  ticketService,
  repositories.knowledgeArtifacts,
  repositories.knowledgeChunks,
)
const iamService = new IamService(
  repositories.users,
  repositories.invitations,
  repositories.rolePermissions,
  repositories.audit,
  connectorGrantService,
  repositories.tenantMemberships,
)
const tenantService = new TenantService(
  repositories.tenants,
  repositories.tenantMemberships,
  repositories.platformMemberships,
  repositories.audit,
)


// Provisioning Assistant (§7.2/§14.2): a tenant egress-allowlist és a banki preset
// a meglévő deny-by-default egress-policy kiterjesztése; jelenleg env-vezérelt
// (PROVISIONING_EGRESS_ALLOWLIST = vesszővel tagolt host-lista, PROVISIONING_BANK_PRESET).
const provisioningEgressAllowlist = (process.env.PROVISIONING_EGRESS_ALLOWLIST ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean)
const provisioningBankPreset = process.env.PROVISIONING_BANK_PRESET === 'true'
// Tenant-admin által megadható külső secret-alias csak a platform által, PONTOSAN
// erre a tenantra engedélyezett listából jöhet. Hiányzó/hibás JSON → üres lista,
// azaz fail-closed. A connector-saját `secret-ref:<connectorId>` nem ebben a
// konfigurációban, hanem a ProvisioningService-ben kap kivételt.
const trustedConnectorSecretAliasPolicy = parseTrustedConnectorSecretAliasPolicy(
  process.env.CONNECTOR_TRUSTED_SECRET_ALIASES,
)

// A tényleges egress-allowlist a fetch/validáció/sandbox pillanatában (§9): a statikus env-lista
// MERGE-elve a futásidőben, auditált admin-aktussal bővített PlatformSetting-hostokkal
// (`connector.egress_allowlist.extend`). Deny-by-default marad: csak ami vagy env-ben, vagy
// az admin által explicit hozzáadott.
async function resolveEgressAllowlist(tenantId: string | null): Promise<string[]> {
  const persisted = await platformSettingsService.getEgressAllowlist(tenantId)
  return [...new Set([...provisioningEgressAllowlist, ...persisted])]
}

async function resolveProvisioningSandboxToken(
  secretAlias: string | null,
  tenantId: string | null,
): Promise<string | null> {
  if (!secretAlias?.trim()) return null
  const alias = secretAlias.trim()
  if (!isTrustedExternalConnectorSecretAlias(alias, tenantId, trustedConnectorSecretAliasPolicy)) {
    return null
  }
  try {
    return await resolveConnectorApiKey(alias)
  } catch {
    return null
  }
}

// F2-P-D sandbox connection-test (§8.4): valódi, szűk jogú read-only próbahívás
// egress deny-by-default + SSRF-őrrel. A sandbox KIZÁRÓLAG a tenant-scope-os,
// platform által engedélyezett alias mögötti tokent oldhatja fel; alapból tokenless.
const provisioningSandboxTester = new HttpSandboxConnectionTester({
  resolveEgressAllowlist: (tenantId) => resolveEgressAllowlist(tenantId),
  resolveBankPreset: async () => provisioningBankPreset,
  resolveSandboxToken: async ({ secretAlias, tenantId }) =>
    resolveProvisioningSandboxToken(secretAlias, tenantId),
})
const provisioningService = new ProvisioningService({
  drafts: repositories.connectorDrafts,
  audit: repositories.audit,
  connectorGrants: connectorGrantService,
  resolveEgressAllowlist: (tenantId) => resolveEgressAllowlist(tenantId),
  resolveBankPreset: async () => provisioningBankPreset,
  sandboxTester: provisioningSandboxTester,
  isTrustedExternalSecretAlias: (alias, tenantId) =>
    isTrustedExternalConnectorSecretAlias(alias, tenantId, trustedConnectorSecretAliasPolicy),
  resolvePlatformGoogleOAuth: async () => {
    const resolved = await platformSettingsService.getGoogleOAuthConfig()
    return { configured: Boolean(resolved) }
  },
  // issue #320: aktiváláskor a forrás `GET /privacy/catalog` katalógusa a
  // connector-configba kerül, hogy a mezőjelölés ne kézi másolással éljen.
  syncPrivacyCatalog: async (connectorId, actorId) => {
    const { syncPrivacyCatalogForConnector } = await import(
      '@/domain/privacy/privacy-catalog-sync-service'
    )
    await syncPrivacyCatalogForConnector(connectorId, { id: actorId, type: 'human' })
  },
  // F2-P-F: az agent-aktor draft-jogai deny-by-default a Capability táblából (§6.1/§9).
  resolveAgentCapabilities: async (agentId) => {
    const rows = await repositories.toolBroker.findCapabilitiesForAgents(
      [agentId],
      [...PROVISIONING_DRAFT_CAPABILITIES],
    )
    return PROVISIONING_DRAFT_CAPABILITIES.filter((cap) =>
      rows.some((row) => row.toolName === cap && row.allowed),
    )
  },
  // Négy-szem (§7.3, §14/4): a második jóváhagyó CSAK aktív `admin` tag lehet az aktor
  // tenantjában. `tenantId === null` (platform-szintű aktor) → nem hitelesíthető tenant-
  // tagságként → elutasítás (fail-closed).
  verifyDualControlApprover: async ({ approverId, tenantId }) => {
    if (!tenantId) return false
    const membership = await repositories.tenantMemberships.findByTenantAndUser(
      tenantId,
      approverId,
    )
    return membership?.status === 'active' && membership.role === 'admin'
  },
  // Defense-in-depth tenant-határ a connector-agent kötéshez (§7.5): a cél-agent valós
  // tenantja (tenant-szűrő NÉLKÜLI lookup) kerül összevetésre az aktor tenantjával.
  resolveAgentTenantId: async (agentId) => {
    const agent = await repositories.agents.findById(agentId)
    return agent ? { found: true, tenantId: agent.tenantId } : { found: false, tenantId: null }
  },
})
// Web Fetch (WS-D) platform-tool (WebFetch-Egress §7): deny-by-default, defense-in-depth.
// A DNS-feloldó a rebinding-ellenőrzést (§7.2/4) köti be; a limitek env-vezéreltek (§14).
const webFetchService = new WebFetchService({
  resolveHostIps: async (host) => {
    const addrs = await lookup(host, { all: true })
    return addrs.map((a) => a.address)
  },
  limits: resolveWebFetchLimitsFromEnv(),
})
const webFetchBudgetMax = {
  perDiscovery: Number(process.env.WEB_FETCH_MAX_PER_DISCOVERY) > 0 ? Number(process.env.WEB_FETCH_MAX_PER_DISCOVERY) : 2,
  perAgentDay: Number(process.env.WEB_FETCH_MAX_PER_AGENT_DAY) > 0 ? Number(process.env.WEB_FETCH_MAX_PER_AGENT_DAY) : 50,
}
// A web-kutatási delegáció per-request forrás-plafonja (spec §9.3: a `maxSources` a
// provisioning `maxFetchesPerDiscovery` megfelelője). Ugyanaz a felső korlát, amivel a
// `webResearchRequest` a `maxSources`-t vágja; a delegációs fetch `perDiscoveryMax`-jának
// biztonsági plafonja is ez.
const WEB_RESEARCH_MAX_SOURCES_CEILING =
  Number(process.env.WEB_RESEARCH_MAX_SOURCES) > 0 ? Number(process.env.WEB_RESEARCH_MAX_SOURCES) : 8
function sha256Prefix(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

// F2-P-F: a provisioning-asszisztens agent doksi→draft-config parsing magja (§7.1).
// A modell kimenete CSAK adat; a determinisztikus validátor a tényleges kapu (§3).
// A felfedező hurok (§8.3) web-egress runnerei a Tool Broker capability-gate-jén át futnak:
//  - web_search a meglévő broker-tool mögött (connector + rate-limit + audit);
//  - web_fetch a WebFetchService-en át, csak web-egress role capabilityvel (§7.4), hash-only audittal.
// Playbook-Role-Agent-Binding §6/WP-10: NL leírás → validált Playbook-draft. A modell
// kimenete CSAK adat (propose-not-apply); az agent sosem publikál, a hívó (server action)
// a meglévő PlaybookV2Service draft-verzió-mentésén át rakja le a spec-et.
const playbookAuthorAgent = new PlaybookAuthorAgent({
  model: modelGateway,
})

/** Provisioning §13: NL leírás → agent-vázlat (propose-not-apply); a PA modelConfig-jét a hívó adja. */
const agentScaffoldAgent = new AgentScaffoldAgent({
  model: modelGateway,
})

const provisioningAssistant = new ProvisioningAssistant({
  model: modelGateway,
  discovery: {
    isDiscoveryEnabled: () => platformSettingsService.isWebDiscoveryEnabled(),
    resolveEgressAllowlist: (tenantId) => resolveEgressAllowlist(tenantId),
    maxFetchesPerDiscovery: webFetchBudgetMax.perDiscovery,
    runWebSearch: async ({ query, domains, agentId }) => {
      const agent = await repositories.agents.findById(agentId)
      if (!agent) return []
      const res = await toolBrokerService.invoke({
        agentId,
        agentVersion: agent.currentVersion,
        tool: 'web_search',
        args: { query, ...(domains ? { domains } : {}) },
      })
      const results = res.denied ? [] : (res.result as WebSearchResult).results
      // §11.1 provisioning.discover.search — actor = web-egress role agent (§11.2).
      // Hash-only: nyers query SOSEM kerül auditba (§11.3), csak queryHash + darabszám +
      // forrás-osztály hisztogram.
      const sourceHistogram: Record<string, number> = {}
      for (const r of results) sourceHistogram[r.sourceType] = (sourceHistogram[r.sourceType] ?? 0) + 1
      await repositories.audit.append({
        actorType: 'agent',
        actorId: agentId,
        agentVersion: agent.currentVersion,
        action: 'provisioning.discover.search',
        targetType: 'provisioning_discovery',
        targetId: null,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: res.denied ? 'denied' : 'allowed',
        metadata: { queryHash: sha256Prefix(query), resultCount: results.length, sourceHistogram },
      })
      return results
    },
    runWebFetch: async ({ url, sourceType, allowedSourceUrls, allowlistHosts, agentId, fetchIndex, maxContentChars }) => {
      // §7.4 kapu: a web_fetch KIZÁRÓLAG a perzisztált Web-Egress rendszer-szerep
      // ÉS a deny-by-default capability együttesével hívható. Egy agent neve vagy
      // pusztán egy hibásan kiosztott capability nem jogosíthat fel webes egressre.
      const cap = await repositories.toolBroker.findCapability(agentId, 'web_fetch')
      const agent = await repositories.agents.findById(agentId)
      if (cap?.allowed !== true || !agent || !isWebEgressAgent(agent)) {
        await repositories.audit.append({
          actorType: 'agent',
          actorId: agentId,
          agentVersion: agent?.currentVersion ?? null,
          action: 'web_fetch.blocked',
          targetType: 'web_fetch',
          targetId: null,
          modelUsed: null,
          inputRef: null,
          outputRef: null,
          policyDecision: 'denied',
          metadata: {
            reason: cap?.allowed === true && agent ? 'WEB_EGRESS_ROLE_REQUIRED' : 'TOOL_NOT_AUTHORIZED',
          },
        })
        return { ok: false, reason: 'fetch_failed', detail: 'not_authorized' }
      }

      // A role/capability-kapu (fent) UTÁN a letöltés+audit+keret a KÖZÖS nyelőn fut —
      // ugyanaz a hash-only audit-alak és napi-keret-könyvelés, mint a delegációs úton,
      // hogy a két egress-út SOSE csússzon szét (§11.3, WF-N10).
      const enabled = await platformSettingsService.isWebFetchEnabled()
      return performAuditedWebFetch(
        {
          countRecentAgentFetches: (id) =>
            prisma.auditLog.count({
              where: {
                action: 'web_fetch.request',
                actorId: id,
                createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
              },
            }),
          webFetch: (perAgentDayUsed) =>
            webFetchService.fetch({
              url,
              sourceType,
              allowedSourceUrls,
              allowlistHosts,
              enabled,
              maxContentChars,
              budget: {
                perDiscoveryUsed: fetchIndex,
                perDiscoveryMax: webFetchBudgetMax.perDiscovery,
                perAgentDayUsed,
                perAgentDayMax: webFetchBudgetMax.perAgentDay,
              },
            }),
          audit: repositories.audit,
          // Az agent már feloldva a role-kapunál — nincs újabb DB-kör.
          resolveAgentVersion: async () => agent.currentVersion ?? null,
          hashPrefix: sha256Prefix,
        },
        { agentId, url, sourceType },
      )
    },
  },
})
const skillDistillerAgent = new SkillDistillerAgent({
  model: modelGateway,
})
const skillReviewAgent = new SkillReviewAgent({
  model: modelGateway,
})
const skillService = new SkillService(
  repositories.skills,
  repositories.audit,
  repositories.toolBroker,
  repositories.agents,
  repositories.conversations,
)
const agentChatRuntime = new AgentChatRuntime(
  repositories.agents,
  repositories.documents,
  repositories.tickets,
  modelGateway,
  conversationService,
  toolBrokerService,
  repositories.toolBroker,
  workspaceStorage,
  repositories.audit,
  repositories.processDefinitions,
  repositories.playbooksV2,
  processService,
  skillService,
  memoryRetrievalService,
  (tenantId) => platformSettingsService.isChatThinkingTraceEnabledForTenant(tenantId),
  repositories.agentTurns,
  consequenceApprovalService,
  agentAccessService,
  surrogateEngine,
  (tenantId) => platformSettingsService.resolvePrivacyEgressMatrix(tenantId),
  async (tenantId, agentId) => {
    const agent = await repositories.agents.findById(agentId, tenantId)
    const [mode, policy] = await Promise.all([
      platformSettingsService.resolvePrivacyGatewayMode({ tenantId, agentId }),
      platformSettingsService.resolvePrivacyCategoryPolicy({
        tenantId,
        agentId,
        legacyAllowSensitiveExternalModel: agent?.allowSensitiveExternalModel,
      }),
    ])
    return { mode, policy }
  },
)
// 1:1 agent-chat a csatornán (#74, D8/D9/D10/D11). A worker második munkatípusa: a bejövő
// Telegram-fordulót a MEGLÉVŐ webes chat-futásidőre képezzük (ugyanabba a beszélgetésbe, így a
// weben is látszik), majd a választ CÍMKÉZVE, DARABOLVA, az érzékenységi kapun át küldjük ki. A
// kimenő átvitel ugyanaz a befecskendezhető adapter, mint a linking-oldalon (D11 — egy varrat).
const channelTurnService = new ChannelTurnService({
  sessions: repositories.channelSessions,
  identities: repositories.channelIdentities,
  grants: repositories.channelAgentGrants,
  turns: repositories.channelTurns,
  agents: {
    findById: async (id) => {
      const agent = await repositories.agents.findById(id)
      if (!agent) return null
      return {
        id: agent.id,
        name: agent.name,
        tenantId: agent.tenantId,
        personaNickname: agent.personaNickname,
      }
    },
  },
  conversations: {
    findById: async (id) => {
      const conv = await repositories.conversations.findById(id)
      if (!conv) return null
      return {
        id: conv.id,
        agentId: conv.agentId,
        tenantId: conv.tenantId,
        lastMessageAt: conv.lastMessageAt,
        retainUntil: conv.retainUntil,
      }
    },
    create: async (input) => {
      const conv = await conversationService.createConversation({
        agentId: input.agentId,
        createdById: input.createdById,
        tenantId: input.tenantId,
        title: input.title,
        projectKey: input.projectKey,
        channel: input.channel,
        channelExternalId: input.channelExternalId,
      })
      return { id: conv.id, retainUntil: conv.retainUntil }
    },
  },
  runtime: new AgentChatChannelRuntime(agentChatRuntime),
  // A KÖZÖS kimenő kapu (D11) — ugyanaz a példány, mint a linking- és a takarítás-oldalon;
  // nincs második, egress-őrön kívüli kijárat a Telegram felé.
  transport: telegramOutboundTransport,
  audit: repositories.audit,
  // A `/szervezet` parancshoz (story 14): melyik szervezet nevében beszél a felhasználó.
  resolveOrgName: async (tenantId) => {
    if (!tenantId) return null
    const tenant = await repositories.tenants.findById(tenantId)
    return tenant?.displayName ?? null
  },
  memberships: repositories.tenantMemberships,
  tenants: repositories.tenants,
  isChannelEnabled: (tenantId) => platformSettingsService.isChannelEnabledForTenant(tenantId),
  resolveOutboundText: async ({ text, tenantId, conversationId, userId }) => {
    if (!text) return text
    const matrix = await platformSettingsService.resolvePrivacyEgressMatrix(tenantId)
    return resolveChannelOutboundText({
      text,
      engine: surrogateEngine,
      tenantId,
      conversationId,
      userId,
      matrix,
    })
  },
  resolveSensitivityLayerMode: ({ tenantId, agentId }) =>
    platformSettingsService.resolveSensitivityLayerMode({ tenantId, agentId }),
})
channelTurnServiceRef = channelTurnService
const wikiRuntime = new WikiAgentRuntime(
  repositories.agents,
  repositories.tickets,
  modelGateway,
  ticketService,
  toolBrokerService,
  repositories.toolBroker,
  playbookService,
  conversationService,
  repositories.audit,
)
const generalTaskRuntime = new GeneralTaskRuntime(
  repositories.agents,
  repositories.documents,
  repositories.tickets,
  modelGateway,
  toolBrokerService,
  repositories.toolBroker,
  workspaceStorage,
  repositories.playbooksV2,
  repositories.processes,
  conversationService,
  skillService,
  repositories.audit,
  memoryRetrievalService,
  () => platformSettingsService.getStructuringModel(),
  agentAccessService,
  consequenceApprovalService,
)
toolBrokerService.setDelegationProcessor(async ({ ticketId, targetAgentId }) => {
  await wikiRuntime.processTicket({ ticketId, agentId: targetAgentId })
})
// Folyamat-ticket board_write állapotváltása a Playbook state machine-en át (kapuk +
// output-szerződés + ProcessService.advance) — l. process-runtime-advance-gap.
toolBrokerService.setPlaybookTransitioner(ticketStateMachine)
// #142 — a folyamat-motor SHADOW ellenőrzése: a Playbook-út nem áll meg az ad-hoc gráf
// deny döntésén, de `agent.access.bypass` eseményt ír, ha az ad-hoc út elutasítaná.
processService.setAgentAccessService(agentAccessService)
const auditChainService = new AuditChainService(repositories.audit)
const recipeService = new RecipeService(repositories.recipes, repositories.audit)
const scheduledTaskService = new ScheduledTaskService(
  repositories.scheduledTasks,
  repositories.agents,
  repositories.audit,
)
const monitorService = new MonitorService(
  repositories.monitors,
  repositories.tickets,
  repositories.audit,
  [
    new DeadlineCollector(repositories.monitors),
    new BoardBacklogCollector(repositories.monitors),
    new ConnectorCountCollector(toolBrokerService, repositories.agents),
  ],
  // §7 értesítés: `chat:<kulcs>` → allowlistolt webhook (Slack/Teams/Google Chat);
  // minden más csatorna a biztonságos audit-only adapterre esik vissza.
  monitorNotifier,
  repositories.processDefinitions,
  processService,
  repositories.agents,
)
// #142 — a Monitor-cron eszkalációja is shadow-ellenőrzést kap (auditál, nem blokkol).
monitorService.setAgentAccessService(agentAccessService)
// local-wiki: fire-and-forget (mint docker-local / cloud-run-job) — a UI create /
// handback nem várja meg a teljes agent-futást. Hiba esetén a dispatcher
// retry/block politikája érvényesül (nem vak `ready` reset).
const localWikiHarnessLauncher = new LocalWikiHarnessLauncher({
  findTicket: async (ticketId) => {
    const ticket = await repositories.tickets.findById(ticketId)
    if (!ticket) return null
    return {
      processInstanceId: ticket.processInstanceId,
      payload: ticket.payload,
      state: ticket.state,
    }
  },
  processGeneral: async (input) => {
    await generalTaskRuntime.processTicket(input)
  },
  processWiki: async (input) => {
    await wikiRuntime.processTicket(input)
  },
  releaseDispatchLock: (ticketId, lockToken) =>
    repositories.tickets.releaseDispatchLock(ticketId, lockToken),
  recoverLaunchFailure: async (input) => {
    await dispatcherService.recoverLaunchFailure(input)
  },
})

function createHarnessLauncher(): HarnessLauncher {
  const mode = process.env.HARNESS_LAUNCHER_MODE ?? 'local-wiki'
  if (mode === 'local-wiki') return localWikiHarnessLauncher
  if (mode === 'docker-local') return new DockerLocalHarnessLauncher(dockerLocalConfigFromEnv())
  if (mode === 'cloud-run-job') return new CloudRunJobHarnessLauncher(cloudRunConfigFromEnv())
  throw new Error(`Unsupported HARNESS_LAUNCHER_MODE: ${mode}`)
}

const dispatcherService = new DispatcherService(
  repositories.tickets,
  repositories.audit,
  repositories.modelCalls,
  () => createHarnessLauncher(),
  dispatchBudgetFromEnv(),
  (mode: string) => platformSettingsService.isDispatchEnabledForMode(mode),
  repositories.agents,
  new MonitorDispatchAlertNotifier(monitorNotifier, { platformSettings: platformSettingsService }),
  repositories.processes,
  budgetEngine,
  repositories.tenants,
)

export const services = {
  platformSettings: platformSettingsService,
  tickets: ticketService,
  gateway: modelGateway,
  agentChat: agentChatRuntime,
  wiki: wikiRuntime,
  generalTask: generalTaskRuntime,
  bookkeeper: bookkeeperRuntime,
  training: trainingService,
  memoryApproval: memoryApprovalService,
  consequenceApproval: consequenceApprovalService,
  memoryRollback: memoryRollbackService,
  memoryMaintenance: memoryMaintenanceService,
  knowledgeBase: knowledgeBaseService,
  auditChain: auditChainService,
  writeGate: writeGateService,
  eval: evalService,
  dispatcher: dispatcherService,
  toolBroker: toolBrokerService,
  recipes: recipeService,
  skills: skillService,
  skillDistillerAgent,
  skillReviewAgent,
  playbooks: playbookService,
  playbooksV2: playbookV2Service,
  processes: processService,
  processDefinitions: processDefinitionService,
  ticketStateMachine,
  conversations: conversationService,
  debugLogExport: debugLogExportService,
  channelBots: channelBotService,
  channelLinking: channelLinkingService,
  channelTurns: channelTurnService,
  channelMetrics: channelMetricsService,
  channelRetention: channelRetentionService,
  channelAgentAccess: channelAgentAccessService,
  channelApproval: channelApprovalService,
  agentAccess: agentAccessService,
  iam: iamService,
  tenants: tenantService,
  provisioning: provisioningService,
  selfUpdatingConnectors: selfUpdatingConnectorService,
  provisioningAssistant,
  agentScaffoldAgent,
  playbookAuthorAgent,
  sandboxApps: sandboxAppService,
  sandboxVersioning: sandboxVersioningService,
  scheduledTasks: scheduledTaskService,
  monitors: monitorService,
  connectorGrants: connectorGrantService,
  workspaceLifecycle: workspaceLifecycleService,
  selfEvolutionGuard,
  webSearch: webSearchService,
  webSearchPolicy: webSearchPolicyService,
  webFetch: webFetchService,
  surrogateEngine,
}
