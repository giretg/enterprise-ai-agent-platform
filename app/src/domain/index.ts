import { ModelGateway } from '@/domain/gateway/model-gateway'
import { BookkeeperAgentRuntime } from '@/domain/agent/bookkeeper-runtime'
import { AgentChatRuntime } from '@/domain/agent/agent-chat-runtime'
import { WikiAgentRuntime } from '@/domain/agent/wiki-runtime'
import { TicketService } from '@/domain/ticket/ticket-service'
import { TrainingService } from '@/domain/training/training-service'
import { SelfEvolutionGuard } from '@/domain/training/self-evolution-guard'
import { AuditChainService } from '@/domain/audit/audit-chain-service'
import { WriteGateService } from '@/domain/writegate/write-gate-service'
import { EvalService } from '@/domain/eval/eval-service'
import { DispatcherService, type HarnessLauncher } from '@/domain/dispatcher/dispatcher-service'
import { CloudRunJobHarnessLauncher, cloudRunConfigFromEnv } from '@/domain/dispatcher/cloud-run-job-launcher'
import {
  DockerLocalHarnessLauncher,
  dockerLocalConfigFromEnv,
} from '@/domain/dispatcher/docker-local-harness-launcher'
import { AllowlistAuthorizer, ToolBrokerService } from '@/domain/tool-broker/tool-broker-service'
import { ConnectorGrantService } from '@/domain/connector-grant/connector-grant-service'
import { WorkspaceStorage } from '@/domain/file-editor/workspace-storage'
import { FileEditorService } from '@/domain/file-editor/file-editor-service'
import { RecipeService } from '@/domain/recipe/recipe-service'
import { ConversationService } from '@/domain/conversation/conversation-service'
import { PlaybookService } from '@/domain/playbook/playbook-service'
import { IamService } from '@/domain/iam/iam-service'
import { SandboxAppService } from '@/domain/sandbox/sandbox-app-service'
import { repositories } from '@/repositories/postgres'

const playbookService = new PlaybookService(repositories.playbooks, repositories.audit)

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
)

const conversationService = new ConversationService(
  repositories.conversations,
  repositories.tickets,
  repositories.audit,
  playbookService,
)
const connectorGrantService = new ConnectorGrantService(repositories.connectorGrants, repositories.audit)
const workspaceStorage = new WorkspaceStorage(
  process.env.WORKSPACE_BUCKET ?? 'platform-workspace-prod',
)
const fileEditorService = new FileEditorService(workspaceStorage)
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
const toolBrokerService = new ToolBrokerService(
  repositories.agents,
  repositories.tickets,
  repositories.toolBroker,
  repositories.audit,
  ticketService,
  toolAuthorizer,
  connectorGrantService,
  fileEditorService,
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
)
const wikiRuntime = new WikiAgentRuntime(
  repositories.agents,
  repositories.tickets,
  modelGateway,
  ticketService,
  toolBrokerService,
  playbookService,
  conversationService,
)
const auditChainService = new AuditChainService(repositories.audit)
const recipeService = new RecipeService(repositories.recipes, repositories.audit)
const sandboxAppService = new SandboxAppService(
  repositories.sandboxApps,
  repositories.tickets,
  repositories.audit,
)
const localWikiHarnessLauncher: HarnessLauncher = {
  mode: 'local-wiki',
  async launch(input) {
    await wikiRuntime.processTicket({
      ticketId: input.ticketId,
      agentId: input.agentId,
    })
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
)

export const services = {
  tickets: ticketService,
  gateway: modelGateway,
  agentChat: agentChatRuntime,
  wiki: wikiRuntime,
  bookkeeper: bookkeeperRuntime,
  training: trainingService,
  auditChain: auditChainService,
  writeGate: writeGateService,
  eval: evalService,
  dispatcher: dispatcherService,
  toolBroker: toolBrokerService,
  recipes: recipeService,
  playbooks: playbookService,
  conversations: conversationService,
  iam: iamService,
  sandboxApps: sandboxAppService,
  connectorGrants: connectorGrantService,
  selfEvolutionGuard,
}
