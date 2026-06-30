import { ModelGateway } from '@/domain/gateway/model-gateway'
import { RoutingEngine } from '@/domain/gateway/routing-engine'
import { BudgetEngine } from '@/domain/gateway/budget-engine'
import { BookkeeperAgentRuntime } from '@/domain/agent/bookkeeper-runtime'
import { AgentChatRuntime } from '@/domain/agent/agent-chat-runtime'
import { GeneralTaskRuntime } from '@/domain/agent/general-task-runtime'
import { WikiAgentRuntime } from '@/domain/agent/wiki-runtime'
import { TicketService } from '@/domain/ticket/ticket-service'
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
import { PlatformSettingsService } from '@/domain/platform-settings/platform-settings-service'
import { CloudRunJobHarnessLauncher, cloudRunConfigFromEnv } from '@/domain/dispatcher/cloud-run-job-launcher'
import {
  DockerLocalHarnessLauncher,
  dockerLocalConfigFromEnv,
} from '@/domain/dispatcher/docker-local-harness-launcher'
import { AllowlistAuthorizer, ToolBrokerService } from '@/domain/tool-broker/tool-broker-service'
import { WebSearchPolicyService } from '@/domain/web-search/web-search-policy-service'
import { WebSearchService } from '@/domain/web-search/web-search-service'
import { HttpSearchProviderAdapter, StubSearchProviderAdapter } from '@/domain/web-search/search-provider-adapter'
import type { WebSearchAdapterResolver } from '@/domain/web-search/web-search-types'
import { ConnectorGrantService } from '@/domain/connector-grant/connector-grant-service'
import { WorkspaceStorage } from '@/domain/file-editor/workspace-storage'
import { FileEditorService } from '@/domain/file-editor/file-editor-service'
import { WorkspaceLifecycleService } from '@/domain/file-editor/workspace-lifecycle-service'
import { RecipeService } from '@/domain/recipe/recipe-service'
import { ConversationService } from '@/domain/conversation/conversation-service'
import { PlaybookService } from '@/domain/playbook/playbook-service'
import { PlaybookV2Service } from '@/domain/playbook/playbook-v2-service'
import { ProcessService } from '@/domain/playbook/process-service'
import { TicketStateMachine } from '@/domain/playbook/ticket-state-machine'
import { IamService } from '@/domain/iam/iam-service'
import { SandboxAppService } from '@/domain/sandbox/sandbox-app-service'
import { GcsArtifactStore } from '@/domain/sandbox/artifact-store'
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
import {
  AuditOnlyMonitorNotifier,
  RoutingMonitorNotifier,
} from '@/lib/notify/monitor-notifier'
import { WebhookChatNotifier } from '@/lib/notify/webhook-chat-notifier'
import { repositories } from '@/repositories/postgres'
import { resolveConnectorApiKey } from '@/domain/connector/http-api-client'
import { resolveTicketProcessRoute } from '@/lib/ticket-process-route'

