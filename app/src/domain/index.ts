import { ModelGateway } from '@/domain/gateway/model-gateway'
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
import { repositories } from '@/repositories/postgres'
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
const modelGateway = new ModelGateway(repositories.audit, repositories.modelCalls)
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
)
const knowledgeBaseService = new KnowledgeBaseService(
  repositories.tickets,
  repositories.documents,
  repositories.agents,
  repositories.audit,
  ticketService,
)
const iamService = new IamService(repositories.audit, connectorGrantService)
const agentChatRuntime = new AgentChatRuntime(
  repositories.agents,
  repositories.documents,
  repositories.tickets,
  modelGateway,
  conversationService,
  toolBrokerService,
  repositories.toolBroker,
  workspaceStorage,
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
    new ConnectorCountCollector(),
  ],
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
  sandboxApps: sandboxAppService,
  scheduledTasks: scheduledTaskService,
  monitors: monitorService,
  connectorGrants: connectorGrantService,
  workspaceLifecycle: workspaceLifecycleService,
  selfEvolutionGuard,
}
