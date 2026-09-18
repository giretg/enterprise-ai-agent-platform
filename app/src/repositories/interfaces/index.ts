import type {
  Agent,
  AgentDefinitionVersion,
  AgentSkill,
  AuditLog,
  Capability,
  Connector,
  ConnectorAccessMode,
  ConnectorAuthMode,
  ConnectorDraft,
  ConnectorDraftReviewStatus,
  ConnectorDraftSourceType,
  ConnectorGrant,
  ConnectorGrantStatus,
  ConnectorLifecycleState,
  ConnectorTemplate,
  ConnectorTemplateOrigin,
  ConnectorTemplateStatus,
  ConnectorType,
  Invitation,
  InvitationStatus,
  PlatformMembership,
  PlatformMembershipStatus,
  PlatformRole,
  Prisma,
  ResourceAccessLevel,
  ResourceGrant,
  ResourceGrantType,
  RolePermission,
  Skill,
  SkillCatalogScope,
  SkillKind,
  SkillRiskTier,
  SkillSourceType,
  SkillVersion,
  SkillVersionStatus,
  Tenant,
  TenantMembership,
  TenantMembershipStatus,
  TenantStatus,
  User,
  UserRole,
  UserStatus,
} from '@prisma/client'
import type { ListPageResult } from '@/lib/list-pagination'
import type { AuditAppendInput } from '@/lib/audit/types'

export type { ListPageResult }
export type { AuditAppendInput }

export type AgentListFilter = {
  tenantId?: string
  ids?: string[]
  status?: Agent['status']
  limit?: number
  offset?: number
  unbounded?: boolean
}

export type AgentConnectorBinding = {
  connector: Connector
  accessMode: ConnectorAccessMode
}

export interface AgentRepository {
  findMany(filter?: AgentListFilter): Promise<Agent[]>
  listPage(filter?: AgentListFilter): Promise<ListPageResult<Agent>>
  count(filter?: { tenantId?: string; status?: Agent['status'] }): Promise<number>
  findById(id: string, tenantId?: string): Promise<Agent | null>
  create(input: {
    name: string
    roleInstruction: string
    tenantId: string
    status?: Agent['status']
  }): Promise<Agent>
  updateInstruction(input: { agentId: string; roleInstruction: string }): Promise<Agent>
  updateAvatar(input: { agentId: string; avatarUrl: string }): Promise<Agent>
  setCurrentDefinitionVersionId(agentId: string, versionId: string): Promise<Agent>
  activate(agentId: string): Promise<Agent>
  suspend(agentId: string, reason?: string): Promise<Agent>
  resume(agentId: string): Promise<Agent>
  retire(agentId: string): Promise<Agent>
  delete(agentId: string): Promise<void>
  findCapabilitiesForAgent(agentId: string): Promise<{ toolName: string; allowed: boolean }[]>
  findConnectorsForAgent(agentId: string): Promise<AgentConnectorBinding[]>
  replaceCapabilities(agentId: string, toolNames: string[]): Promise<void>
  upsertConnectorBinding(input: {
    agentId: string
    connectorId: string
    accessMode: ConnectorAccessMode
  }): Promise<void>
}

export type AgentDefinitionVersionRow = AgentDefinitionVersion

export interface AgentDefinitionRepository {
  create(data: {
    agentId: string
    version: number
    snapshot: Prisma.InputJsonValue
    contentHash: string
    publishedById: string
  }): Promise<AgentDefinitionVersion>
  findById(id: string): Promise<AgentDefinitionVersion | null>
  findByAgentAndVersion(agentId: string, version: number): Promise<AgentDefinitionVersion | null>
  findMaxVersion(agentId: string): Promise<number>
}

export interface ResourceGrantRepository {
  findAgentGrant(input: {
    tenantId: string
    userId: string
    agentId: string
  }): Promise<ResourceGrant | null>
  listAgentGrantsForUser(input: { tenantId: string; userId: string }): Promise<ResourceGrant[]>
  listAgentIdsGrantedToUser(input: { tenantId: string; userId: string }): Promise<string[]>
}

export type SkillWithVersions = Skill & { versions: SkillVersion[] }
export type AgentSkillWithVersion = AgentSkill & {
  skillVersion: SkillVersion & { skill: Skill }
}

export interface CreateSkillInput {
  name: string
  displayName?: string | null
  description: string
  catalogScope: SkillCatalogScope
  tenantId: string | null
  kind: SkillKind
  sourceType: SkillSourceType
  provenance: Prisma.InputJsonValue | null
  license: string | null
  riskTier: SkillRiskTier
  content: Prisma.InputJsonValue
  requires: Prisma.InputJsonValue
  attachments?: Prisma.InputJsonValue
  contentHash: string
}