const playbookService = new PlaybookService(repositories.playbooks, repositories.audit)
const playbookV2Service = new PlaybookV2Service(repositories.playbooksV2, repositories.audit)
const processService = new ProcessService(
  repositories.processes,
  repositories.playbooksV2,
  repositories.tickets,
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
const modelGateway = new ModelGateway(
  repositories.audit,
  repositories.modelCalls,
  undefined,
  undefined,
  routingEngine,
  budgetEngine,
)
const bookkeeperRuntime = new BookkeeperAgentRuntime(
  repositories.agents,
  repositories.documents,
  repositories.tickets,
  modelGateway,
  ticketService,
)
const writeGateService = new WriteGateService()
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
const sandboxAppBucket = process.env.SANDBOX_APP_BUCKET ?? 'platform-sandbox-apps-prod'
const sandboxAppService = new SandboxAppService(
  repositories.sandboxApps,
  repositories.tickets,
  repositories.conversations,
  repositories.audit,
  new GcsArtifactStore(sandboxAppBucket),
)
// Web Search Tool (Feature-spec — WebSearchTool §8.3, D-WS-7): a provider
// CONNECTOR-onként (tenant policy `config.provider`) cserélhető, nem egy
// folyamat-globális env-állapot. Élő provider csak akkor, ha a connector
// 'custom_search_api'-t kér ÉS WEB_SEARCH_PROVIDER_API_URL konfigurált;
// egyébként determinisztikus dev/acceptance stub (nincs kimenő hívás).
const webSearchProviderApiUrl = process.env.WEB_SEARCH_PROVIDER_API_URL?.trim()
const webSearchAdapterResolver: WebSearchAdapterResolver = async (config, secretAlias) => {
  if (config.provider !== 'custom_search_api' || !webSearchProviderApiUrl) {
    return new StubSearchProviderAdapter()
  }
  const apiKey = secretAlias
    ? await resolveConnectorApiKey(secretAlias).catch(() => process.env.WEB_SEARCH_PROVIDER_API_KEY?.trim())
    : process.env.WEB_SEARCH_PROVIDER_API_KEY?.trim()
  return new HttpSearchProviderAdapter({ apiUrl: webSearchProviderApiUrl, apiKey })
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
  webSearchService,
  webSearchPolicyService,
  () => platformSettingsService.isWebSearchEnabled(),
)
const knowledgeBaseService = new KnowledgeBaseService(
  repositories.tickets,
  repositories.documents,
  repositories.agents,
  repositories.audit,
  ticketService,
)
const iamService = new IamService(repositories.audit, connectorGrantService)

// Provisioning Assistant (§7.2/§14.2): a tenant egress-allowlist és a banki preset
// a meglévő deny-by-default egress-policy kiterjesztése; jelenleg env-vezérelt
// (PROVISIONING_EGRESS_ALLOWLIST = vesszővel tagolt host-lista, PROVISIONING_BANK_PRESET).
const provisioningEgressAllowlist = (process.env.PROVISIONING_EGRESS_ALLOWLIST ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean)
const provisioningBankPreset = process.env.PROVISIONING_BANK_PRESET === 'true'

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
  resolveEgressAllowlist: async () => provisioningEgressAllowlist,
  resolveBankPreset: async () => provisioningBankPreset,
  resolveSandboxToken: async ({ secretAlias }) => resolveProvisioningSandboxToken(secretAlias),
})
const provisioningService = new ProvisioningService({
  drafts: repositories.connectorDrafts,
  audit: repositories.audit,
  resolveEgressAllowlist: async () => provisioningEgressAllowlist,
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
// F2-P-F: a provisioning-asszisztens agent doksi→draft-config parsing magja (§7.1).
// A modell kimenete CSAK adat; a determinisztikus validátor a tényleges kapu (§3).
const provisioningAssistant = new ProvisioningAssistant({ model: modelGateway })
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
)
toolBrokerService.setDelegationProcessor(async ({ ticketId, targetAgentId }) => {
  await wikiRuntime.processTicket({ ticketId, agentId: targetAgentId })
})
const auditChainService = new AuditChainService(repositories.audit)
const recipeService = new RecipeService(repositories.recipes, repositories.audit)
const scheduledTaskService = new ScheduledTaskService(
  repositories.scheduledTasks,
  repositories.tickets,
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
  new RoutingMonitorNotifier(
    { chat: new WebhookChatNotifier() },
    new AuditOnlyMonitorNotifier(),
  ),
)
const localWikiHarnessLauncher: HarnessLauncher = {
  mode: 'local-wiki',
  async launch(input) {
    const ticket = await repositories.tickets.findById(input.ticketId)
    const route = resolveTicketProcessRoute(ticket?.payload)
    if (route === 'general') {
      await generalTaskRuntime.processTicket({
        ticketId: input.ticketId,
        agentId: input.agentId,
      })
    } else {
      await wikiRuntime.processTicket({
        ticketId: input.ticketId,
        agentId: input.agentId,
      })
    }
    await repositories.tickets.releaseDispatchLock(input.ticketId, input.lockToken)
    return { jobId: `local-wiki-${input.ticketId}` }
  },
}

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
  () => platformSettingsService.isDispatchEnabled(),
  repositories.agents,
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
  knowledgeBase: knowledgeBaseService,
  auditChain: auditChainService,
  writeGate: writeGateService,
  eval: evalService,
  dispatcher: dispatcherService,
  toolBroker: toolBrokerService,
  recipes: recipeService,
  playbooks: playbookService,
  playbooksV2: playbookV2Service,
  processes: processService,
  ticketStateMachine,
  conversations: conversationService,
  iam: iamService,
  provisioning: provisioningService,
  provisioningAssistant,
  sandboxApps: sandboxAppService,
  scheduledTasks: scheduledTaskService,
  monitors: monitorService,
  connectorGrants: connectorGrantService,
  workspaceLifecycle: workspaceLifecycleService,
  selfEvolutionGuard,
  webSearch: webSearchService,
  webSearchPolicy: webSearchPolicyService,
}
