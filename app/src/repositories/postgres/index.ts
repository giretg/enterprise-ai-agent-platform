import { PostgresAgentRepository, PostgresDocumentRepository } from './agent-repository'
import { PostgresAuditRepository, PostgresModelCallRepository } from './audit-repository'
import { PostgresConversationRepository } from './conversation-repository'
import { PostgresRecipeRepository } from './recipe-repository'
import { PostgresPlaybookRepository } from './playbook-repository'
import { PostgresSandboxAppRepository } from './sandbox-app-repository'
import { PostgresScheduledTaskRepository } from './scheduled-task-repository'
import { PostgresTicketRepository } from './ticket-repository'
import { PostgresToolBrokerRepository } from './tool-broker-repository'

import { PostgresConnectorGrantRepository } from './connector-grant-repository'
import { PostgresConnectorRepository } from './connector-repository'
import { PostgresPlatformSettingsRepository } from './platform-settings-repository'

export const repositories = {
  tickets: new PostgresTicketRepository(),
  agents: new PostgresAgentRepository(),
  documents: new PostgresDocumentRepository(),
  audit: new PostgresAuditRepository(),
  modelCalls: new PostgresModelCallRepository(),
  toolBroker: new PostgresToolBrokerRepository(),
  recipes: new PostgresRecipeRepository(),
  playbooks: new PostgresPlaybookRepository(),
  sandboxApps: new PostgresSandboxAppRepository(),
  scheduledTasks: new PostgresScheduledTaskRepository(),
  conversations: new PostgresConversationRepository(),
  connectorGrants: new PostgresConnectorGrantRepository(),
  connectors: new PostgresConnectorRepository(),
  platformSettings: new PostgresPlatformSettingsRepository(),
}
