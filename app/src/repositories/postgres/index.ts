import { PostgresAgentRepository, PostgresDocumentRepository } from './agent-repository'
import { PostgresAgentAccessGrantRepository } from './agent-access-grant-repository'
import { PostgresBehaviorProfileRepository } from './behavior-profile-repository'
import { PostgresAuditRepository } from './audit-repository'
import {
  PostgresKnowledgeArtifactRepository,
  PostgresKnowledgeChunkRepository,
} from './knowledge-repository'
import { PostgresSkillRepository } from './skill-repository'
import { PostgresToolBrokerRepository } from './tool-broker-repository'
import { PostgresConnectorGrantRepository } from './connector-grant-repository'
import { PostgresConnectorRepository } from './connector-repository'
import { PostgresConnectorDraftRepository } from './connector-draft-repository'
import { PostgresConnectorTemplateRepository } from './connector-template-repository'
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
  agents: new PostgresAgentRepository(),
  agentAccessGrants: new PostgresAgentAccessGrantRepository(),
  behaviorProfiles: new PostgresBehaviorProfileRepository(),
  roleTemplates: new PostgresRoleTemplateRepository(),
  documents: new PostgresDocumentRepository(),
  audit: new PostgresAuditRepository(),
  toolBroker: new PostgresToolBrokerRepository(),
  skills: new PostgresSkillRepository(),
  connectorGrants: new PostgresConnectorGrantRepository(),
  connectors: new PostgresConnectorRepository(),
  connectorDrafts: new PostgresConnectorDraftRepository(),
  connectorTemplates: new PostgresConnectorTemplateRepository(),
  platformSettings: new PostgresPlatformSettingsRepository(),
  knowledgeArtifacts: new PostgresKnowledgeArtifactRepository(),
  knowledgeChunks: new PostgresKnowledgeChunkRepository(),
}
