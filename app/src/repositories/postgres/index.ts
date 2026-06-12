import { PostgresAgentRepository, PostgresDocumentRepository } from './agent-repository'
import { PostgresAuditRepository, PostgresModelCallRepository } from './audit-repository'
import { PostgresTicketRepository } from './ticket-repository'

export const repositories = {
  tickets: new PostgresTicketRepository(),
  agents: new PostgresAgentRepository(),
  documents: new PostgresDocumentRepository(),
  audit: new PostgresAuditRepository(),
  modelCalls: new PostgresModelCallRepository(),
}
