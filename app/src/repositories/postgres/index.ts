import { PostgresAgentRepository, PostgresDocumentRepository } from './agent-repository'
import { PostgresAuditRepository, PostgresModelCallRepository } from './audit-repository'
import { PostgresRecipeRepository } from './recipe-repository'
import { PostgresSandboxAppRepository } from './sandbox-app-repository'
import { PostgresTicketRepository } from './ticket-repository'
import { PostgresToolBrokerRepository } from './tool-broker-repository'

export const repositories = {
  tickets: new PostgresTicketRepository(),
  agents: new PostgresAgentRepository(),
  documents: new PostgresDocumentRepository(),
  audit: new PostgresAuditRepository(),
  modelCalls: new PostgresModelCallRepository(),
  toolBroker: new PostgresToolBrokerRepository(),
  recipes: new PostgresRecipeRepository(),
  sandboxApps: new PostgresSandboxAppRepository(),
}
