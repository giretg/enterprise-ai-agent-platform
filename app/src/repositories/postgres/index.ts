import { PostgresAgentRepository } from './agent-repository'
import { PostgresAgentDefinitionRepository } from './agent-definition-repository'
import { PostgresConnectorGrantRepository } from './connector-grant-repository'
import { PostgresConnectorRepository } from './connector-repository'
import { PostgresConnectorDraftRepository } from './connector-draft-repository'
import { PostgresConnectorTemplateRepository } from './connector-template-repository'
import { PostgresSelfUpdatingConnectorRepository } from './self-updating-connector-repository'
import { PostgresPlatformSettingsRepository } from './platform-settings-repository'
import { PostgresAuditRepository } from './audit-repository'
import { PostgresGatewayOperationRepository } from './gateway-operation-repository'
import { PostgresResourceGrantRepository } from './resource-grant-repository'
import { PostgresSkillRepository } from './skill-repository'
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
import {
  PostgresDocumentRepository,
  PostgresKnowledgeArtifactRepository,
  PostgresKnowledgeChunkRepository,
} from './knowledge-repository'

export const repositories = {
  users: new PostgresUserRepository(),
  invitations: new PostgresInvitationRepository(),
  rolePermissions: new PostgresRolePermissionRepository(),
  tenants: new PostgresTenantRepository(),
  tenantMemberships: new PostgresTenantMembershipRepository(),
  platformMemberships: new PostgresPlatformMembershipRepository(),
  agents: new PostgresAgentRepository(),
  agentDefinitions: new PostgresAgentDefinitionRepository(),
  resourceGrants: new PostgresResourceGrantRepository(),
  skills: new PostgresSkillRepository(),
  connectorGrants: new PostgresConnectorGrantRepository(),
  connectors: new PostgresConnectorRepository(),
  connectorDrafts: new PostgresConnectorDraftRepository(),
  connectorTemplates: new PostgresConnectorTemplateRepository(),
  selfUpdatingConnectors: new PostgresSelfUpdatingConnectorRepository(),
  platformSettings: new PostgresPlatformSettingsRepository(),
  gatewayOperations: new PostgresGatewayOperationRepository(),
  audit: new PostgresAuditRepository(),
  documents: new PostgresDocumentRepository(),
  knowledgeArtifacts: new PostgresKnowledgeArtifactRepository(),
  knowledgeChunks: new PostgresKnowledgeChunkRepository(),
}
