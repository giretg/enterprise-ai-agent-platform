import { ModelGateway } from '@/domain/gateway/model-gateway'
import { BookkeeperAgentRuntime } from '@/domain/agent/bookkeeper-runtime'
import { TicketService } from '@/domain/ticket/ticket-service'
import { TrainingService } from '@/domain/training/training-service'
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
const trainingService = new TrainingService(
  repositories.tickets,
  repositories.audit,
  ticketService,
)

export const services = {
  tickets: ticketService,
  gateway: modelGateway,
  bookkeeper: bookkeeperRuntime,
  training: trainingService,
}
