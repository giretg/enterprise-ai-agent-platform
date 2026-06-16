import { ModelGateway } from '@/domain/gateway/model-gateway'
import { BookkeeperAgentRuntime } from '@/domain/agent/bookkeeper-runtime'
import { WikiAgentRuntime } from '@/domain/agent/wiki-runtime'
import { TicketService } from '@/domain/ticket/ticket-service'
import { TrainingService } from '@/domain/training/training-service'
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
import { RecipeService } from '@/domain/recipe/recipe-service'
import { IamService } from '@/domain/iam/iam-service'
import { SandboxAppService } from '@/domain/sandbox/sandbox-app-service'
import { repositories } from '@/repositories/postgres'

const ticketService = new TicketService(repositories.tickets, repositories.audit)
const toolAuthorizer = new AllowlistAuthorizer(repositories.toolBroker)
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
const trainingService = new TrainingService(
  repositories.tickets,
  repositories.audit,
  ticketService,
  writeGateService,
  evalService,
)
const toolBrokerService = new ToolBrokerService(
  repositories.agents,
  repositories.tickets,
  repositories.toolBroker,
  repositories.audit,
  ticketService,
  toolAuthorizer,
)
const wikiRuntime = new WikiAgentRuntime(
  repositories.agents,
  repositories.tickets,
  modelGateway,
  ticketService,
  toolBrokerService,
)
const auditChainService = new AuditChainService(repositories.audit)
const recipeService = new RecipeService(repositories.recipes, repositories.audit)
const iamService = new IamService(repositories.audit)
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
  wiki: wikiRuntime,
  bookkeeper: bookkeeperRuntime,
  training: trainingService,
  auditChain: auditChainService,
  writeGate: writeGateService,
  eval: evalService,
  dispatcher: dispatcherService,
  toolBroker: toolBrokerService,
  recipes: recipeService,
  iam: iamService,
  sandboxApps: sandboxAppService,
}
