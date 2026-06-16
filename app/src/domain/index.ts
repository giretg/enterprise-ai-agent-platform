import { ModelGateway } from '@/domain/gateway/model-gateway'
import { BookkeeperAgentRuntime } from '@/domain/agent/bookkeeper-runtime'
import { WikiAgentRuntime } from '@/domain/agent/wiki-runtime'
import { TicketService } from '@/domain/ticket/ticket-service'
import { TrainingService } from '@/domain/training/training-service'
import { AuditChainService } from '@/domain/audit/audit-chain-service'
import { WriteGateService } from '@/domain/writegate/write-gate-service'
import { EvalService } from '@/domain/eval/eval-service'
import { DispatcherService, type HarnessLauncher } from '@/domain/dispatcher/dispatcher-service'
import { AllowlistAuthorizer, ToolBrokerService } from '@/domain/tool-broker/tool-broker-service'
import { RecipeService } from '@/domain/recipe/recipe-service'
import { IamService } from '@/domain/iam/iam-service'
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
const pendingHarnessLauncher: HarnessLauncher = {
  async launch() {
    throw new Error('Harness launcher is not configured yet (S1-S4 spike pending)')
  },
}
const dispatcherService = new DispatcherService(
  repositories.tickets,
  repositories.audit,
  repositories.modelCalls,
  pendingHarnessLauncher,
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
}
