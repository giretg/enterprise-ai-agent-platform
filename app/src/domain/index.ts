import { ModelGateway, type AgentSensitivityPolicyReader } from '@/domain/gateway/model-gateway'
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
import { WebSearchPolicyService } from '@/domain/web-search/web-search-policy-service'
import { WebSearchService } from '@/domain/web-search/web-search-service'
import { HttpSearchProviderAdapter, StubSearchProviderAdapter } from '@/domain/web-search/search-provider-adapter'
import { findPlatformWebSearchConnector } from '@/domain/web-search/web-search-connector-service'
import { parseWebSearchConfig, type WebSearchAdapterResolver, type WebSearchResult } from '@/domain/web-search/web-search-types'
import { WebFetchService, toWebFetchAuditMeta } from '@/domain/web-fetch/web-fetch-service'
import { resolveWebFetchLimitsFromEnv } from '@/domain/web-fetch/web-fetch-types'
import { ConnectorGrantService } from '@/domain/connector-grant/connector-grant-service'
import { WorkspaceStorage } from '@/domain/file-editor/workspace-storage'
import { FileEditorService } from '@/domain/file-editor/file-editor-service'
import { WorkspaceLifecycleService } from '@/domain/file-editor/workspace-lifecycle-service'
import { RecipeService } from '@/domain/recipe/recipe-service'
import { SkillService } from '@/domain/skill/skill-service'
import { ConversationService } from '@/domain/conversation/conversation-service'
import { ChannelBotService } from '@/domain/channel/channel-bot-service'
import { ChannelLinkingService } from '@/domain/channel/channel-linking-service'
import { TelegramOutboundTransport } from '@/domain/channel/channel-outbound-transport'
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
  ProvisioningAssistant,
  PROVISIONING_DRAFT_CAPABILITIES,
} from '@/domain/provisioning/provisioning-assistant'
import { PlaybookAuthorAgent } from '@/domain/playbook/playbook-author-agent'
import { SkillDistillerAgent } from '@/domain/skill/skill-distiller-agent'
import { SkillReviewAgent } from '@/domain/skill/skill-review-agent'
import {
  AuditOnlyMonitorNotifier,
  RoutingMonitorNotifier,
} from '@/lib/notify/monitor-notifier'
import { WebhookChatNotifier } from '@/lib/notify/webhook-chat-notifier'
import { repositories } from '@/repositories/postgres'
import { resolveConnectorApiKey } from '@/domain/connector/http-api-client'
import { prisma } from '@/lib/db'
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
const monitorNotifier = new RoutingMonitorNotifier(
  { chat: new WebhookChatNotifier() },
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
const channelBotService = new ChannelBotService({
  bots: repositories.channelBots,
  audit: repositories.audit,
})
// Csatorna összekötés/visszavonás (#72, D12). A varrat kimenete a befecskendezett kimenő
// átvitel (Telegram vagy teszt-dublőr); a webhook titkos fejléc a bot referenciájából oldódik
// fel; a deep-link a platform-bot Telegram-felhasználónevéből épül (env). A platform-oldali
// értesítés a `user_notifications` sorba kerül (D12 story 3).
const telegramBotUsername = process.env.TELEGRAM_BOT_USERNAME?.trim() || 'YourPlatformBot'
const channelLinkingService = new ChannelLinkingService({
  bots: repositories.channelBots,
  identities: repositories.channelIdentities,
  sessions: repositories.channelSessions,
  linkTokens: repositories.channelLinkTokens,
  transport: new TelegramOutboundTransport({
    resolveBotToken: async () => {
      const bot = await repositories.channelBots.findPlatformBot('telegram')
      if (!bot) throw new Error('no platform telegram bot registered')
      return resolveConnectorApiKey(bot.accessKeySecretRef)
    },
    resolveHostIps: async (host) => (await lookup(host, { all: true })).map((e) => e.address),
  }),
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
  resolveWebhookSecret: async (bot) => resolveConnectorApiKey(bot.webhookSecretRef),
  buildDeepLink: (jti) => `https://t.me/${telegramBotUsername}?start=${jti}`,
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
// Sensitivity router: a per-agent felmentést a gateway az agentId-ból oldja fel,
// így a nyolc hívási hely paraméter-lánca változatlan marad.
const agentSensitivityPolicy: AgentSensitivityPolicyReader = {
  async allowsSensitiveExternalModel(agentId: string): Promise<boolean> {
    const agent = await repositories.agents.findById(agentId)
    return agent?.allowSensitiveExternalModel ?? false
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

// A tényleges egress-allowlist a fetch/validáció/sandbox pillanatában (§9): a statikus env-lista
// MERGE-elve a futásidőben, auditált admin-aktussal bővített PlatformSetting-hostokkal
// (`connector.egress_allowlist.extend`). Deny-by-default marad: csak ami vagy env-ben, vagy
// az admin által explicit hozzáadott.
async function resolveEgressAllowlist(tenantId: string | null): Promise<string[]> {
  const persisted = await platformSettingsService.getEgressAllowlist(tenantId)
  return [...new Set([...provisioningEgressAllowlist, ...persisted])]
}

async function resolveProvisioningSandboxToken(secretAlias: string | null): Promise<string | null> {
  if (!secretAlias?.trim()) {
    return process.env.PROVIDER_CRM_API_KEY?.trim() ?? null
  }
  const alias = secretAlias.trim()
  const prefixed =
    'PROVISIONING_SANDBOX_TOKEN_' + alias.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  if (process.env[prefixed]?.trim()) return process.env[prefixed]!.trim()
  if (process.env.PROVIDER_CRM_API_KEY?.trim()) return process.env.PROVIDER_CRM_API_KEY!.trim()
  try {
    if (
      alias.startsWith('env:') ||
      alias.startsWith('secret-ref:') ||
      alias.startsWith('secret-manager:')
    ) {
      return await resolveConnectorApiKey(alias)
    }
    return await resolveConnectorApiKey(`env:${alias}`)
  } catch {
    return null
  }
}

// F2-P-D sandbox connection-test (§8.4): valódi, szűk jogú read-only próbahívás
// egress deny-by-default + SSRF-őrrel. A non-prod token feloldása env-vezérelt és
// alias-szűkített (PROVISIONING_SANDBOX_TOKEN_<ALIAS-UPPER-SNAKE>); alapból tokenless.
const provisioningSandboxTester = new HttpSandboxConnectionTester({
  resolveEgressAllowlist: (tenantId) => resolveEgressAllowlist(tenantId),
  resolveBankPreset: async () => provisioningBankPreset,
  resolveSandboxToken: async ({ secretAlias }) => resolveProvisioningSandboxToken(secretAlias),
})
const provisioningService = new ProvisioningService({
  drafts: repositories.connectorDrafts,
  audit: repositories.audit,
  connectorGrants: connectorGrantService,
  resolveEgressAllowlist: (tenantId) => resolveEgressAllowlist(tenantId),
  resolveBankPreset: async () => provisioningBankPreset,
  sandboxTester: provisioningSandboxTester,
  // F2-P-F: az agent-aktor draft-jogai deny-by-default a Capability táblából (§6.1/§9).
  resolveAgentCapabilities: async (agentId) => {
    const checks = await Promise.all(
      PROVISIONING_DRAFT_CAPABILITIES.map(async (cap) => ({
        cap,
        allowed: (await repositories.toolBroker.findCapability(agentId, cap))?.allowed === true,
      })),
    )
    return checks.filter((c) => c.allowed).map((c) => c.cap)
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
      // §7.4 kapu: a web_fetch KIZÁRÓLAG web-egress role capabilityvel hívható.
      const cap = await repositories.toolBroker.findCapability(agentId, 'web_fetch')
      const agent = await repositories.agents.findById(agentId)
      if (cap?.allowed !== true) {
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
          metadata: { reason: 'TOOL_NOT_AUTHORIZED' },
        })
        return { ok: false, reason: 'fetch_failed', detail: 'not_authorized' }
      }

      const enabled = await platformSettingsService.isWebFetchEnabled()
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const perAgentDayUsed = await prisma.auditLog
        .count({ where: { action: 'web_fetch.request', actorId: agentId, createdAt: { gte: since } } })
        .catch(() => 0)

      const result = await webFetchService.fetch({
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
      })

      // §11.3 hash-only audit: nyers URL/tartalom SOSEM kerül a naplóba (WF-N10).
      const meta = toWebFetchAuditMeta({
        urlHash: sha256Prefix(url),
        host: (() => {
          try {
            return new URL(url).hostname
          } catch {
            return 'unknown'
          }
        })(),
        sourceType,
        result,
      })
      await repositories.audit.append({
        actorType: 'agent',
        actorId: agentId,
        agentVersion: agent?.currentVersion ?? null,
        action: result.ok ? 'web_fetch.request' : 'web_fetch.blocked',
        targetType: 'web_fetch',
        targetId: null,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: result.ok ? 'allowed' : 'blocked',
        metadata: meta as unknown as import('@prisma/client').Prisma.JsonValue,
      })
      return result
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
)
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
)
toolBrokerService.setDelegationProcessor(async ({ ticketId, targetAgentId }) => {
  await wikiRuntime.processTicket({ ticketId, agentId: targetAgentId })
})
// Folyamat-ticket board_write állapotváltása a Playbook state machine-en át (kapuk +
// output-szerződés + ProcessService.advance) — l. process-runtime-advance-gap.
toolBrokerService.setPlaybookTransitioner(ticketStateMachine)
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
  channelBots: channelBotService,
  channelLinking: channelLinkingService,
  iam: iamService,
  tenants: tenantService,
  provisioning: provisioningService,
  selfUpdatingConnectors: selfUpdatingConnectorService,
  provisioningAssistant,
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
}
