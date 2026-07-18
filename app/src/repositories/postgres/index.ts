import { PostgresAgentRepository, PostgresDocumentRepository } from './agent-repository'
import { PostgresAgentTurnRepository } from './agent-turn-repository'
import { PostgresBehaviorProfileRepository } from './behavior-profile-repository'
import {
  PostgresAuditRepository,
  PostgresModelBudgetRepository,
  PostgresModelCallRepository,
  PostgresModelRoutingPolicyRepository,
} from './audit-repository'
import { PostgresConversationRepository } from './conversation-repository'
import {
  PostgresKnowledgeArtifactRepository,
  PostgresKnowledgeChunkRepository,
} from './knowledge-repository'
import {
  PostgresMemoryChunkRepository,
  PostgresMemoryCandidateRepository,
  PostgresMemoryVersionRepository,
} from './memory-repository'
import { PostgresRecipeRepository } from './recipe-repository'
import { PostgresSkillRepository } from './skill-repository'
import { PostgresPlaybookRepository } from './playbook-repository'
import { PostgresPlaybookV2Repository } from './playbook-v2-repository'
import { PostgresProcessRepository } from './process-repository'
import { PostgresProcessDefinitionRepository } from './process-definition-repository'
import { PostgresSandboxAppRepository } from './sandbox-app-repository'
import { PostgresSandboxVersioningRepository } from './sandbox-versioning-repository'
import { PostgresScheduledTaskRepository } from './scheduled-task-repository'
import { PostgresTicketRepository } from './ticket-repository'
import { PostgresToolBrokerRepository } from './tool-broker-repository'

import { PostgresConnectorGrantRepository } from './connector-grant-repository'
import { PostgresConnectorRepository } from './connector-repository'
import { PostgresSelfUpdatingConnectorRepository } from './self-updating-connector-repository'
import { PostgresConnectorDraftRepository } from './connector-draft-repository'
import { PostgresConnectorTemplateRepository } from './connector-template-repository'
import { PostgresMonitorRepository } from './monitor-repository'
import { PostgresPlatformSettingsRepository } from './platform-settings-repository'
import { PostgresRoleTemplateRepository } from './role-template-repository'
import {
  PostgresUserRepository,
  PostgresInvitationRepository,
  PostgresRolePermissionRepository,
} from './iam-repository'
import {
  PostgresTenantRepository,
  PostgresTenantMembershipRepository,
  PostgresPlatformMembershipRepository,
} from './tenant-repository'

export const repositories = {
  users: new PostgresUserRepository(),
  invitations: new PostgresInvitationRepository(),
  rolePermissions: new PostgresRolePermissionRepository(),
  tenants: new PostgresTenantRepository(),
  tenantMemberships: new PostgresTenantMembershipRepository(),
  platformMemberships: new PostgresPlatformMembershipRepository(),
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
  skills: new PostgresSkillRepository(),
  playbooks: new PostgresPlaybookRepository(),
  playbooksV2: new PostgresPlaybookV2Repository(),
  processes: new PostgresProcessRepository(),
  processDefinitions: new PostgresProcessDefinitionRepository(),
  sandboxApps: new PostgresSandboxAppRepository(),
  sandboxVersioning: new PostgresSandboxVersioningRepository(),
  scheduledTasks: new PostgresScheduledTaskRepository(),
  conversations: new PostgresConversationRepository(),
  agentTurns: new PostgresAgentTurnRepository(),
  connectorGrants: new PostgresConnectorGrantRepository(),
  connectors: new PostgresConnectorRepository(),
  selfUpdatingConnectors: new PostgresSelfUpdatingConnectorRepository(),
  connectorDrafts: new PostgresConnectorDraftRepository(),
  connectorTemplates: new PostgresConnectorTemplateRepository(),
  monitors: new PostgresMonitorRepository(),
  platformSettings: new PostgresPlatformSettingsRepository(),
  knowledgeArtifacts: new PostgresKnowledgeArtifactRepository(),
  knowledgeChunks: new PostgresKnowledgeChunkRepository(),
  memoryChunks: new PostgresMemoryChunkRepository(),
  memoryCandidates: new PostgresMemoryCandidateRepository(),
  memoryVersions: new PostgresMemoryVersionRepository(),
}
