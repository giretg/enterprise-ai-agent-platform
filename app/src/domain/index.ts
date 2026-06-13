import { ModelGateway } from '@/domain/gateway/model-gateway'
import { BookkeeperAgentRuntime } from '@/domain/agent/bookkeeper-runtime'
import { TicketService } from '@/domain/ticket/ticket-service'
import { TrainingService } from '@/domain/training/training-service'
import { AuditChainService } from '@/domain/audit/audit-chain-service'
import { WriteGateService } from '@/domain/writegate/write-gate-service'
import { EvalService } from '@/domain/eval/eval-service'
import { repositories } from '@/repositories/postgres'

const ticketService = new TicketService(repositories.tickets, repositories.audit)
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
const auditChainService = new AuditChainService(repositories.audit)

export const services = {
  tickets: ticketService,
  gateway: modelGateway,
  bookkeeper: bookkeeperRuntime,
  training: trainingService,
  auditChain: auditChainService,
  writeGate: writeGateService,
  eval: evalService,
}
