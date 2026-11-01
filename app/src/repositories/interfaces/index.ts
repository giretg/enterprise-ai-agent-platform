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
  ContactInquiry,
  ContactInquiryStatus,
  ConnectorType,
  Document,
  DocumentStatus,
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
  Tenant,
  TenantMembership,
  TenantMembershipStatus,
  TenantStatus,
  User,
  UserRole,
  UserStatus,
  KnowledgeArtifact,
  KnowledgeArtifactStatus,
  KnowledgeProcessingMode,
  AgentWiki,
  MemoryWriteMode,
  WikiAccess,
  WikiChangeSet,
  WikiChangeSetStatus,
  WikiInboxStatus,
  WikiLogEntry,
  WikiLogOp,
  WikiPage,
  WikiPageRevision,
  WikiPageStatus,
  WikiPageType,
  WikiTag,
} from '@prisma/client'
import type { GoogleAccountBinding } from '@/domain/connector/google-account-binding'
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
  /** #942: csak knowledge_base-nél számít; régi fake-ekben hiányozhat (= read / approval). */
  wikiAccess?: WikiAccess
  wikiWriteMode?: MemoryWriteMode
  wikiCollectFocus?: string | null
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
    description?: string | null
  }): Promise<Agent>
  updateInstruction(input: { agentId: string; roleInstruction: string }): Promise<Agent>
  updateProfile(input: { agentId: string; name?: string; description?: string | null }): Promise<Agent>
  updateAvatar(input: { agentId: string; avatarUrl: string | null }): Promise<Agent>
  updateMemoryWriteMode(input: {
    agentId: string
    memoryWriteMode: Agent['memoryWriteMode']
  }): Promise<Agent>
  updateWriteApprovalModes(input: {
    agentId: string
    memoryWriteMode: Agent['memoryWriteMode']
    httpApiWriteMode: Agent['httpApiWriteMode']
    gmailWriteMode: Agent['gmailWriteMode']
    driveWriteMode: Agent['driveWriteMode']
  }): Promise<Agent>
  updateOutputFolder(input: { agentId: string; folderId: string | null }): Promise<Agent>
  updateLocalRoots(input: { agentId: string; localRoots: string }): Promise<Agent>
  updateMiniAppGuide(input: { agentId: string; miniAppGuide: string }): Promise<Agent>
  updatePlacementOverrides(input: { agentId: string; placementOverrides: Prisma.InputJsonValue | null }): Promise<Agent>
  updateModelConfig(input: { agentId: string; modelConfig: Prisma.InputJsonValue }): Promise<Agent>
  updateApprover(input: { agentId: string; approverUserId: string | null }): Promise<Agent>
  setCurrentDefinitionVersionId(agentId: string, versionId: string): Promise<Agent>
  activate(agentId: string): Promise<Agent>
  suspend(agentId: string, reason?: string): Promise<Agent>
  resume(agentId: string): Promise<Agent>
  retire(agentId: string): Promise<Agent>
  delete(agentId: string, opts?: { force?: boolean }): Promise<void>
  findCapabilitiesForAgent(agentId: string): Promise<{ toolName: string; allowed: boolean }[]>
  findConnectorsForAgent(agentId: string): Promise<AgentConnectorBinding[]>
  replaceCapabilities(agentId: string, toolNames: string[]): Promise<void>
  upsertConnectorBinding(input: {
    agentId: string
    connectorId: string
    accessMode: ConnectorAccessMode
    /** #942: csak új kötésnél alkalmazott kezdőérték (pl. privát wikinél `direct`, D14). */
    initialWikiWriteMode?: MemoryWriteMode
  }): Promise<void>
  /** #942 D1/D2: wiki-jog a meglévő kötésen; `null` = nincs ilyen kötés. */
  updateWikiLink(input: {
    agentId: string
    connectorId: string
    accessMode?: ConnectorAccessMode
    wikiAccess?: WikiAccess
    wikiWriteMode?: MemoryWriteMode
    wikiCollectFocus?: string | null
  }): Promise<AgentConnectorBinding | null>
  findConnectorBinding(agentId: string, connectorId: string): Promise<AgentConnectorBinding | null>
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
  listAgentGrantsForAgent(input: {
    tenantId: string
    agentId: string
  }): Promise<Array<ResourceGrant & { user: { id: string; name: string; email: string } }>>
  upsertAgentGrant(input: {
    tenantId: string
    userId: string
    agentId: string
    accessLevel: 'view' | 'operate'
    grantedById: string
  }): Promise<ResourceGrant>
  revokeAgentGrant(input: {
    tenantId: string
    userId: string
    agentId: string
  }): Promise<void>
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
  producesSkills?: boolean
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
  /** Azok az agentek (egyedileg), amelyekhez a skill bármely verziója hozzá van rendelve. */
  listAgentsUsingSkill(skillId: string): Promise<Array<{ id: string; name: string }>>
  detachAllAssignmentsForSkill(skillId: string): Promise<number>
  deleteSkill(skillId: string): Promise<void>
  assign(input: {
    agentId: string
    skillVersionId: string
    assignedById: string | null
  }): Promise<{ assignment: AgentSkill; replacedVersionIds: string[] }>
  unassign(agentId: string, skillVersionId: string): Promise<void>
  setEnabled(agentId: string, skillVersionId: string, enabled: boolean): Promise<AgentSkill>
  /** entry=true clears the flag on the agent's other skills (at most one entry skill per agent). */
  setEntry(agentId: string, skillVersionId: string, entry: boolean): Promise<void>
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
  findActiveGrants(params: {
    tenantId: string
    connectorId: string
    userId: string
  }): Promise<ConnectorGrant[]>
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
    nickname?: string | null
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
  /** Optimista CAS: csak akkor ír, ha a metadata még `expected`; különben `false`. */
  updateMetadataIfMatch(
    id: string,
    expected: Prisma.InputJsonValue,
    metadata: Prisma.InputJsonValue,
  ): Promise<boolean>
  updateNickname(id: string, nickname: string | null): Promise<ConnectorGrant>
  /** #1028: a konnektor tenant-postafiók grantje (aktív). */
  findActiveTenantGrant(params: { tenantId: string; connectorId: string }): Promise<ConnectorGrant | null>
  /** #1028: a konnektor legutóbbi tenant-grantje, státusztól függetlenül. */
  findLatestTenantGrant(params: { tenantId: string; connectorId: string }): Promise<ConnectorGrant | null>
  /** #1028: tenant-grant létrehozása vagy újracsatlakoztatása (konnektoronként egy). */
  upsertTenantGrant(data: {
    tenantId: string
    connectorId: string
    scopes: Prisma.JsonValue
    tokenRef: string
    accountLabel: string | null
    expiresAt?: Date | null
    metadata: Prisma.InputJsonValue
  }): Promise<ConnectorGrant>
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
  findByTenantTypeAndName(
    tenantId: string,
    type: ConnectorType,
    name: string,
  ): Promise<Connector | null>
  findByNameInTenant(tenantId: string, name: string): Promise<Connector[]>
  listForTenant(tenantId: string): Promise<Connector[]>
  listActive(tenantId: string): Promise<Connector[]>
  create(input: {
    tenantId: string
    type: ConnectorType
    name: string
    authMode: ConnectorAuthMode
    scope: Connector['scope']
    config?: Prisma.InputJsonValue
    /** #942 D13: csak knowledge_base; `private_to_user`-nél `ownerUserId` kötelező. */
    visibility?: Connector['visibility']
    ownerUserId?: string | null
  }): Promise<Connector>
  updateApprover(input: { connectorId: string; approverUserId: string | null }): Promise<Connector>
  /** #965: tudásbázis láthatóság-váltása és/vagy config (megjelenített név, sablon) frissítése. */
  updateKnowledgeBase(
    connectorId: string,
    input: {
      name?: string
      config?: Prisma.InputJsonValue
      visibility?: Connector['visibility']
      ownerUserId?: string | null
    },
  ): Promise<Connector>
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
    /** Monotonikus konkurencia-token a service által ellenőrzött draft-verzióhoz. */
    expectedDraftRevision: number
    secretAlias: string
    authMode: ConnectorAuthMode
    secondApproverId: string | null
    config?: Prisma.InputJsonValue
    /** `null`, ha a draft az ellenőrzés és a commit között megváltozott. */
  }): Promise<Connector | null>
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
  /**
   * Tenant-szintű Google-fiókkötés cseréje (Ads / Analytics / Search Console). Csak ezt az egy
   * config-kulcsot írja; a lifecycle-t és a felhasználói granteket nem érinti.
   */
  setGoogleAccountBinding(params: {
    draftId: string
    binding: GoogleAccountBinding
  }): Promise<ConnectorDraftWithConnector>
  reopen(params: { draftId: string }): Promise<Connector>
  decommission(params: { draftId: string }): Promise<{ connectorId: string; affectedAgentIds: string[] }>
  findConnectorById(connectorId: string): Promise<{
    id: string
    tenantId: string
    lifecycleState: string
    secretAlias: string | null
    /** #1028: a tenant-postafiók jelöléséhez (csak-olvasás kényszer). */
    authMode?: string
    config?: unknown
  } | null>
  /** Üzemi kész: aktivált + (önfrissítőnél) jóváhagyott link/bizalom + valid snapshot. */
  isAssignableToAgent(connectorId: string): Promise<boolean>
  decommissionByConnectorId(params: {
    connectorId: string
  }): Promise<{ connectorId: string; affectedAgentIds: string[] }>
  deleteDraft(params: { draftId: string; allowArchived?: boolean }): Promise<void>
  hardDeleteArchivedConnector(params: { connectorId: string }): Promise<void>
  listActiveCatalog(tenantId: string): Promise<
    Array<{
      id: string
      type: ConnectorType
      name: string
      connectorMode: 'fixed' | 'self_updating'
      templateKey?: string | null
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
    role?: UserRole | null
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

export interface ContactInquiryRepository {
  create(data: { name: string; phone: string; email: string; message: string }): Promise<ContactInquiry>
  findMany(filter?: {
    status?: ContactInquiryStatus
    limit?: number
  }): Promise<ContactInquiry[]>
  markReviewed(id: string, reviewedById: string): Promise<ContactInquiry>
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
  /** Az e-mailre szóló, még beváltható (pending, nem lejárt) meghívók — #830 D8. */
  findPendingByEmail(email: string, now: Date): Promise<Invitation[]>
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
  /** #830: a user által self-service indított, nem archivált cégek száma (cég-limit). */
  countSelfServiceByCreator(userId: string): Promise<number>
  create(data: {
    slug: string
    displayName: string
    legalName?: string | null
    taxId?: string | null
    domainAllowlist?: string[]
    settings?: Prisma.InputJsonValue
    createdById?: string | null
  }): Promise<Tenant>
  update(
    id: string,
    data: Partial<{
      displayName: string
      legalName: string | null
      taxId: string | null
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

export type KnowledgeChunkSearchHit = {
  artifactId: string
  connectorId: string
  path: string
  title: string
  type: string
  section: string | null
  text: string
  sourceRef: unknown
  /** Postgres `ts_rank` (holtverseny-bontó). */
  score: number
  /** A találatban szereplő kérdésszavak (IDF-újrarangsoroláshoz). */
  matched?: string[]
}

export type KnowledgeIndexEntry = {
  artifactId: string
  connectorId: string
  path: string
  title: string
  type: string
}

export type KnowledgePageChunk = {
  artifactId: string
  connectorId: string
  path: string
  title: string
  type: string
  section: string | null
  chunkIndex: number
  text: string
  sourceRef: unknown
}

export type DocumentListItem = Pick<
  Document,
  | 'id'
  | 'filename'
  | 'status'
  | 'processingMode'
  | 'mimeType'
  | 'createdAt'
  | 'connectorId'
  | 'kbLanguageOverride'
> & { purpose: string | null }

export type KnowledgeCatalogDocument = {
  id: string
  filename: string
  processingMode: Document['processingMode']
  metadata: Prisma.JsonValue
  chars: number
}

export type KnowledgeRawHit = {
  id: string
  filename: string
  /** A találó heading-szakasz útvonala (a `kb_get_document` `section` paramétere). */
  section?: string
  snippet: string
  score: number
  matched?: string[]
}

export interface DocumentRepository {
  create(data: {
    tenantId: string
    filename: string
    storageRef?: string | null
    extractedText?: string | null
    mimeType?: string | null
    contentHash?: string | null
    status?: DocumentStatus
    processingMode?: KnowledgeProcessingMode | null
    metadata?: Prisma.InputJsonValue
    connectorId?: string | null
    uploadedById: string
    wikiStatus?: Document['wikiStatus']
    wikiSubmittedByAgentId?: string | null
  }): Promise<Document>
  /** Atomic, connector-scoped duplicate detection; originals cascade with the Document. */
  createSource(data: Parameters<DocumentRepository['create']>[0], rawBytes?: Buffer): Promise<{ document: Document; duplicate: boolean }>
  readSource(documentId: string): Promise<Buffer | null>
  findById(id: string): Promise<Document | null>
  findByConnectorId(connectorId: string): Promise<Document[]>
  listByConnectorId(connectorId: string): Promise<DocumentListItem[]>
  listCatalog(connectorId: string): Promise<KnowledgeCatalogDocument[]>
  searchRaw(connectorId: string, query: string, limit: number): Promise<KnowledgeRawHit[]>
  update(
    id: string,
    data: {
      extractedText?: string | null
      status?: DocumentStatus
      processingMode?: KnowledgeProcessingMode | null
      metadata?: Prisma.InputJsonValue
      connectorId?: string | null
      contentHash?: string | null
      mimeType?: string | null
      /** #717: dokumentum-szintű KB-nyelv felülírás; `null` = öröklés. */
      kbLanguageOverride?: string | null
    },
  ): Promise<Document>
  delete(id: string): Promise<void>
}

export interface KnowledgeArtifactRepository {
  create(data: {
    connectorId: string
    sourceDocumentId?: string | null
    createdByAgentId?: string | null
    status?: KnowledgeArtifactStatus
    format?: KnowledgeArtifact['format']
    version: number
    contentHash: string
    bundle?: Prisma.InputJsonValue
    validationResult?: Prisma.InputJsonValue | null
    publishedAt?: Date | null
  }): Promise<KnowledgeArtifact>
  findById(id: string): Promise<KnowledgeArtifact | null>
  findByConnector(connectorId: string, status?: KnowledgeArtifactStatus): Promise<KnowledgeArtifact[]>
  publishedSourceDocumentIds(connectorIds: string[]): Promise<Set<string>>
  deleteBySourceDocumentId(documentId: string): Promise<void>
}

export interface KnowledgeChunkRepository {
  createMany(
    rows: Array<{
      artifactId: string
      connectorId: string
      path: string
      title: string
      type: string
      section: string | null
      chunkIndex: number
      text: string
      sourceRef: Prisma.InputJsonValue | null
      contentHash: string
    }>,
  ): Promise<number>
  searchChunks(connectorIds: string[], query: string, limit: number): Promise<KnowledgeChunkSearchHit[]>
  listIndex(
    connectorIds: string[],
    pathPrefix?: string,
    artifactId?: string,
  ): Promise<KnowledgeIndexEntry[]>
  getPageChunks(
    connectorIds: string[],
    path: string,
    artifactId?: string,
  ): Promise<KnowledgePageChunk[]>
  deleteByArtifact(artifactId: string): Promise<void>
}

/** #942 tálca-tétel (Document wiki-mezőiből), `status` már a lejárt foglalással korrigált. */
export type WikiInboxItem = {
  documentId: string
  connectorId: string
  filename: string
  purpose: string | null
  status: 'pending' | 'in_progress'
  uploadedById: string
  submittedByAgentId: string | null
  claimedByAgentId: string | null
  claimExpiresAt: Date | null
  batchId: string | null
  batchSeq: number | null
  createdAt: Date
}

export type WikiInboxCounts = { pending: number; inProgress: number; processed: number; skipped: number }

export type WikiInboxSummary = {
  wikis: Array<{ connectorId: string } & WikiInboxCounts>
  batches: Array<{ connectorId: string; batchId: string } & WikiInboxCounts>
}

export type WikiPageWrite = {
  path: string
  type: WikiPageType
  title: string
  summary: string
  category?: string | null
  frontmatter?: Prisma.InputJsonValue
  body: string
  sourceRefs?: Prisma.InputJsonValue
  outLinks?: string[]
  status?: WikiPageStatus
  contentHash: string
}

/** #943: egy wiki-oldal chunk-sora a wiki-konténer artifact alatt. */
export type WikiChunkRow = {
  path: string
  title: string
  type: string
  section: string | null
  chunkIndex: number
  text: string
  sourceRef: Prisma.InputJsonValue | null
  contentHash: string
}

export type WikiApplyPageOp =
  | {
      kind: 'create'
      page: WikiPageWrite
      createdByAgentId?: string | null
      createdByUserId?: string | null
      chunks: WikiChunkRow[]
    }
  | {
      kind: 'update'
      pageId: string
      /** Optimista zár: eltérésnél az egész change-set visszagörgetődik (`conflict`). */
      expectedVersion: number
      previousPath: string
      page: WikiPageWrite
      updatedByAgentId?: string | null
      chunks: WikiChunkRow[]
    }

/** #978: egy oldal változása egy alkalmazott change-setben (a diff nélkül, a megőrzés után is megmarad). */
export type WikiPageChangeAction = 'created' | 'updated' | 'archived' | 'moved' | 'restored'

export type WikiChangeSetPageSummary = {
  pageId: string
  path: string
  fromPath?: string | null
  action: WikiPageChangeAction
  title: string
  linesAdded: number
  linesRemoved: number
  /** Az oldal verziója az alkalmazás után. */
  version: number
}

export type WikiApplyChangeSetInput = {
  /** Meglévő (jóváhagyott, `pending`) change-set, vagy közvetlen módban egy új. */
  changeSet: { id: string } | { create: Omit<Parameters<WikiRepository['createChangeSet']>[0], 'status'> }
  wikiId: string
  connectorId: string
  ops: WikiApplyPageOp[]
  log: {
    op: WikiLogOp
    title: string
    note?: string | null
    pagePaths: string[]
    actorAgentId?: string | null
    actorUserId?: string | null
  }
  /** Tálca-tétel lezárása (`final`) vagy a foglalás megújítása, ugyanabban a tranzakcióban. */
  inbox?: { documentId: string; final: boolean; agentId: string; claimExpiresAt: Date } | null
  /** #978 §6: az `ops`-szal azonos sorrendű összefoglaló (a `pageId`/`version` a repó tölti). */
  pageSummary?: Array<Omit<WikiChangeSetPageSummary, 'pageId' | 'version'>>
  appliedAt: Date
}

export type WikiApplyChangeSetResult =
  | { ok: true; changeSetId: string; seq: number; pages: WikiPage[] }
  | { ok: false; reason: 'conflict'; path: string | null }
  | { ok: false; reason: 'changeset_not_pending' }
  /** #978 D5: a visszavonandó change-set már nem `applied` (pl. közben visszavonták). */
  | { ok: false; reason: 'changeset_not_revertible' }

export interface WikiRepository {
  findById(wikiId: string): Promise<AgentWiki | null>
  findByConnectorId(connectorId: string): Promise<AgentWiki | null>
  /** Idempotens: meglévőt ad vissza, a sémát nem írja felül. */
  ensureForConnector(input: { connectorId: string; schemaMd: string }): Promise<AgentWiki>
  updateSchema(wikiId: string, schemaMd: string): Promise<AgentWiki>
  updateLastLint(wikiId: string, lastLint: Prisma.InputJsonValue): Promise<void>

  findPage(connectorId: string, path: string): Promise<WikiPage | null>
  listPages(
    connectorId: string,
    filter?: { status?: WikiPageStatus | WikiPageStatus[]; pathPrefix?: string; category?: string; limit?: number },
  ): Promise<WikiPage[]>
  createPage(
    input: WikiPageWrite & {
      wikiId: string
      connectorId: string
      createdByAgentId?: string | null
      createdByUserId?: string | null
      changeSetId?: string | null
    },
  ): Promise<WikiPage>
  /** Optimista zár: `expectedVersion` ≠ aktuális → `null` (D-konfliktus, csendes felülírás nincs). */
  updatePage(
    pageId: string,
    expectedVersion: number,
    input: Partial<WikiPageWrite> & { contentHash: string; updatedByAgentId?: string | null; changeSetId?: string | null },
  ): Promise<WikiPage | null>
  listRevisions(pageId: string): Promise<WikiPageRevision[]>

  createChangeSet(input: {
    wikiId: string
    connectorId: string
    agentId?: string | null
    userId?: string | null
    status?: WikiChangeSetStatus
    pages: Prisma.InputJsonValue
    validation?: Prisma.InputJsonValue | null
    logEntry?: Prisma.InputJsonValue | null
    sourceDocumentIds?: string[]
    inboxItemId?: string | null
    approverScope: Prisma.InputJsonValue
    /** #978 D5: visszaállító change-set — ezt vonja vissza. */
    revertsId?: string | null
  }): Promise<WikiChangeSet>
  findChangeSet(id: string): Promise<WikiChangeSet | null>
  /** #965: a tudásbázis függő change-setjei (láthatóság-váltáskor elutasítjuk őket). */
  listPendingChangeSetIds(connectorId: string): Promise<string[]>
  /** CAS: csak `from` állapotból vált; különben `null`. */
  transitionChangeSet(
    id: string,
    from: WikiChangeSetStatus,
    to: WikiChangeSetStatus,
    extra?: { gatewayOperationId?: string | null; appliedAt?: Date | null },
  ): Promise<WikiChangeSet | null>

  appendLog(input: {
    wikiId: string
    op: WikiLogOp
    title: string
    note?: string | null
    pagePaths?: string[]
    changeSetId?: string | null
    actorAgentId?: string | null
    actorUserId?: string | null
  }): Promise<WikiLogEntry>
  listLog(wikiId: string, limit?: number): Promise<WikiLogEntry[]>

  /** Tálca: `pending` + `in_progress` (lejárt foglalás = `pending`), köteg, majd sorszám szerint. */
  listInbox(
    connectorIds: string[],
    input: { now: Date; batchId?: string; limit?: number },
  ): Promise<WikiInboxItem[]>
  inboxSummary(connectorIds: string[], input: { now: Date; batchId?: string }): Promise<WikiInboxSummary>
  /** Beküldés: a dokumentum tálca-tétellé válik (`pending`, vagy azonnali feldolgozásnál `in_progress`). */
  submitToInbox(input: {
    documentId: string
    status: Extract<WikiInboxStatus, 'pending' | 'in_progress'>
    submittedByAgentId?: string | null
    claimedByAgentId?: string | null
    claimExpiresAt?: Date | null
    batchId?: string | null
    batchSeq?: number | null
  }): Promise<void>
  /**
   * Foglalás CAS-sal: `pending`, lejárt `in_progress`, vagy a saját foglalás
   * megújítása. Másik agent élő foglalásánál `false`.
   */
  claimInboxItem(input: {
    documentId: string
    connectorId: string
    agentId: string
    now: Date
    expiresAt: Date
  }): Promise<boolean>
  releaseInboxItem(input: { documentId: string; agentId: string }): Promise<boolean>
  /** D16: agent törlésekor / jogvesztéskor a nevére foglalt tételek azonnal vissza a tálcára. */
  releaseClaimsForAgent(input: { agentId: string; connectorIds?: string[] }): Promise<number>
  markInboxProcessed(input: { documentId: string; changeSetId: string }): Promise<boolean>
  skipInboxItem(input: { documentId: string; connectorId: string }): Promise<boolean>
  findDocumentByContentHash(connectorId: string, contentHash: string): Promise<{ id: string } | null>
  /**
   * #943: a teljes change-set egy tranzakcióban — oldalak + revíziók, az érintett
   * oldalak chunkjai a wiki-konténer (`format: llm_wiki`) alatt, napló, tálca-tétel.
   * Bármely verzió-ütközés az egészet visszagörgeti.
   */
  applyChangeSet(input: WikiApplyChangeSetInput): Promise<WikiApplyChangeSetResult>
  /** Elutasított change-setnél a lezárt tálca-tétel vissza `pending`-be. */
  reopenInboxItem(input: { documentId: string; changeSetId: string }): Promise<boolean>
  /** A wiki-konténer artifact (keresési találatok jelöléséhez); még nincs → `null`. */
  findContainerArtifactId(connectorId: string): Promise<string | null>
}

/** #978: egy oldal állapota egy korábbi sorszámon (időutazás). */
export type WikiStateRow = WikiPageRevision & { seq: number | null }

export type WikiRetentionCounts = { thinned: number; deleted: number; changeSetsPruned: number }

export type WikiErasureWrite = {
  wikiId: string
  connectorId: string
  requestedBy: string
  reason: string
  scope: Prisma.InputJsonValue
  appliedAt: Date
  /** Teljes sír-jel (D9): üres tartalom, `erasedAt`/`erasureId`, a `contentHash` marad. */
  tombstoneRevisionIds: string[]
  /** Sír-jelnél az útvonal is cserélődhet (oldal-mód: az útvonal maga is személyes adat lehet). */
  tombstonePaths?: Record<string, string>
  /** Kitakarás: a revízió szövege cserélődik, új `contentHash`-sel. */
  redactRevisions: Array<{ id: string; title: string; summary: string; body: string; category: string | null; sourceRefs: Prisma.InputJsonValue; frontmatter: Prisma.InputJsonValue; contentHash: string; path?: string | null }>
  /** Az aktuális oldalak új verziója egy szintetikus change-setben (op = note). */
  pageWrites: Array<{
    pageId: string
    expectedVersion: number
    previousPath: string
    page: WikiPageWrite
    chunks: WikiChunkRow[]
  }>
  pageSummary: Array<Omit<WikiChangeSetPageSummary, 'pageId' | 'version'>>
  log: { title: string; note: string | null; actorUserId: string }
  changeSets: Array<{
    id: string
    pages?: Prisma.InputJsonValue
    pageSummary?: Prisma.InputJsonValue
    logEntry?: Prisma.InputJsonValue
    validation?: Prisma.InputJsonValue
    reject?: boolean
  }>
  logEntries: Array<{ id: string; title: string; note: string | null; pagePaths: string[] }>
  documents: { redact: Array<{ id: string; filename: string; extractedText: string | null }>; delete: string[] }
  /** Kifejezés-módban a keresési index szövegeinek kitakarása (PG regex, kis-nagybetű független). */
  chunkPattern: string | null
  gatewayOperations: Array<{ id: string; argsJson: Prisma.InputJsonValue; reject?: boolean }>
  erasedHashes: string[]
}

/**
 * #978 Wiki-előzmények: olvasás (idővonal, change-set, időutazás), címkék,
 * agent-cursor, megőrzés és GDPR-törlés. Minden lekérdezés a wiki / connector
 * azonosítójára szűr (D-B), a sorszám és a revízió-id önmagában nem elég.
 */
export interface WikiHistoryRepository {
  listChangeSets(
    wikiId: string,
    filter: {
      afterSeq?: number
      beforeSeq?: number
      agentId?: string
      userId?: string
      from?: Date
      to?: Date
      limit: number
      order: 'asc' | 'desc'
    },
  ): Promise<WikiChangeSet[]>
  findChangeSetBySeq(wikiId: string, seq: number): Promise<WikiChangeSet | null>
  findChangeSetInWiki(wikiId: string, changeSetId: string): Promise<WikiChangeSet | null>
  /** A legnagyobb sorszám, amely `at` előtt (vagy pontosan akkor) alkalmazódott; 0 = még semmi. */
  seqAt(wikiId: string, at: Date): Promise<number>
  latestSeq(wikiId: string): Promise<number>
  appliedAtForSeq(wikiId: string, seq: number): Promise<Date | null>
  revisionsForChangeSet(changeSetId: string): Promise<WikiPageRevision[]>
  findRevision(connectorId: string, pageId: string, version: number): Promise<WikiPageRevision | null>
  /** A megadott verzió előtti, még megőrzött legutóbbi revízió. */
  previousRevision(connectorId: string, pageId: string, version: number): Promise<WikiPageRevision | null>
  /** Oldal a connectoron belül (id szerint). */
  findPageById(connectorId: string, pageId: string): Promise<WikiPage | null>
  listRevisions(connectorId: string, pageId: string): Promise<Array<WikiPageRevision & { seq: number | null; changeSetLogTitle: string | null }>>
  /** Oldalanként a legutóbbi revízió, amelynek change-setje `seq ≤ S`. */
  stateAt(wikiId: string, connectorId: string, seq: number): Promise<WikiStateRow[]>

  getCursor(wikiId: string, agentId: string, userId: string): Promise<number | null>
  /** Csak előre lép (GREATEST). */
  advanceCursor(wikiId: string, agentId: string, userId: string, seq: number): Promise<void>

  listTags(wikiId: string): Promise<WikiTag[]>
  createTag(input: { wikiId: string; name: string; note: string | null; seq: number; createdByUserId: string }): Promise<WikiTag | null>
  deleteTag(wikiId: string, tagId: string): Promise<WikiTag | null>

  updateRetention(wikiId: string, input: { retentionFullDays: number; retentionDeleteDays: number | null }): Promise<AgentWiki>
  listWikisForRetention(input: { afterId?: string; limit: number }): Promise<Array<Pick<AgentWiki, 'id' | 'connectorId' | 'retentionFullDays' | 'retentionDeleteDays'>>>
  /** Napi ritkítás + törlés + change-set tartalom kiürítése (§6), kötegelve. */
  sweepRetention(input: {
    wikiId: string
    fullBefore: Date
    deleteBefore: Date | null
    keepLatest: number
    limit: number
    now: Date
  }): Promise<WikiRetentionCounts>

  /** GDPR §7 előnézet: kifejezés-találatok helyenként (tartalommal, csak a hívónak). */
  findTextMatches(wikiId: string, connectorId: string, phrase: string): Promise<{
    pages: WikiPage[]
    revisions: WikiPageRevision[]
    changeSets: WikiChangeSet[]
    logEntries: WikiLogEntry[]
    documents: Array<{ id: string; filename: string; extractedText: string | null; hasSourceFile: boolean }>
    chunks: number
    gatewayOperations: Array<{ id: string; argsJson: Prisma.JsonValue }>
  }>
  listPageChangeSets(wikiId: string, pageIds: string[], paths: string[]): Promise<WikiChangeSet[]>
  listSourceDocuments(connectorId: string, documentIds: string[]): Promise<Array<{ id: string; filename: string; hasSourceFile: boolean }>>
  listLogEntriesForPaths(wikiId: string, paths: string[]): Promise<WikiLogEntry[]>
  listPendingGatewayOperations(connectorId: string): Promise<Array<{ id: string; argsJson: Prisma.JsonValue }>>
  executeErasure(input: WikiErasureWrite): Promise<
    | { ok: true; erasureId: string; changeSetId: string | null; seq: number | null; counts: Record<string, number> }
    | { ok: false; reason: 'conflict' }
  >
}

export type PrivateKnowledgeBaseRow = {
  connectorId: string
  tenantId: string
  ownerUserId: string
}

export type PrivateKnowledgeBasePurgeCounts = {
  documents: number
  pages: number
  revisions: number
  chunks: number
  artifacts: number
  changeSets: number
  logEntries: number
  gatewayOperations: number
  agentLinks: number
}

export interface PrivateKnowledgeBaseStore {
  findPrivate(connectorId: string): Promise<PrivateKnowledgeBaseRow | null>
  listPrivateForOwner(tenantId: string, ownerUserId: string): Promise<PrivateKnowledgeBaseRow[]>
  /**
   * D16: privát KB-k, amelyek tulajdonosa már nem aktív tag (felfüggesztve vagy
   * törölve), és ez `olderThan` előtt történt. Aktív tag KB-ja sosem jelölt.
   */
  listOrphaned(input: { olderThan: Date; now: Date }): Promise<PrivateKnowledgeBaseRow[]>
  /** Végleges törlés egy tranzakcióban: nyers források, oldalak, revíziók, chunkok, change-setek, tálca, connector. */
  purge(connectorId: string): Promise<PrivateKnowledgeBasePurgeCounts>
  purge(connectorId: string, input: { olderThan: Date }): Promise<PrivateKnowledgeBasePurgeCounts | null>
}

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
