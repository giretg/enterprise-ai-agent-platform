import { PostgresAgentRepository, PostgresDocumentRepository } from './agent-repository'
import { PostgresBehaviorProfileRepository } from './behavior-profile-repository'
import {
  PostgresAuditRepository,
  PostgresModelBudgetRepository,
  PostgresModelCallRepository,
  PostgresModelRoutingPolicyRepository,
} from './audit-repository'
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
import { PostgresConnectorDraftRepository } from './connector-draft-repository'
import { PostgresMonitorRepository } from './monitor-repository'
import { PostgresPlatformSettingsRepository } from './platform-settings-repository'
import { PostgresRoleTemplateRepository } from './role-template-repository'
import {
  PostgresUserRepository,
  PostgresInvitationRepository,
  PostgresRolePermissionRepository,
} from './iam-repository'

export const repositories = {
  users: new PostgresUserRepository(),
  invitations: new PostgresInvitationRepository(),
  rolePermissions: new PostgresRolePermissionRepository(),
  tickets: new PostgresTicketRepository(),
  agents: new PostgresAgentRepository(),
  behaviorProfiles: new PostgresBehaviorProfileRepository(),
  roleTemplates: new PostgresRoleTemplateRepository(),
  documents: new PostgresDocumentRepository(),
  audit: new PostgresAuditRepository(),
  modelCalls: new PostgresModelCallRepository(),
  modelRoutingPolicies: new PostgresModelRoutingPolicyRepository(),
  modelBudgets: new PostgresModelBudgetRepository(),
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
  connectorDrafts: new PostgresConnectorDraftRepository(),
  monitors: new PostgresMonitorRepository(),
  platformSettings: new PostgresPlatformSettingsRepository(),
}
