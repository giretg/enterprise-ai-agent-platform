import { PostgresAgentRepository, PostgresDocumentRepository } from './agent-repository'
import { PostgresAuditRepository, PostgresModelCallRepository } from './audit-repository'
import { PostgresConversationRepository } from './conversation-repository'
import { PostgresRecipeRepository } from './recipe-repository'
import { PostgresPlaybookRepository } from './playbook-repository'
import { PostgresPlaybookV2Repository } from './playbook-v2-repository'
import { PostgresProcessRepository } from './process-repository'
import { PostgresSandboxAppRepository } from './sandbox-app-repository'
import { PostgresScheduledTaskRepository } from './scheduled-task-repository'
import { PostgresTicketRepository } from './ticket-repository'
import { PostgresToolBrokerRepository } from './tool-broker-repository'

import { PostgresConnectorGrantRepository } from './connector-grant-repository'
import { PostgresConnectorRepository } from './connector-repository'
import { PostgresMonitorRepository } from './monitor-repository'
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
  playbooksV2: new PostgresPlaybookV2Repository(),
  processes: new PostgresProcessRepository(),
  sandboxApps: new PostgresSandboxAppRepository(),
  scheduledTasks: new PostgresScheduledTaskRepository(),
  conversations: new PostgresConversationRepository(),
  connectorGrants: new PostgresConnectorGrantRepository(),
  connectors: new PostgresConnectorRepository(),
  monitors: new PostgresMonitorRepository(),
  platformSettings: new PostgresPlatformSettingsRepository(),
}