export interface AddSkillVersionInput {
  skillId: string
  content: Prisma.InputJsonValue
  requires: Prisma.InputJsonValue
  attachments?: Prisma.InputJsonValue
  contentHash: string
}

export type AgentSkillMigration = {
  agentId: string
  fromVersionId: string
  toVersionId: string
  enabled: boolean
}

export type SkillVersionActivationResult = {
  version: SkillVersion
  agentMigrations: AgentSkillMigration[]
}

export interface SkillRepository {
  listForTenant(actorTenantId: string | null): Promise<SkillWithVersions[]>
  findById(id: string): Promise<SkillWithVersions | null>
  findByNameInScope(name: string, tenantId: string | null): Promise<Skill | null>
  findVersionById(versionId: string): Promise<(SkillVersion & { skill: Skill }) | null>
  findVersionsByIds(versionIds: string[]): Promise<(SkillVersion & { skill: Skill })[]>
  createSkill(input: CreateSkillInput): Promise<{ skill: Skill; version: SkillVersion }>
  updateDisplayName(skillId: string, displayName: string | null): Promise<Skill>
  updateDescription(skillId: string, description: string): Promise<Skill>
  updateKind(skillId: string, kind: SkillKind): Promise<Skill>
  addVersion(input: AddSkillVersionInput): Promise<SkillVersion>
  approveVersion(
    versionId: string,
    params: { approverId: string },
  ): Promise<SkillVersionActivationResult>
  rollbackToVersion(
    versionId: string,
    params: { approverId: string },
  ): Promise<SkillVersionActivationResult>
  retireActiveVersion(skillId: string): Promise<SkillVersion | null>
  getActiveVersion(skillId: string): Promise<SkillVersion | null>
  countAssignmentsForSkill(skillId: string): Promise<number>
  detachAllAssignmentsForSkill(skillId: string): Promise<number>
  deleteSkill(skillId: string): Promise<void>
  assign(input: {
    agentId: string
    skillVersionId: string
    assignedById: string | null
  }): Promise<{ assignment: AgentSkill; replacedVersionIds: string[] }>
  unassign(agentId: string, skillVersionId: string): Promise<void>
  setEnabled(agentId: string, skillVersionId: string, enabled: boolean): Promise<AgentSkill>
  listAgentSkills(agentId: string): Promise<AgentSkillWithVersion[]>
  listEnabledForAgent(agentId: string): Promise<AgentSkillWithVersion[]>
  findAssignment(agentId: string, skillVersionId: string): Promise<AgentSkillWithVersion | null>
}

export interface ConnectorGrantRepository {
  findActiveGrant(params: {
    tenantId: string
    connectorId: string
    userId: string
  }): Promise<ConnectorGrant | null>
  findActiveByConnector(connectorId: string): Promise<ConnectorGrant[]>
  findActiveForInactiveConnectors(userId: string, tenantId?: string): Promise<ConnectorGrant[]>
  findByUser(
    userId: string,
    tenantId?: string,
  ): Promise<
    Array<
      ConnectorGrant & {
        connector: {
          id: string
          name: string
          type: string
          lifecycleState: ConnectorLifecycleState
        }
      }
    >
  >
  create(data: {
    tenantId: string
    connectorId: string
    userId: string
    scopes: Prisma.JsonValue
    tokenRef: string
    accountLabel?: string | null
    expiresAt?: Date | null
  }): Promise<ConnectorGrant>
  updateStatus(
    id: string,
    status: ConnectorGrantStatus,
    extra?: { revokedAt?: Date; lastRefreshedAt?: Date; expiresAt?: Date | null },
  ): Promise<ConnectorGrant>
  revokeAllForUser(userId: string): Promise<number>
  findById(id: string): Promise<ConnectorGrant | null>
  updateMetadata(id: string, metadata: Prisma.InputJsonValue): Promise<ConnectorGrant>
}

export type ConnectorDraftWithConnector = ConnectorDraft & {
  connector: Connector
}

export interface CreateConnectorDraftInput {
  tenantId: string
  name: string
  connectorType?: ConnectorType
  authMode: ConnectorAuthMode
  sourceType: ConnectorDraftSourceType
  sourceRef: string | null
  sourceHash: string
  config: Prisma.InputJsonValue
  secretAliasSuggested: string | null
  generatedByAgentId: string | null
}

export type NewTemplateVersion = {
  key: string
  version: number
  origin: ConnectorTemplateOrigin
  displayName: string
  description?: string | null
  tenantId: string | null
  descriptor: Prisma.InputJsonValue
  status?: ConnectorTemplateStatus
  createdById?: string | null
}

export interface ConnectorTemplateRepository {
  listVisible(scope: { tenantId: string | null }): Promise<ConnectorTemplate[]>
  findLatestByKey(key: string, tenantId: string | null): Promise<ConnectorTemplate | null>
  findByIdVersion(id: string): Promise<ConnectorTemplate | null>
  createVersion(input: NewTemplateVersion): Promise<ConnectorTemplate>
  deprecate(id: string): Promise<void>
  upsertBuiltin(input: NewTemplateVersion): Promise<ConnectorTemplate>
}

export interface ConnectorRepository {
  findById(id: string, tenantId?: string): Promise<Connector | null>
  listActive(tenantId: string): Promise<Connector[]>
}

export interface ConnectorDraftRepository {
  createDraft(input: CreateConnectorDraftInput): Promise<ConnectorDraftWithConnector>
  findById(draftId: string): Promise<ConnectorDraftWithConnector | null>
  findByConnectorId(connectorId: string): Promise<ConnectorDraftWithConnector | null>
  list(tenantId: string): Promise<ConnectorDraftWithConnector[]>
  setValidationResult(draftId: string, result: Prisma.InputJsonValue): Promise<ConnectorDraft>
  setReview(params: {
    draftId: string
    reviewStatus: ConnectorDraftReviewStatus
    reviewedById: string
  }): Promise<ConnectorDraft>
  setSandboxTestResult(draftId: string, ok: boolean): Promise<ConnectorDraft>
  activate(params: {
    draftId: string
    secretAlias: string
    authMode: ConnectorAuthMode
    secondApproverId: string | null
    config?: Prisma.InputJsonValue
  }): Promise<Connector>
  assignToAgent(params: {
    connectorId: string
    agentId: string
    accessMode: ConnectorAccessMode
  }): Promise<void>
  unassignFromAgent(params: { connectorId: string; agentId: string }): Promise<{ removed: boolean }>
  updateDraftConfig(params: {
    draftId: string
    config: Prisma.InputJsonValue
    authMode: ConnectorAuthMode
    sourceHash: string
    secretAliasSuggested: string | null
  }): Promise<ConnectorDraftWithConnector>
  reopen(params: { draftId: string }): Promise<Connector>
  decommission(params: { draftId: string }): Promise<{ connectorId: string; affectedAgentIds: string[] }>
  findConnectorById(connectorId: string): Promise<{
    id: string
    tenantId: string
    lifecycleState: string
    secretAlias: string | null
  } | null>
  decommissionByConnectorId(params: {
    connectorId: string
  }): Promise<{ connectorId: string; affectedAgentIds: string[] }>
  deleteDraft(params: { draftId: string }): Promise<void>
  listActiveCatalog(tenantId: string): Promise<
    Array<{
      id: string
      type: ConnectorType
      name: string
      description?: string | null
      baseUrl?: string | null
      tools?: Array<{ method: string; path: string; description?: string | null }>
    }>
  >
}

export type { ConnectorLifecycleState, ResourceAccessLevel, ResourceGrantType }

export interface UserRepository {
  findById(id: string): Promise<User | null>
  findByExternalAuthId(externalAuthId: string): Promise<User | null>
  findManyByEmail(email: string): Promise<User[]>
  findMany(filter?: {
    tenantId?: string
    status?: UserStatus
    role?: UserRole
    limit?: number
    offset?: number
    unbounded?: boolean
  }): Promise<User[]>
  findManyByIds(ids: string[]): Promise<User[]>
  countActiveAdmins(tenantId: string, excludeUserId?: string): Promise<number>
  create(data: {
    externalAuthId: string
    email: string
    name: string
    role?: UserRole | null
    status?: UserStatus
    invitedById?: string | null
  }): Promise<User>
  update(
    id: string,
    data: Partial<{
      externalAuthId: string
      role: UserRole | null
      status: UserStatus
      invitedById: string | null
      activatedAt: Date | null
      suspendedAt: Date | null
      suspendedById: string | null
      suspendedReason: string | null
      lastLoginAt: Date | null
      email: string
      name: string
    }>,
  ): Promise<User>
  upsertByExternalAuthId(params: {
    externalAuthId: string
    create: {
      email: string
      name: string
      role?: UserRole | null
      status?: UserStatus
    }
    update: Partial<{
      role: UserRole | null
      status: UserStatus
      activatedAt: Date
      invitedById: string | null
    }>
  }): Promise<User>
}

export interface InvitationRepository {
  findById(id: string): Promise<Invitation | null>
  findByTokenHash(tokenHash: string): Promise<Invitation | null>
  findMany(filter?: {
    tenantId?: string | null
    status?: InvitationStatus
    limit?: number
    offset?: number
    unbounded?: boolean
  }): Promise<Invitation[]>
  claimPendingRedemption(id: string, email: string, now: Date): Promise<Invitation | null>
  revokePending(id: string, revokedAt: Date): Promise<Invitation | null>
  create(data: {
    tenantId: string | null
    email: string
    role: UserRole
    tokenHash: string
    expiresAt: Date
    createdById: string
  }): Promise<Invitation>
  update(
    id: string,
    data: Partial<{
      status: InvitationStatus
      redeemedAt: Date
      revokedAt: Date
      clerkInvitationId: string | null
    }>,
  ): Promise<Invitation>
}

export interface RolePermissionRepository {
  findAll(): Promise<RolePermission[]>
  findByKey(permissionKey: string): Promise<RolePermission | null>
  findByKeys(permissionKeys: string[]): Promise<RolePermission[]>
  upsert(permissionKey: string, minRole: UserRole, description?: string | null): Promise<RolePermission>
}

export interface TenantRepository {
  findById(id: string): Promise<Tenant | null>
  findByIds(ids: string[]): Promise<Tenant[]>
  findBySlug(slug: string): Promise<Tenant | null>
  findMany(filter?: { status?: TenantStatus }): Promise<Tenant[]>
  create(data: {
    slug: string
    displayName: string
    legalName?: string | null
    domainAllowlist?: string[]
    settings?: Prisma.InputJsonValue
    createdById?: string | null
  }): Promise<Tenant>
  update(
    id: string,
    data: Partial<{
      displayName: string
      legalName: string | null
      status: TenantStatus
      domainAllowlist: string[]
      settings: Prisma.InputJsonValue
    }>,
  ): Promise<Tenant>
}

export type TenantMembershipWithUser = TenantMembership & {
  userEmail: string
  userName: string
}

export interface TenantMembershipRepository {
  findById(id: string): Promise<TenantMembership | null>
  findByTenantAndUser(tenantId: string, userId: string): Promise<TenantMembership | null>
  findByUser(userId: string): Promise<TenantMembership[]>
  findByTenant(
    tenantId: string,
    filter?: { status?: TenantMembershipStatus; role?: UserRole },
  ): Promise<TenantMembership[]>
  findByTenantWithUsers(tenantId: string): Promise<TenantMembershipWithUser[]>
  countActiveAdmins(tenantId: string, excludeUserId?: string): Promise<number>
  create(data: {
    tenantId: string
    userId: string
    role: UserRole
    status?: TenantMembershipStatus
    isDefault?: boolean
    invitedById?: string | null
  }): Promise<TenantMembership>
  upsert(data: {
    tenantId: string
    userId: string
    role: UserRole
    status?: TenantMembershipStatus
    isDefault?: boolean
    invitedById?: string | null
  }): Promise<TenantMembership>
  update(
    id: string,
    data: Partial<{
      role: UserRole
      status: TenantMembershipStatus
      isDefault: boolean
      activatedAt: Date | null
    }>,
  ): Promise<TenantMembership>
}

export type PlatformMembershipWithUser = PlatformMembership & {
  userEmail: string
  userName: string
}

export interface PlatformMembershipRepository {
  findByUser(userId: string): Promise<PlatformMembership[]>
  findByRole(
    role: PlatformRole,
    filter?: { status?: PlatformMembershipStatus },
  ): Promise<PlatformMembership[]>
  findAll(): Promise<PlatformMembershipWithUser[]>
  upsert(data: {
    userId: string
    role: PlatformRole
    status?: PlatformMembershipStatus
  }): Promise<PlatformMembership>
  delete(userId: string, role: PlatformRole): Promise<void>
}

export interface PlatformSettingsRepository {
  get(key: string): Promise<unknown | null>
  set(
    key: string,
    value: Prisma.InputJsonValue | Prisma.NullTypes.JsonNull,
    updatedById?: string | null,
  ): Promise<void>
}

export type { Capability }

export type { GatewayOperationStore as GatewayOperationRepository } from '@/domain/gateway-operation'

export type AuditListFilter = {
  action?: string | string[]
  actorType?: AuditLog['actorType']
  actorId?: string
  targetType?: string
  targetId?: string
  tenantId?: string
  since?: Date
  until?: Date
  order?: 'asc' | 'desc'
  limit?: number
}

export type AuditWalkFilter = {
  fromSeq?: bigint
  toSeq?: bigint
  tenantId?: string
  since?: Date
  limit?: number
}

export type AuditChainLink = {
  seq: bigint
  hash: string | null
}

export interface AuditRepository {
  append(data: AuditAppendInput): Promise<AuditLog>
  findMany(filter?: AuditListFilter): Promise<AuditLog[]>
  findAll(filter?: AuditWalkFilter): Promise<AuditLog[]>
  /** Seq+hash only — tenant verify uses this for predecessor linkage without other-tenant metadata. */
  listHashChain(filter?: { fromSeq?: bigint; toSeq?: bigint }): Promise<AuditChainLink[]>
  getActionCounts(filter?: { actions?: string[]; since?: Date }): Promise<Record<string, number>>
}
