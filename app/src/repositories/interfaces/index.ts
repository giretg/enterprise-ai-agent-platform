import type {
  Agent,
  AgentAccessGrant,
  AgentAccessSubjectType,
  AgentTurn,
  AgentTurnStatus,
  AuditActorType,
  ChannelBot,
  ChannelBotStatus,
  ChannelType,
  ChannelIdentity,
  ChannelIdentityStatus,
  ChannelAgentGrant,
  ChannelSession,
  ChannelTurn,
  ChannelLinkToken,
  ChannelOutboundMessage,
  ChannelApprovalPrompt,
  UserNotification,
  AuditLog,
  Connector,
  ConnectorAccessMode,
  ConnectorAuthMode,
  ConnectorDraft,
  ConnectorDraftReviewStatus,
  ConnectorDraftSourceType,
  ConnectorLifecycleState,
  ConnectorTemplate,
  ConnectorTemplateOrigin,
  ConnectorTemplateStatus,
  ConnectorType,
  Conversation,
  Document,
  KnowledgeArtifact,
  KnowledgeArtifactStatus,
  KnowledgeChunk,
  MemoryChunk,
  MemoryCandidate,
  MemoryVersion,
  ConsequenceApproval,
  ConsequenceApprovalStatus,
  Message,
  MessageCriticality,
  MessageRole,
  ModelBudget,
  ModelBudgetPeriod,
  ModelBudgetScope,
  ModelCall,
  ModelRoutingPolicy,
  ModelRoutingScope,
  MonitorCatchupPolicy,
  MonitorDefinition,
  MonitorKind,
  MonitorRun,
  MonitorRunOutcome,
  MonitorSignal,
  MonitorStatus,
  Prisma,
  Recipe,
  RecipeScope,
  RecipeTicketType,
  RecipeVersion,
  Skill,
  SkillVersion,
  AgentSkill,
  SkillCatalogScope,
  SkillSourceType,
  SkillRiskTier,
  SandboxApp,
  SandboxAppCriticality,
  SandboxAppStatus,
  SandboxAppVersion,
  SandboxCreatedByType,
  SandboxProject,
  SandboxCommit,
  SandboxCommitSource,
  SandboxPromotion,
  SandboxPromotionStatus,
  SandboxDataSnapshot,
  SandboxSnapshotKind,
  SandboxSnapshotStatus,
  SandboxExport,
  SandboxExportScope,
  SandboxExportStatus,
  SandboxEnv,
  SandboxActorType,
  ScheduledTask,
  ScheduledTaskKind,
  ScheduledTaskRecurrence,
  ScheduledTaskStatus,
  Playbook,
  PlaybookVersion,
  PlaybookV2,
  PlaybookV2Status,
  PlaybookVersionV2,
  PlaybookVersionV2Status,
  PlaybookAssignment,
  ProcessInstance,
  ProcessStatus,
  ProcessStepInstance,
  ProcessStepStatus,
  ProcessDefinition,
  ProcessDefinitionStatus,
  ProcessTrigger,
  ProcessTriggerType,
  DelegationEdge,
  DelegationStatus,
  ProcessActorType,
  ToolCall,
  Ticket,
  TicketComment,
  TicketCommentAttachment,
  TicketCommentAttachmentKind,
  TicketCommentKind,
  TicketSource,
  TicketState,
  TicketTransition,
  RetentionPolicy,
  User,
  UserRole,
  UserStatus,
  Invitation,
  InvitationStatus,
  RolePermission,
  Tenant,
  TenantStatus,
  TenantMembership,
  TenantMembershipStatus,
  PlatformMembership,
  PlatformRole,
  PlatformMembershipStatus,
} from '@prisma/client'

export type TicketFilter = {
  tenantId?: string | null
  state?: TicketState | TicketState[]
  type?: Ticket['type']
  agentId?: string
  processInstanceId?: string
  source?: TicketSource | TicketSource[]
  /** Board / dashboard: user + system ticketek, teszt kizárva. */
  excludeTest?: boolean
  /** Ha megadott: csak a felhasználó által létrehozott ticketek. */
  createdById?: string
  /**
   * Futások panel: a user által létrehozott VAGY human assignee-ként rá
   * szignált ticketek (`createdById` / `assigneeType=human`+`assigneeId`).
   */
  belongingToUserId?: string
  /** updatedAt alsó határ (inklúzív). */
  updatedAtGte?: Date
  /** updatedAt felső határ (inklúzív). */
  updatedAtLte?: Date
  /** Ha megadott: take+1 pagináció. Üresen korlátlan (full dump / internal). */
  limit?: number
  offset?: number
  unbounded?: boolean
}

export type ListPageResult<T> = {
  items: T[]
  hasMore: boolean
  nextOffset?: number
}

export interface TicketRepository {
  findMany(filter?: TicketFilter): Promise<Ticket[]>
  /** Control-plane listák: alapból limitált; full dump: `unbounded: true`. */
  listPage(filter?: TicketFilter): Promise<ListPageResult<Ticket>>
  count(filter?: TicketFilter): Promise<number>
  findReadyForDispatch(now: Date, limit: number): Promise<Ticket[]>
  findStaleInProgressDispatches(cutoff: Date, limit: number): Promise<Ticket[]>
  /** Megválaszolt, de a beszélgetésben még nem megjelenített delegációk. */
  listReturnedDelegationsForConversation(conversationId: string): Promise<Ticket[]>
  /** Idempotens jelölés: a delegált válasz megjelent a felhasználó előtt. */
  markDelegationSurfaced(ticketId: string): Promise<void>
  findById(id: string): Promise<Ticket | null>
  create(
    data: Omit<
      Ticket,
      | 'id'
      | 'createdAt'
      | 'updatedAt'
      | 'tenantId'
      | 'lockToken'
      | 'lockedAt'
      | 'playbookRef'
      | 'conversationId'
      | 'source'
      | 'processInstanceId'
      | 'playbookVersionId'
      | 'playbookStepId'
      | 'requiredGateId'
      | 'cancelRequested'
      | 'cancelRequestedById'
      | 'cancelRequestedAt'
    > &
      Partial<
        Pick<
          Ticket,
          | 'tenantId'
          | 'lockToken'
          | 'lockedAt'
          | 'playbookRef'
          | 'conversationId'
          | 'source'
          | 'processInstanceId'
          | 'playbookVersionId'
          | 'playbookStepId'
          | 'requiredGateId'
          | 'cancelRequested'
          | 'cancelRequestedById'
          | 'cancelRequestedAt'
        >
      > & {
        /** A tickettel egy tranzakcióban létrehozott első komment és csatolmányai. */
        initialComment?: Omit<AppendTicketCommentInput, 'ticketId'>
      },
    options?: { attachments?: CreateTicketAttachmentInput[] },
  ): Promise<Ticket>
  update(
    id: string,
    data: Partial<
      Pick<
        Ticket,
        | 'state'
        | 'payload'
        | 'assigneeType'
        | 'assigneeId'
        | 'agentId'
        | 'lockToken'
        | 'lockedAt'
        | 'playbookRef'
        | 'conversationId'
        | 'processInstanceId'
        | 'playbookVersionId'
        | 'playbookStepId'
        | 'requiredGateId'
        | 'cancelRequested'
        | 'cancelRequestedById'
        | 'cancelRequestedAt'
      >
    >,
  ): Promise<Ticket>
  /**
   * Atomi állapot-összehasonlítás és frissítés. A state machine ezt használja, hogy két
   * egyidejű jóváhagyás közül csak az egyik vihesse végig ugyanazt az átmenetet.
   * `null` = a ticket állapota időközben megváltozott.
   */
  updateIfCurrentState(
    id: string,
    currentState: TicketState,
    data: Partial<
      Pick<
        Ticket,
        | 'state'
        | 'payload'
        | 'assigneeType'
        | 'assigneeId'
        | 'agentId'
        | 'lockToken'
        | 'lockedAt'
        | 'playbookRef'
        | 'conversationId'
        | 'processInstanceId'
        | 'playbookVersionId'
        | 'playbookStepId'
        | 'requiredGateId'
        | 'cancelRequested'
        | 'cancelRequestedById'
        | 'cancelRequestedAt'
      >
    >,
  ): Promise<Ticket | null>
  /** Explicit Stop: cancelRequested flag in_progress ticketen. */
  requestCancel(id: string, byUserId: string, now?: Date): Promise<Ticket | null>
  isCancelRequested(id: string): Promise<boolean>
  acquireDispatchLock(id: string, lockToken: string, now: Date): Promise<Ticket | null>
  releaseDispatchLock(id: string, lockToken: string): Promise<void>
  completeDispatchLock(id: string, lockToken: string): Promise<Ticket | null>
  recordTransition(data: Omit<TicketTransition, 'id' | 'ts'>): Promise<TicketTransition>
  findTransitions(ticketId: string): Promise<TicketTransition[]>
  appendComment(data: AppendTicketCommentInput): Promise<TicketCommentWithAttachments>
  listComments(ticketId: string): Promise<TicketCommentWithAttachments[]>
  /** Transition statistics for the governance dashboard (§11: kontroll — jóváhagyott vs. automatikus lépések, visszadobási arány). */
  getTransitionStats(since?: Date): Promise<TransitionStats>
  /** Csak backlog/ready, lock nélkül — a kapcsolódó sorokat is takarítja. `force` esetén admin: bármilyen állapot. */
  deleteTicket(id: string, options?: { force?: boolean }): Promise<void>
}

export type CreateTicketAttachmentInput = {
  documentId: string
  filename: string
  mimeType?: string | null
  byteSize?: number | null
}

export type TicketCommentWithAttachments = TicketComment & {
  attachments: Array<TicketCommentAttachment & { document: Document }>
}

export type AppendTicketCommentAttachmentInput = {
  documentId: string
  kind: TicketCommentAttachmentKind
  filename: string
  mimeType?: string | null
  byteSize?: number | null
}

export type AppendTicketCommentInput = {
  ticketId: string
  kind: TicketCommentKind
  authorType: AuditActorType
  authorUserId?: string | null
  authorAgentId?: string | null
  authorDisplayName?: string | null
  agentVersion?: number | null
  body: string
  structured?: Prisma.InputJsonValue | null
  parentId?: string | null
  transitionId?: string | null
  attachments?: AppendTicketCommentAttachmentInput[]
}

export interface ScheduledTaskRepository {
  findMany(filter?: {
    tenantId?: string | null
    agentId?: string
    limit?: number
  }): Promise<ScheduledTask[]>
  findDue(now: Date, limit: number): Promise<ScheduledTask[]>
  create(data: {
    tenantId: string | null
    kind?: ScheduledTaskKind
    title: string
    agentId: string
    createdById: string
    payload: Prisma.InputJsonValue
    runAsUserId?: string | null
    runAsAuthorizedAt?: Date | null
    runAsAuthorizedById?: string | null
    nextRunAt: Date
    recurrence?: ScheduledTaskRecurrence
    maxRuns?: number | null
  }): Promise<ScheduledTask>
  claimDue(id: string, now: Date): Promise<ScheduledTask | null>
  /**
   * Atomikusan létrehozza a materializált ticketet és lezárja (vagy újraütemezi)
   * a már claimelt scheduled taskot. Egy worker-leállás nem hagyhat maga után
   * ticketet a task állapotváltozása nélkül, mert az ismételt reclaim duplikált
   * autonóm futást indítana.
   */
  materializeTicket(
    id: string,
    ticket: Pick<
      Ticket,
      | 'tenantId'
      | 'type'
      | 'title'
      | 'state'
      | 'assigneeType'
      | 'assigneeId'
      | 'agentId'
      | 'sourceDocumentId'
      | 'conversationId'
      | 'executeAfter'
      | 'dueBy'
      | 'createdById'
      | 'source'
    > & { payload: Prisma.InputJsonValue },
    data: {
      status: ScheduledTaskStatus
      runCount: number
      lastRunAt: Date
      materializedAt: Date
      nextRunAt: Date
    },
  ): Promise<{ scheduledTask: ScheduledTask; ticket: Ticket } | null>
  revoke(id: string): Promise<ScheduledTask | null>
  findById(id: string): Promise<ScheduledTask | null>
  findStaleMaterializing(cutoff: Date, limit: number): Promise<ScheduledTask[]>
  reclaimMaterializing(id: string): Promise<ScheduledTask | null>
}

export type CreateMonitorInput = {
  tenantId: string
  kind: MonitorKind
  title: string
  description?: string | null
  intervalSeconds: number
  nextSweepAt: Date
  catchupPolicy?: MonitorCatchupPolicy
  catchupWindowSec?: number
  collectorConfig?: Prisma.InputJsonValue
  filterConfig?: Prisma.InputJsonValue
  cooldownSeconds?: number
  dedupKeyTemplate?: string | null
  openTicketType?: Ticket['type']
  escalateAgentId?: string | null
  perRunBudgetUsd?: number | null
  notifyChannel?: string | null
  createdById: string
}

export type UpcomingTicketDeadline = {
  ticketId: string
  tenantId: string | null
  title: string
  dueBy: Date
  state: TicketState
}

export type StaleBacklogTicket = {
  ticketId: string
  tenantId: string | null
  title: string
  state: TicketState
  updatedAt: Date
  dueBy: Date | null
}

export type UpdateMonitorInput = Partial<{
  title: string
  description: string | null
  status: MonitorStatus
  intervalSeconds: number
  collectorConfig: Prisma.InputJsonValue
  filterConfig: Prisma.InputJsonValue
  cooldownSeconds: number
  dedupKeyTemplate: string | null
  escalateAgentId: string | null
  perRunBudgetUsd: number | null
  notifyChannel: string | null
}>

export type MonitorSignalUpsert = {
  severity: number
  payload: Prisma.InputJsonValue
  now: Date
}

export type MonitorRunUpdate = {
  outcome: MonitorRunOutcome
  finishedAt: Date
  signalCount: number
  matchedCount: number
  suppressedCount: number
  openedTicketIds: string[]
  llmInvoked: boolean
  costUsd?: number | null
  error?: string | null
}

export interface MonitorRepository {
  findMany(filter?: { tenantId?: string; status?: MonitorStatus; limit?: number }): Promise<
    MonitorDefinition[]
  >
  findById(id: string): Promise<MonitorDefinition | null>
  findDue(now: Date, limit: number): Promise<MonitorDefinition[]>
  create(data: CreateMonitorInput): Promise<MonitorDefinition>
  update(id: string, data: UpdateMonitorInput): Promise<MonitorDefinition>
  revoke(id: string): Promise<MonitorDefinition>
  /** Lock-alapú claim (dupla-fire védelem §4.11.7): csak ha aktív, esedékes és nincs lockolva. */
  claim(id: string, lockToken: string, now: Date): Promise<MonitorDefinition | null>
  /** Lock felszabadítása + következő söprés időpont beállítása. */
  release(id: string, lockToken: string, data: { nextSweepAt: Date; lastSweepAt: Date }): Promise<void>
  /** Idempotens run-létrehozás; ha a (monitorId, scheduledFor) páros már fut(ott), null. */
  createRun(monitorId: string, scheduledFor: Date): Promise<MonitorRun | null>
  updateRun(id: string, data: MonitorRunUpdate): Promise<MonitorRun>
  /** Cooldown / dedup nyilvántartás upsert. */
  upsertSignal(monitorId: string, dedupKey: string, data: MonitorSignalUpsert): Promise<MonitorSignal>
  markSignalEscalated(id: string, ticketId: string | null, now: Date): Promise<void>
  findStaleLocked(cutoff: Date, limit: number): Promise<MonitorDefinition[]>
  releaseLock(id: string): Promise<void>
  /** Collector-támogatás: a board azon ticketei, amelyek due_by-ja az ablakon belül esedékes. */
  collectUpcomingTicketDeadlines(
    tenantId: string,
    now: Date,
    withinSeconds: number,
    limit: number,
  ): Promise<UpcomingTicketDeadline[]>
  /** Collector-támogatás: elakadt (awaiting_human / ready) ticketek. */
  collectStaleBacklogTickets(
    tenantId: string,
    updatedBefore: Date,
    limit: number,
  ): Promise<StaleBacklogTicket[]>
  /** Futásnapló lekérdezés. */
  findRuns(monitorId: string, limit: number): Promise<MonitorRun[]>
  /** Cooldown / dedup jelek lekérdezése egy monitorra. */
  findSignalsByMonitor(monitorId: string, limit: number): Promise<MonitorSignal[]>
}

export type TransitionStats = {
  total: number
  byActor: { human: number; agent: number; system: number }
  toApproved: number
  toRejected: number
  toDone: number
}

/** Futásidejű útvonalak (chat, task, kb_search): agent + aktuális memória, overfetch nélkül. */
export type AgentRuntimeDetails = {
  agent: Agent
  memoryContent: string | null
  memoryVersion: number | null
}

/** UI / katalógus: recipe, resources, apiKeyPreview, viselkedés-profil link. */
export type AgentDisplayDetails = AgentRuntimeDetails & {
  recipe: { name: string; ticketType: string; version: number; status: string } | null
  resources: { id: string; name: string; type: string; scope: string; version: number; accessMode: string }[]
  apiKeyPreview: string | null
  behaviorProfileLink: {
    id: string
    name: string
    currentVersion: number
    pinnedVersion: number | null
    pinnedBody: string
  } | null
}

export type AgentListFilter = {
  tenantId?: string | null
  /** Ha true, kihagyja a `hiddenFromOperators` agenteket (non-admin listázás). */
  excludeHiddenFromOperators?: boolean
  /**
   * Szűkítés egy előre kiszámolt azonosító-halmazra (#142): az agent-hozzáférési
   * gráf ENGEDÉLYEZETT céljai. Azért a DB-ben szűrünk, hogy a lapozás a szűrt
   * halmazon fusson — különben egy oldal „lyukas" lenne (a gráf utólag kivenne
   * belőle elemeket), vagy a teljes tenant-listát kellene memóriába húzni.
   * Üres tömb = nincs találat (fail-closed), nem „nincs szűrés".
   */
  ids?: string[]
  limit?: number
  offset?: number
  unbounded?: boolean
}

export interface AgentRepository {
  findMany(filter?: AgentListFilter): Promise<Agent[]>
  listPage(filter?: AgentListFilter): Promise<ListPageResult<Agent>>
  count(filter?: {
    tenantId?: string | null
    status?: Agent['status']
    excludeHiddenFromOperators?: boolean
  }): Promise<number>
  findById(id: string, tenantId?: string | null): Promise<Agent | null>
  /**
   * Futásidejű loader: csak az agent + aktuális memória tartalom/verzió.
   * Nem tölti a `memory.versions` listát, apiKeys-t, resources-t, recipe-t.
   */
  findByIdForRuntime(id: string, tenantId?: string | null): Promise<AgentRuntimeDetails | null>
  /**
   * UI detail / katalógus loader: recipe, resources, apiKeyPreview, behavior profile.
   */
  findByIdForDisplay(id: string, tenantId?: string | null): Promise<AgentDisplayDetails | null>
  /** @deprecated Használd `findByIdForDisplay`-t; kompat alias. */
  findByIdWithDetails(id: string, tenantId?: string | null): Promise<AgentDisplayDetails | null>
  findVersionSnapshot(
    agentId: string,
    version: number,
  ): Promise<{
    agentVersion: number
    roleInstruction: string
    behaviorProfile: string
    roleInstructionVersion: number
    behaviorProfileVersion: number
    memoryVersion: number | null
    model: unknown
    recipe: { name: string; version: number; status: string } | null
  } | null>
  create(input: {
    name: string
    roleInstruction: string
    behaviorProfile: string
    modelConfig: Agent['modelConfig']
    role?: Agent['role']
    selfEvolutionProfile?: Agent['selfEvolutionProfile']
    initialMemory?: string
    createdById: string
    tenantId?: string | null
    status?: Agent['status']
  }): Promise<{ agent: Agent; apiKey: string }>
  /** Életciklus-átmenetek (§4) — állapotgép-invariánsokat kényszerítenek ki. */
  activate(agentId: string): Promise<{ agent: Agent; agentVersion: number }>
  suspend(agentId: string, reason: string): Promise<Agent>
  resume(agentId: string): Promise<Agent>
  retire(agentId: string): Promise<Agent>
  /** Megosztott viselkedés-profil-frissítés befogadása (§3.4 kaszkád, I7). */
  acceptBehaviorProfileUpdate(input: {
    agentId: string
    profileId: string
    profileVersion: number
    profileBody: string
  }): Promise<{ agentVersion: number; behaviorProfileVersion: number }>
  /**
   * A ténylegesen használt viselkedés-profil beállítása (§3.4): egy megosztott
   * profil (vagy `null`) kiválasztása + az agent egyedi overlay-e. A kettőből
   * komponálja az effektív "hogyan" szöveget, pinneli a profil al-verzióját, és —
   * aktív agentnél — új `agent_versions` snapshotot fagyaszt. Draft agentnél csak
   * az élő mezőket állítja (az első snapshotot az aktiválás fagyasztja, §4/I2).
   */
  setBehaviorProfile(input: {
    agentId: string
    profileId: string | null
    profileVersion: number | null
    profileBody: string | null
    overlay: string | null
  }): Promise<{ agentVersion: number; behaviorProfileVersion: number }>
  /**
   * Frissíti a szerep-instrukciót és/vagy a viselkedés-profilt (§5.3). Csak a
   * ténylegesen változó összetevő al-verzióját lépteti, új `agent_versions`
   * snapshotot fagyaszt (mindkét szöveg + modell + memória + recipe), és lépteti
   * az agent `currentVersion`-jét. Legalább az egyik mező kötelező és változnia kell.
   */
  updateInstruction(input: {
    agentId: string
    roleInstruction?: string
    behaviorProfile?: string
  }): Promise<{
    agentVersion: number
    roleInstructionVersion: number
    behaviorProfileVersion: number
    roleChanged: boolean
    behaviorChanged: boolean
  }>
  /**
   * Frissíti az agent modell-konfigurációját (provider/model/temperature/maxTokens).
   * Új `agent_versions` snapshotot fagyaszt (a szerep/viselkedés/memória/recipe
   * öröklődik), és lépteti az agent `currentVersion`-jét — a reprodukálhatóságért.
   */
  updateModelConfig(input: {
    agentId: string
    modelConfig: Agent['modelConfig']
  }): Promise<{ agentVersion: number }>
  /**
   * Frissíti az agent emberi arcát (megjelenített név / üdvözlő mondat /
   * jellemvonás). Nem verziózott, a reprodukálhatóságot nem érinti — csak a
   * megjelenített persona. Üres string törli az override-ot (a névből számított
   * alapértelmezésre esik vissza).
   */
  updatePersona(input: {
    agentId: string
    personaNickname?: string | null
    personaGreeting?: string | null
    personaTrait?: string | null
  }): Promise<Agent>
  /**
   * Beállítja vagy törli (null) az agent feltöltött avatár-képét (data URL vagy
   * külső URL). Nem verziózott — csak a megjelenített arc.
   */
  updateAvatar(input: { agentId: string; avatarUrl: string | null }): Promise<Agent>
  updateSelfEvolutionProfile(input: {
    agentId: string
    profile: Agent['selfEvolutionProfile']
  }): Promise<Agent>
  rotateApiKey(agentId: string): Promise<{ keyId: string; apiKey: string; scopes: string[] }>
  issueEphemeralKey(
    agentId: string,
    opts?: { ttlMs?: number },
  ): Promise<{ id: string; rawKey: string; scopes: string[] }>
  revokeKey(keyId: string): Promise<void>
  revokeApiKey(keyId: string): Promise<{ keyId: string; agentId: string }>
  delete(agentId: string): Promise<{ id: string; name: string }>
  authenticateApiKey(rawKey: string): Promise<{ agentId: string; scopes: string[] } | null>
}

export interface DocumentRepository {
  findById(id: string): Promise<Document | null>
  /** Batch betöltés `id IN (...)` — elkerüli a N× findById mintát. */
  findByIds(ids: string[]): Promise<Document[]>
  findByConnectorId(connectorId: string): Promise<Document[]>
  create(
    data: Omit<
      Document,
      'id' | 'createdAt' | 'mimeType' | 'contentHash' | 'processingMode' | 'metadata'
    > &
      Partial<Pick<Document, 'mimeType' | 'contentHash' | 'processingMode' | 'metadata'>>,
  ): Promise<Document>
  update(
    id: string,
    data: Partial<
      Pick<Document, 'status' | 'extractedText' | 'connectorId' | 'processingMode'>
    >,
  ): Promise<Document>
  delete(id: string): Promise<void>
}

// ── KB-v3 (Knowledge-Base-v3-OKF-Spec §8.3/§11) ─────────────────────────────
export interface KnowledgeArtifactRepository {
  findById(id: string): Promise<KnowledgeArtifact | null>
  create(
    data: Omit<KnowledgeArtifact, 'id' | 'createdAt' | 'publishedAt'> & {
      publishedAt?: Date | null
    },
  ): Promise<KnowledgeArtifact>
  update(
    id: string,
    data: Partial<
      Pick<
        KnowledgeArtifact,
        | 'status'
        | 'contentHash'
        | 'bundleRef'
        | 'validationResult'
        | 'reviewSummary'
        | 'approvedById'
        | 'publishedAt'
      >
    >,
  ): Promise<KnowledgeArtifact>
  /** Egy connector adott státuszú artifactjai (pl. `published`, `pending_review`). */
  findByConnector(
    connectorId: string,
    status?: KnowledgeArtifactStatus,
  ): Promise<KnowledgeArtifact[]>
  /** A forrásdokumentumhoz tartozó legmagasabb verziószám (0, ha még nincs). */
  latestVersionForDocument(connectorId: string, sourceDocumentId: string): Promise<number>
  /**
   * §10.5 — a megadott connectorokon PUBLISHED OKF-artifacttal bíró forrás-
   * dokumentumok azonosítói. A retrieval ezekre a nyers dokumentumokra
   * `superseded`-ként tekint (nem adja vissza a nyers `extractedText`-et is,
   * ha már van jóváhagyott OKF-parafrázis).
   */
  publishedSourceDocumentIds(connectorIds: string[]): Promise<string[]>
}

/** §9.1 — full-text chunk-találat (ts_rank score-ral, NEM cosine). */
export type KnowledgeChunkSearchHit = {
  artifactId: string
  connectorId: string
  path: string
  title: string
  type: string
  section: string | null
  text: string
  sourceRef: Prisma.JsonValue | null
  score: number
}

/** §9.3 — az OKF-fa egy navigálható oldala (path-onként egy sor). */
export type KnowledgeIndexEntry = {
  artifactId: string
  connectorId: string
  path: string
  title: string
  type: string
}

/** §9.2 — egy OKF-oldal egy chunkja (chunkIndex sorrendben összeáll a teljes oldallá). */
export type KnowledgePageChunk = {
  artifactId: string
  connectorId: string
  path: string
  title: string
  type: string
  section: string | null
  chunkIndex: number
  text: string
  sourceRef: Prisma.JsonValue | null
}

export interface KnowledgeChunkRepository {
  createMany(chunks: Array<Omit<KnowledgeChunk, 'id' | 'createdAt'>>): Promise<number>
  findByArtifact(artifactId: string): Promise<KnowledgeChunk[]>
  deleteByArtifact(artifactId: string): Promise<void>
  /**
   * §9.1/§10 — Postgres full-text keresés a publikált OKF-chunkokon. A scope
   * `connectorId`-alapú (D-B), a rangsor `ts_rank`. Csak `published` artifact
   * chunkjait adja vissza (§14.1).
   */
  searchChunks(params: {
    connectorIds: string[]
    query: string
    limit: number
  }): Promise<KnowledgeChunkSearchHit[]>
  /**
   * §9.3 — a publikált OKF-oldalak indexe a scope-connectorokon (path-onként egy
   * sor). Navigáció: a `kb_list_index → kb_get_page` út belépő listája. Csak
   * `published` artifact chunkjait nézi (§14.1); `connectorId`-scope (D-B).
   */
  listIndex(params: {
    connectorIds: string[]
    pathPrefix?: string
  }): Promise<KnowledgeIndexEntry[]>
  /**
   * §9.2 — egy OKF-oldal minden publikált chunkja (chunkIndex szerint), a
   * scope-connectorokon. `artifactId` megadható a path egyértelműsítéséhez
   * (ha több artifact ugyanazt a path-ot használja).
   */
  getPageChunks(params: {
    connectorIds: string[]
    path: string
    artifactId?: string
  }): Promise<KnowledgePageChunk[]>
}

// ── Tartós agent-memória (agent-memory-persistent-cross-conversation-spec.md, WP-2/WP-4) ──

/** FTS-találat a memória-scope-on — a KB `ts_rank` mintáját tükrözi (§9.1). */
export type MemoryChunkSearchHit = {
  chunk: MemoryChunk
  textRelevance: number
}

export interface MemoryChunkRepository {
  /**
   * §5.2 — publikált/aktív chunkok FTS-keresése a scope-on (memoryId + projectKey
   * + opcionális workstreamKey), `ts_rank` alapú relevanciával. Üres `query` esetén
   * üres listát ad — a hívó (MemoryRetrievalService) a no-query ágon a
   * `listRecentActive`-ot használja helyette (§5.1.1).
   */
  searchActive(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
    query: string
    limit: number
  }): Promise<MemoryChunkSearchHit[]>
  /** No-query fallback: legutóbb létrehozott/frissített aktív chunkok a scope-on (§5.1.1). */
  listRecentActive(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
    limit: number
  }): Promise<MemoryChunk[]>
  /** A scope egyetlen aktív `focus` chunkja (§3.1 invariáns: scope-onként legfeljebb 1). */
  findActiveFocus(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
  }): Promise<MemoryChunk | null>
  /** T3 `project_state` kivetített listáihoz — típusonkénti aktív chunkok, recency szerint (§4.1). */
  listActiveByType(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
    type: string
    limit: number
  }): Promise<MemoryChunk[]>
  /** §5.2 — retrieval után: `retrievedCount`++ és `lastRetrievedAt` frissítése a visszaadott chunkokon. */
  markRetrieved(chunkIds: string[]): Promise<void>
  findById(id: string): Promise<MemoryChunk | null>
  /** WP-6 — candidate jóváhagyáskor: create/update/supersede művelet T2-írása. */
  create(data: {
    memoryId: string
    agentId: string
    tenantId: string | null
    projectKey: string
    workstreamKey: string | null
    type: string
    path: string
    title: string
    text: string
    summary: string | null
    tags: string[]
    salience: number
    confidence: string
    sourceRefs: unknown
    evidence: string | null
    approvedBy: string
    approvedAt: Date
    reviewAfter: Date | null
    expiresAt: Date | null
    supersedes: string | null
    contentHash: string
  }): Promise<MemoryChunk>
  /** WP-6 — archive/supersede/delete_request jóváhagyáskor a cél-chunk állapotváltása. */
  updateStatus(
    id: string,
    patch: { status: string; supersededBy?: string | null },
  ): Promise<MemoryChunk>
  /** WP-8 — manifest-snapshothoz: a scope TELJES aktív chunk-id-halmaza (nem cappelt). */
  listActiveIds(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
  }): Promise<string[]>
  /** WP-8 — rollback set-diffhez: több chunk státuszának egy körben történő billentése. */
  setStatusMany(ids: string[], status: string): Promise<void>
  /** WP-8/G11 — dedup-horgony: rollback→re-capture ciklusban a hash-egyezésű chunk reaktiválandó. */
  findByContentHash(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
    contentHash: string
  }): Promise<MemoryChunk | null>
  /** WP-8 — maintenance `demote` proposal jóváhagyásakor: salience csökkentés szorzóval. */
  demoteSalience(id: string, factor: number): Promise<MemoryChunk>
}

export interface MemoryCandidateRepository {
  create(
    data: Omit<MemoryCandidate, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<MemoryCandidate>
  findById(id: string): Promise<MemoryCandidate | null>
  /** §6.2 batch-kártya — egy futás/szál összes javaslata (WP-5 előkészítés). */
  listByRun(params: {
    memoryId: string
    proposedByRunId?: string | null
    proposedInThreadId?: string | null
    status?: string
    /** Több státusz egy körben (`status` helyett / mellett). */
    statuses?: string[]
    projectKey?: string
  }): Promise<MemoryCandidate[]>
  /** WP-6 — jóváhagyás/elutasítás/módosítás/ticketesítés állapotváltása. */
  updateStatus(
    id: string,
    patch: {
      status: string
      approvedBy?: string | null
      approvedAt?: Date | null
      rejectedBy?: string | null
      rejectedAt?: Date | null
      ticketId?: string | null
      writeGateTokenId?: string | null
      payload?: unknown
    },
  ): Promise<MemoryCandidate>
}

/** Következmény-kapu (issue #97) — mellékhatásos tool pending jóváhagyásai. */
export interface ConsequenceApprovalRepository {
  create(
    data: Omit<ConsequenceApproval, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ConsequenceApproval>
  findById(id: string): Promise<ConsequenceApproval | null>
  /**
   * Egy beszélgetés még LEZÁRATLAN jóváhagyásai, létrehozási sorrendben.
   *
   * A chat újratöltésekor ebből áll helyre a „Jóváhagyom" kártya: enélkül a
   * kapu csak a stream élő pillanatában látszik, és a forduló lezárultával
   * elérhetetlenné válik (a munka némán megáll).
   *
   * `pending` MELLETT az `approved` sorokat is visszaadja: az emberi döntés
   * megvan, a tool-hívás viszont elbukhatott (nincs connector, lejárt token).
   * Az ilyen sor nélkül újratöltés után eltűnne az „Újrapróbálom" gomb, és a
   * felhasználó abban a hitben maradna, hogy a művelet lefutott — pedig soha
   * nem futott le. A sikeres sorokat a hívó szűri ki.
   *
   * A `createdAfter` a MÁR LEJÁRT, de friss sorokat is beengedi, hogy a
   * felhasználó legalább a magyarázatot lássa („lejárt, kérd újra"); a régi
   * lejárt sorok nem szemetelik tele a beszélgetést.
   */
  listOpenByConversation(
    conversationId: string,
    createdAfter: Date,
  ): Promise<ConsequenceApproval[]>
  /** Task-only ticket függő jóváhagyásai (conversationId nélkül). */
  listOpenByTicket(ticketId: string, createdAfter: Date): Promise<ConsequenceApproval[]>
  /**
   * Ugyanaz a még EL NEM DÖNTÖTT (pending, le nem járt) művelet ugyanabban a
   * szálban/ticketben — a kártya-duplikáció ellen.
   *
   * ÜZLETI OK: egy megszakadt futás folytatásakor a modell a szöveges
   * checkpointból újraszámolja a hátralévő tételeket, és a már kártyázott
   * műveletet ismét beküldi. A `f7ef867f` ticketen 4 ownership kapott kétszer
   * DELETE kártyát: egy „Jóváhagyom mind" mindkettőt lefuttatta volna, a
   * második 404-gyel. A felhasználónak ugyanaz a törlés kétszer jelenik meg —
   * nem tudja eldönteni, két külön tételről van-e szó.
   *
   * Csak `pending` sorra egyezik: egy MÁR lefutott művelet szándékos
   * megismétlését nem akadályozzuk.
   */
  findOpenDuplicate(input: {
    conversationId?: string | null
    ticketId?: string | null
    toolName: string
    args: unknown
    now: Date
  }): Promise<ConsequenceApproval | null>
  /**
   * CAS állapotváltás: csak akkor sikerül, ha a sor még `expectedStatus`.
   * Concurrent approve/reject ellen — a vesztes null-t kap.
   */
  casUpdateStatus(
    id: string,
    expectedStatus: ConsequenceApprovalStatus,
    patch: {
      status: ConsequenceApprovalStatus
      approvedBy?: string | null
      approvedAt?: Date | null
      rejectedBy?: string | null
      rejectedAt?: Date | null
      resultMeta?: unknown
      blockedToolCallId?: string | null
    },
  ): Promise<ConsequenceApproval | null>
  /**
   * Egyszer-használatos CLAIM az „Újrapróbálom" (retry) úthoz.
   *
   * A sor MÁR `approved` (az emberi döntés megvan), de a korábbi tool-hívás
   * elbukott (`resultMeta.denied === true`). Ez a metódus ATOMIKUSAN ráteszi a
   * `retrying: true` jelzőt (a `denied`-et megtartva), és csak a győztes kap vissza
   * sort — a MÁR folyamatban lévő (retrying) vagy nem-bukott sorra `null`. Így két
   * párhuzamos retry-kattintás nem futtathatja KÉTSZER a mellékhatásos toolt
   * (dupla e-mail / dupla POST). A pending→approved első jóváhagyást a
   * `casUpdateStatus` védi; ez ugyanaz a garancia a retry ágon.
   */
  casClaimRetry(id: string): Promise<ConsequenceApproval | null>
}

/**
 * §9.3 (WP-8) — a `MemoryVersion` mostani szerepe a T2 pillanatkép-manifeszt
 * (activeChunkIds/changeSet/projectKey/workstreamKey). A verziószám globális
 * per-memory (`@@unique([memoryId, version])`), de egy manifest-sor egyetlen
 * (projectKey, workstreamKey) scope-ot fed le — a rollback csak azt a scope-ot
 * billenti (§9.3 rollback).
 */
export interface MemoryVersionRepository {
  /** A memory következő globális verziószáma (max+1, `training-service.ts` mintáját követve). */
  nextVersionNumber(memoryId: string): Promise<number>
  create(data: {
    memoryId: string
    version: number
    projectKey: string
    workstreamKey: string | null
    activeChunkIds: string[]
    changeSet: unknown
    sourceCandidateIds: string[]
    approvedById: string | null
  }): Promise<MemoryVersion>
  /** A scope legutóbb létrehozott manifesztje ("jelenlegi" — nincs külön `status`-alapú "current" jelölés, §9.3). */
  findLatestForScope(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
  }): Promise<MemoryVersion | null>
  findByVersion(params: { memoryId: string; version: number }): Promise<MemoryVersion | null>
  /** Timeline UI-hoz (§11.2) — a scope manifestjei recency szerint. */
  listForScope(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
    limit: number
  }): Promise<MemoryVersion[]>
}

export interface PlatformSettingsRepository {
  get(key: string): Promise<unknown | null>
  /** `Prisma.JsonNull` a „nincs érték” — a `value` oszlop nem nullable, törölni nem tudunk. */
  set(
    key: string,
    value:
      | import('@prisma/client').Prisma.InputJsonValue
      | import('@prisma/client').Prisma.NullTypes.JsonNull,
    updatedById?: string | null,
  ): Promise<void>
}

export interface AuditRepository {
  /**
   * tenantId/ticketId/conversationId opcionálisak: ha a hívó nem adja meg őket explicit,
   * az append() a targetType/targetId-ból vagy a metadata ismert kulcsaiból származtatja
   * őket (lásd src/lib/audit/attribution.ts) — a ~150 meglévő hívási hely emiatt nem
   * változik.
   */
  append(
    data: Omit<
      AuditLog,
      'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash' | 'tenantId' | 'ticketId' | 'conversationId'
    > & {
      tenantId?: string | null
      ticketId?: string | null
      conversationId?: string | null
    },
  ): Promise<AuditLog>
  findMany(filter?: {
    action?: string | string[]
    actorType?: AuditLog['actorType']
    actorId?: string
    targetType?: string
    targetId?: string
    tenantId?: string
    ticketId?: string
    conversationId?: string
    since?: Date
    limit?: number
  }): Promise<AuditLog[]>
  /**
   * Audit-sorok seq szerint rendezve. A tenant/since szűrő az audit-olvasó és SIEM-export
   * kötelező adat-határa; a [fromSeq..toSeq] a hash-lánc részleges ellenőrzéséhez kell.
   */
  findAll(filter?: {
    fromSeq?: bigint
    toSeq?: bigint
    tenantId?: string
    since?: Date
  }): Promise<AuditLog[]>
  /** Counts of audit events grouped by `action`, optionally narrowed to a set / time window (§11 governance). */
  getActionCounts(filter?: { actions?: string[]; since?: Date }): Promise<Record<string, number>>
}

export type ModelCallGovernanceSummary = {
  calls: number
  tokens: number
  cost: number
  avgLatencyMs: number
  okCalls: number
  errorCalls: number
  rateLimitedCalls: number
  /** Tartalékra váltások száma az időablakban (audit: model.call.fallback). */
  fallbackSwitches?: number
}

export type ModelCallTicketBreakdown = {
  ticketId: string
  /** Ticket cím — UI-hoz; hiányzik, ha a ticket már törölve. */
  ticketTitle: string | null
  calls: number
  tokens: number
  cost: number
  avgLatencyMs: number
}

export interface ModelCallRepository {
  create(data: Omit<ModelCall, 'id' | 'createdAt'>): Promise<ModelCall>
  getCostSummary(since?: Date): Promise<{ tokens: number; cost: number }>
  getUsageForAgentSince(agentId: string, since: Date): Promise<{ calls: number; tokens: number }>
  getUsageForTicket(ticketId: string): Promise<{ calls: number; tokens: number }>
  getUsageForAgent(agentId: string, period: ModelBudgetPeriod): Promise<{ calls: number; tokens: number }>
  /**
   * Tenant-szintű fogyasztás a budget-kapuhoz.
   * - `tenantId: null` = platform-bucket (megosztott agentek).
   * - konkrét tenant: a szervezet saját agentjei + a platform-agentek ezen a
   *   tenanton (ticket/conversation work-owner) végzett hívásai. A kapu a
   *   work-owner `tenantId`-t adja át, ezért e nélkül a hard cap megkerülhető.
   */
  getUsageForTenant(
    tenantId: string | null,
    period: ModelBudgetPeriod,
  ): Promise<{ calls: number; tokens: number }>
  /**
   * Ticket-típus fogyasztás. Konkrét tenantnál a platform-agent work-owner
   * hívások is beleszámítanak (ugyanaz a szabály, mint `getUsageForTenant`).
   */
  getUsageForTicketType(
    tenantId: string | null,
    ticketType: Ticket['type'],
    period: ModelBudgetPeriod,
  ): Promise<{ calls: number; tokens: number }>
  /** Bucket agentenkénti bontása — a per-agent keret melletti „ki hol tart" nézethez. */
  getUsageByAgent(
    tenantId: string | null,
    period: ModelBudgetPeriod,
  ): Promise<Array<{ agentId: string; calls: number; tokens: number }>>
  /** Aggregate Gateway metrics for the governance dashboard (§11: hatékonyság + költség). */
  getGovernanceSummary(since?: Date): Promise<ModelCallGovernanceSummary>
  /** Per-ticket Gateway usage breakdown, most recent first. */
  getPerTicketBreakdown(since?: Date, limit?: number): Promise<ModelCallTicketBreakdown[]>
}

// ── Fázis 2: Model Gateway routing + budget ──────────────────────────────────

export interface ModelRoutingPolicyRepository {
  list(filter?: { tenantId?: string; scope?: ModelRoutingScope }): Promise<ModelRoutingPolicy[]>
  findById(id: string): Promise<ModelRoutingPolicy | null>
  create(
    data: Omit<ModelRoutingPolicy, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ModelRoutingPolicy>
  update(id: string, data: Partial<Omit<ModelRoutingPolicy, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ModelRoutingPolicy>
  delete(id: string): Promise<void>
  /** Ordered by priority ASC — first match wins in routing chain. */
  findForRouting(filter: { tenantId?: string; agentId?: string; ticketType?: string }): Promise<ModelRoutingPolicy[]>
}

export interface ModelBudgetRepository {
  list(filter?: { tenantId?: string; scope?: ModelBudgetScope }): Promise<ModelBudget[]>
  findById(id: string): Promise<ModelBudget | null>
  create(data: Omit<ModelBudget, 'id' | 'createdAt' | 'updatedAt'>): Promise<ModelBudget>
  update(id: string, data: Partial<Omit<ModelBudget, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ModelBudget>
  delete(id: string): Promise<void>
  /**
   * Find all applicable budgets for a given call context, from most-specific to least-specific.
   *
   * A `tenantId` háromértékű: konkrét id → az adott tenant ÉS a platform-szintű (`tenantId: null`)
   * keretek; `null` → kizárólag a platform-szintűek; `undefined` → nincs tenant-szűrés, tehát
   * MINDEN tenant kerete visszajön. Az utóbbit csak admin-listázás használhatja, kapu-döntés soha.
   */
  findApplicable(filter: {
    tenantId?: string | null
    agentId?: string
    ticketType?: string
  }): Promise<ModelBudget[]>
}

export { ModelBudgetPeriod, ModelBudgetScope, ModelRoutingScope }

/** issue #220 — agent↔connector kötés a kapu / admin UI számára. */
export type AgentConnectorBinding = {
  connector: Connector
  accessMode: ConnectorAccessMode
  agentSecretAlias: string | null
  writeApproval: 'per_call' | 'preapproved'
  preapprovedTrustMode: 'lax' | 'strict' | null
  preapprovedExpiresAt: Date | null
  preapprovedWriteLimit: number | null
  dangerPreapproved: boolean
}

export interface ToolBrokerRepository {
  findCapability(agentId: string, toolName: string): Promise<{ allowed: boolean } | null>
  /**
   * Batch capability lekérdezés több agentre (opcionális toolName szűrővel).
   * Egy `findMany` az N×`findCapability` / N×`findCapabilitiesForAgent` helyett.
   */
  findCapabilitiesForAgents(
    agentIds: string[],
    toolNames?: string[],
  ): Promise<{ agentId: string; toolName: string; allowed: boolean }[]>
  findConnectorForAgent(
    agentId: string,
    type: ConnectorType,
    accessMode: ConnectorAccessMode,
    tenantId?: string | null,
  ): Promise<{ connector: Connector; agentSecretAlias: string | null } | null>
  findConnectorForAgentById(
    agentId: string,
    connectorId: string,
    type: ConnectorType,
    accessMode: ConnectorAccessMode,
    tenantId?: string | null,
  ): Promise<{ connector: Connector; agentSecretAlias: string | null } | null>
  findCapabilitiesForAgent(agentId: string): Promise<{ toolName: string; allowed: boolean }[]>
  findConnectorsForAgent(agentId: string): Promise<AgentConnectorBinding[]>
  findDocumentsForConnector(
    connectorId: string,
  ): Promise<{ id: string; filename: string; extractedText: string | null }[]>
  /** Batch KB legacy-doc load: egy kör, superseded kizárás, hard cap. */
  findDocumentsForConnectors(
    connectorIds: string[],
    opts?: { excludeIds?: string[]; take?: number },
  ): Promise<{ id: string; filename: string; extractedText: string | null }[]>
  createToolCall(data: Omit<ToolCall, 'id' | 'createdAt'>): Promise<ToolCall>
  getToolSummary(since?: Date): Promise<{ calls: number; denied: number; errors: number }>
  /** Tool-call counts keyed by ticket id for the governance per-ticket breakdown (§11). */
  getToolCallCountsByTicket(since?: Date): Promise<Record<string, number>>
  /** Web Search rate-limit (maxQueriesPerTicket) — Feature-spec WebSearchTool §5.4. */
  countToolCallsForTicket(ticketId: string, toolName: string): Promise<number>
  /** Chat: beszélgetés-scope web_search limit (ticket nélküli fordulók). */
  countToolCallsForConversation(conversationId: string, toolName: string): Promise<number>
  /** Web Search rate-limit (maxQueriesPerAgentDay) — Feature-spec WebSearchTool §5.4. */
  countToolCallsForAgentSince(agentId: string, toolName: string, since: Date): Promise<number>
  /** Governance/agent-card nézethez — Feature-spec WebSearchTool §7.1/§7.3. */
  listToolCallsByName(
    toolName: string,
    filter?: { agentId?: string; since?: Date },
    limit?: number,
  ): Promise<ToolCall[]>
  /** Chat-kontextus: a beszélgetés korábbi tool-hívásai (időrendben), hogy a
   *  következő forduló promptja a nyers agent-szöveg mellett strukturáltan is
   *  lássa, mit hívott és milyen eredménnyel (pl. melyik fájlt szerkesztette). */
  listToolCallsForConversation(conversationId: string, limit?: number): Promise<ToolCall[]>
}

export type RecipeWithVersions = Recipe & { versions: RecipeVersion[] }

export type RecipeListOpts = {
  /** `latest` (default): csak a legújabb verzió; `all`: full dump. */
  versions?: 'latest' | 'all'
  limit?: number
  offset?: number
  unbounded?: boolean
}

export interface RecipeRepository {
  list(opts?: RecipeListOpts): Promise<RecipeWithVersions[]>
  findById(id: string): Promise<RecipeWithVersions | null>
  createRecipe(input: {
    name: string
    ticketType: RecipeTicketType
    scope: RecipeScope
    content: Prisma.JsonValue
  }): Promise<{ recipe: Recipe; version: RecipeVersion }>
  addVersion(recipeId: string, content: Prisma.JsonValue): Promise<RecipeVersion>
  approveVersion(versionId: string, approverId: string): Promise<RecipeVersion>
  getActiveVersion(recipeId: string): Promise<RecipeVersion | null>
}

// ── Skill-katalógus (skill-catalog-spec.md, WP-1) ───────────────────────────

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
  sourceType: SkillSourceType
  provenance: Prisma.InputJsonValue | null
  license: string | null
  riskTier: SkillRiskTier
  content: Prisma.InputJsonValue
  requires: Prisma.InputJsonValue
  /** Level-2 mellékletek (csomag-import); hiányzó érték = nincs melléklet. */
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
  /** Global (tenantId null) + a megadott tenant skilljei — fail-closed olvasás. */
  listForTenant(actorTenantId: string | null): Promise<SkillWithVersions[]>
  findById(id: string): Promise<SkillWithVersions | null>
  /** Hatókörön belüli név-keresés (case-insensitive, trim) — egyediség-kapuhoz. */
  findByNameInScope(name: string, tenantId: string | null): Promise<Skill | null>
  findVersionById(versionId: string): Promise<(SkillVersion & { skill: Skill }) | null>
  /** Batch skill-verzió betöltés — preload / slash path N+1 elkerülésére. */
  findVersionsByIds(versionIds: string[]): Promise<(SkillVersion & { skill: Skill })[]>
  createSkill(input: CreateSkillInput): Promise<{ skill: Skill; version: SkillVersion }>
  /** Embernek szóló feladatnév — nem verziózott metaadat. */
  updateDisplayName(skillId: string, displayName: string | null): Promise<Skill>
  /** Level-0 index leírás — nem verziózott metaadat (katalógus / skill-választó). */
  updateDescription(skillId: string, description: string): Promise<Skill>
  addVersion(input: AddSkillVersionInput): Promise<SkillVersion>
  /** Jóváhagyás: az adott verzió `active`, az addigi aktív `retired`, agentek átkötése. */
  approveVersion(
    versionId: string,
    params: { approverId: string; signature: string },
  ): Promise<SkillVersionActivationResult>
  /** Rollback: egy korábban aktív (`retired` / `rolled_back`) verzió újraaktiválása + agent migráció. */
  rollbackToVersion(
    versionId: string,
    params: { approverId: string; signature: string },
  ): Promise<SkillVersionActivationResult>
  /** Az aktív verzió `retired` — a skill nem hozzárendelhető, meglévő hozzárendelések megmaradnak. */
  retireActiveVersion(skillId: string): Promise<SkillVersion | null>
  getActiveVersion(skillId: string): Promise<SkillVersion | null>
  countAssignmentsForSkill(skillId: string): Promise<number>
  deleteSkill(skillId: string): Promise<void>

  // Hozzárendelés (AgentSkill)
  assign(input: {
    agentId: string
    skillVersionId: string
    assignedById: string | null
  }): Promise<{ assignment: AgentSkill; replacedVersionIds: string[] }>
  unassign(agentId: string, skillVersionId: string): Promise<void>
  setEnabled(agentId: string, skillVersionId: string, enabled: boolean): Promise<AgentSkill>
  listAgentSkills(agentId: string): Promise<AgentSkillWithVersion[]>
  /** Context-assembler: csak az enabled hozzárendelt skill-verziók (Level-0 index). */
  listEnabledForAgent(agentId: string): Promise<AgentSkillWithVersion[]>
  findAssignment(agentId: string, skillVersionId: string): Promise<AgentSkillWithVersion | null>
}

export type PlaybookWithVersions = Playbook & { versions: PlaybookVersion[] }

export interface PlaybookRepository {
  list(): Promise<PlaybookWithVersions[]>
  findByName(name: string): Promise<PlaybookWithVersions | null>
  findVersionByNameAndVersion(
    name: string,
    version: number,
  ): Promise<(PlaybookVersion & { playbook: Playbook }) | null>
  createPlaybook(input: {
    name: string
    processType: string
    tenantId?: string | null
    spec: Prisma.JsonValue
  }): Promise<{ playbook: Playbook; version: PlaybookVersion }>
  approveVersion(versionId: string, approverId: string): Promise<PlaybookVersion>
  getActiveVersion(playbookId: string): Promise<PlaybookVersion | null>
  getActiveVersionByName(name: string): Promise<(PlaybookVersion & { playbook: Playbook }) | null>
}

// --- Fázis 2 Playbook V2 (Feature-spec — Playbook §4, §8.1) ------------------

export type PlaybookV2WithVersions = PlaybookV2 & {
  versions: PlaybookVersionV2[]
  /** Katalógus listához; ha hiányzik, `versions.length` a forrás. */
  versionCount?: number
}

export type PlaybookListOpts = {
  /** `none` (default): üres versions + versionCount; `all`: full dump. */
  includeVersions?: 'none' | 'all'
  limit?: number
  offset?: number
  unbounded?: boolean
}

export type CreatePlaybookV2Input = {
  tenantId: string | null
  key: string
  name: string
  description?: string | null
  processType: string
  ownerUserId?: string | null
}

export type CreatePlaybookVersionV2Input = {
  tenantId: string | null
  playbookId: string
  version: number
  spec: Prisma.InputJsonValue
  changeSummary: string
  contentHash: string
  validationResult: Prisma.InputJsonValue
  createdById: string
  // Canvas node-pozíciók (D2) — nem hash-elt prezentáció; default {}.
  layout?: Prisma.InputJsonValue
}

export type CreatePlaybookAssignmentInput = {
  tenantId: string | null
  playbookId: string
  playbookVersionId: string
  assignmentType: 'process_type' | 'ticket_type'
  assignmentKey: string
  isDefault: boolean
  createdById: string
}

export interface PlaybookV2Repository {
  createPlaybook(input: CreatePlaybookV2Input): Promise<PlaybookV2>
  findPlaybook(tenantId: string | null, id: string): Promise<PlaybookV2 | null>
  findPlaybookByKey(tenantId: string | null, key: string): Promise<PlaybookV2 | null>
  listPlaybooks(tenantId: string | null, opts?: PlaybookListOpts): Promise<PlaybookV2WithVersions[]>
  listDefaultAssignments(
    tenantId: string | null,
    assignmentType: string,
  ): Promise<PlaybookAssignment[]>
  findVersionsByIds(tenantId: string | null, ids: string[]): Promise<PlaybookVersionV2[]>
  findPlaybooksByIds(tenantId: string | null, ids: string[]): Promise<PlaybookV2[]>
  updatePlaybook(
    id: string,
    data: Partial<{
      name: string
      description: string | null
      status: PlaybookV2Status
      currentPublishedVersionId: string | null
      archivedAt: Date | null
    }>,
  ): Promise<PlaybookV2>

  createVersion(input: CreatePlaybookVersionV2Input): Promise<PlaybookVersionV2>
  findVersion(tenantId: string | null, id: string): Promise<PlaybookVersionV2 | null>
  findVersionByContentHash(
    tenantId: string | null,
    playbookId: string,
    contentHash: string,
  ): Promise<PlaybookVersionV2 | null>
  listVersions(playbookId: string): Promise<PlaybookVersionV2[]>
  nextVersionNumber(playbookId: string): Promise<number>
  updateVersion(
    id: string,
    data: Partial<{
      status: PlaybookVersionV2Status
      spec: Prisma.InputJsonValue
      changeSummary: string
      contentHash: string
      validationResult: Prisma.InputJsonValue
      compiledSpec: Prisma.InputJsonValue
      layout: Prisma.InputJsonValue
      approvedById: string | null
      approvedAt: Date | null
      publishedAt: Date | null
      retiredAt: Date | null
    }>,
  ): Promise<PlaybookVersionV2>

  /** Tranzakció: a korábbi published verziót retire-eli, az újat published-re állítja,
   *  és a playbook current_published_version_id + status mezőit frissíti (§4.3 immutable). */
  publishVersion(input: {
    versionId: string
    playbookId: string
    approverId: string
    compiledSpec: Prisma.InputJsonValue
  }): Promise<PlaybookVersionV2>

  /** Tranzakció: ha isDefault, a (tenant, type, key) párra létező aktív default-ot revoke-olja.
   *  Csak legacy indítási defaultokhoz használható; agent-role rosterhez új kód nem írhat. */
  createAssignment(input: CreatePlaybookAssignmentInput): Promise<PlaybookAssignment>
  findDefaultAssignment(
    tenantId: string | null,
    assignmentType: string,
    assignmentKey: string,
  ): Promise<PlaybookAssignment | null>
  /**
   * Batch default assignment: egy query az összes `assignmentKey`-re.
   * Kulcsonként a legfrissebb aktív defaultot adja vissza (ugyanaz a sematika, mint `findDefaultAssignment`).
   */
  findDefaultAssignments(
    tenantId: string | null,
    assignmentType: string,
    assignmentKeys: string[],
  ): Promise<Map<string, PlaybookAssignment>>
}

// --- Fázis 2 Playbook process runtime (Feature-spec — Playbook §4.5–4.7, §8.2) ---

export type CreateProcessInstanceInput = {
  tenantId: string | null
  processType: string
  playbookId: string
  playbookVersionId: string
  playbookRef: string
  playbookContentHash: string
  // Folyamat-feature-spec §7: a forrás-Folyamat és a trigger (opcionális a régi úthoz).
  processDefinitionId?: string | null
  triggerType?: ProcessTriggerType | null
  startedByType: ProcessActorType
  startedByUserId?: string | null
  startedByAgentId?: string | null
  conversationId?: string | null
  rootTicketId?: string | null
  inputPayload: Prisma.InputJsonValue
}

export type CreateProcessStepInput = {
  tenantId: string | null
  processInstanceId: string
  stepId: string
  stepName: string
  status?: ProcessStepStatus
  assignedRole: string
  assignedAgentId?: string | null
  assignedUserId?: string | null
  ticketId?: string | null
}

export type CreateDelegationEdgeInput = {
  tenantId: string | null
  processInstanceId: string
  fromStepId: string
  toStepId: string
  fromTicketId?: string | null
  toTicketId?: string | null
  fromActorType: ProcessActorType
  fromAgentId?: string | null
  fromUserId?: string | null
  toActorType: ProcessActorType
  toAgentId?: string | null
  toUserId?: string | null
  metadata?: Prisma.InputJsonValue
}

export type ProcessInstanceDetail = ProcessInstance & {
  steps: ProcessStepInstance[]
  delegations: DelegationEdge[]
}

export interface ProcessRepository {
  createProcess(input: CreateProcessInstanceInput): Promise<ProcessInstance>
  findProcess(tenantId: string | null, id: string): Promise<ProcessInstance | null>
  findProcessDetail(tenantId: string | null, id: string): Promise<ProcessInstanceDetail | null>
  listProcesses(
    tenantId: string | null,
    opts?: { limit?: number; offset?: number; unbounded?: boolean },
  ): Promise<ProcessInstance[]>
  listProcessesPage(
    tenantId: string | null,
    opts?: { limit?: number; offset?: number; unbounded?: boolean },
  ): Promise<ListPageResult<ProcessInstance>>
  updateProcess(
    id: string,
    data: Partial<{
      status: ProcessStatus
      rootTicketId: string | null
      outputPayload: Prisma.InputJsonValue
      completedAt: Date | null
      failedAt: Date | null
    }>,
  ): Promise<ProcessInstance>

  /**
   * Atomikus állapotfrissítés: csak akkor ír, ha a futás jelenlegi státusza a
   * megadott halmazban van. Versenyhelyzetben (pl. complete vs. késő next_step)
   * nem írja felül a terminális állapotot — `null` = nem történt módosítás.
   */
  updateProcessIfStatusIn(
    id: string,
    statuses: ProcessStatus[],
    data: Partial<{
      status: ProcessStatus
      rootTicketId: string | null
      outputPayload: Prisma.InputJsonValue
      completedAt: Date | null
      failedAt: Date | null
    }>,
  ): Promise<ProcessInstance | null>

  createStep(input: CreateProcessStepInput): Promise<ProcessStepInstance>
  findStep(processInstanceId: string, stepId: string): Promise<ProcessStepInstance | null>
  findStepByTicket(tenantId: string | null, ticketId: string): Promise<ProcessStepInstance | null>
  listSteps(processInstanceId: string): Promise<ProcessStepInstance[]>
  updateStep(
    id: string,
    data: Partial<{
      status: ProcessStepStatus
      ticketId: string | null
      assignedAgentId: string | null
      assignedUserId: string | null
      startedAt: Date | null
      completedAt: Date | null
      failedAt: Date | null
      resultPayload: Prisma.InputJsonValue
    }>,
  ): Promise<ProcessStepInstance>

  createDelegation(input: CreateDelegationEdgeInput): Promise<DelegationEdge>
  listDelegations(processInstanceId: string): Promise<DelegationEdge[]>
  updateDelegation(
    id: string,
    data: Partial<{
      status: DelegationStatus
      toTicketId: string | null
      deliveredAt: Date | null
      acceptedAt: Date | null
      doneAt: Date | null
      failedAt: Date | null
    }>,
  ): Promise<DelegationEdge>
}

// --- Folyamat (Process Definition) réteg (Folyamat-feature-spec §1, §4.1, §7) ---

export type CreateProcessDefinitionInput = {
  tenantId: string | null
  name: string
  description?: string | null
  playbookId: string
  playbookVersionId: string
  createdById: string
}

export type ProcessDefinitionWithTriggers = ProcessDefinition & {
  triggers: ProcessTrigger[]
}

export type CreateProcessTriggerInput = {
  tenantId: string | null
  processDefinitionId: string
  type: ProcessTriggerType
  inputMap: Prisma.InputJsonValue
  monitorDefinitionId?: string | null
  createdById: string
}

export interface ProcessDefinitionRepository {
  create(input: CreateProcessDefinitionInput): Promise<ProcessDefinition>
  findById(tenantId: string | null, id: string): Promise<ProcessDefinitionWithTriggers | null>
  list(
    tenantId: string | null,
    status?: ProcessDefinitionStatus,
  ): Promise<ProcessDefinitionWithTriggers[]>
  update(
    id: string,
    data: Partial<{
      name: string
      description: string | null
      status: ProcessDefinitionStatus
      playbookId: string
      playbookVersionId: string
      roleBindings: Prisma.InputJsonValue
      configValues: Prisma.InputJsonValue
      approvedById: string | null
      approvedAt: Date | null
      archivedAt: Date | null
    }>,
  ): Promise<ProcessDefinition>

  createTrigger(input: CreateProcessTriggerInput): Promise<ProcessTrigger>
  findTrigger(
    tenantId: string | null,
    id: string,
  ): Promise<ProcessTrigger | null>
  listTriggers(processDefinitionId: string): Promise<ProcessTrigger[]>
  listActiveMonitorCronTriggers(tenantId: string | null, monitorDefinitionId: string): Promise<ProcessTrigger[]>
  /** Hard-delete (a draft-fázisban csatolt/leválasztott trigger). */
  deleteTrigger(id: string): Promise<void>
}

export interface ConversationRepository {
  create(data: {
    tenantId: string | null
    agentId: string
    title?: string | null
    createdById: string
    retentionPolicyId?: string | null
    legalHold?: boolean
    /** Memória-hatókör projektkulcsa (D9). Alap: gyűjtő (`__general__`). */
    projectKey?: string | null
    /** Csatorna-megjelölés (D14): ha a beszélgetés egy csatorna-adapteren (pl. Telegram) él. */
    channel?: ChannelType | null
    channelExternalId?: string | null
    /** Ticket → Megbeszélés (#219): forrás ticket (prior kontextus). */
    continuedFromTicketId?: string | null
  }): Promise<Conversation>
  findById(id: string): Promise<Conversation | null>
  findByIdForTenant(id: string, tenantId: string | null): Promise<Conversation | null>
  list(params: {
    tenantId?: string | null
    agentId?: string
    status?: Conversation['status']
    mine?: boolean
    createdById?: string
    limit?: number
    cursor?: Date
  }): Promise<Conversation[]>
  findManyForAgentUser(params: {
    agentId: string
    createdById: string
    tenantId?: string | null
    limit?: number
  }): Promise<
    Array<
      Conversation & {
        previewText: string | null
      }
    >
  >
  appendMessage(data: {
    conversationId: string
    role: MessageRole
    content: string
    actingUserId?: string | null
    agentVersion?: number | null
    model?: string | null
    ticketRefId?: string | null
    criticality?: MessageCriticality | null
  }): Promise<Message>
  findMessages(
    conversationId: string,
    options?: { limit?: number; beforeSeq?: number },
  ): Promise<Array<Message & { content: string | null }>>
  findMessageById(id: string): Promise<Message | null>
  findMessageByIdForTenant(id: string, tenantId: string | null): Promise<Message | null>
  archive(id: string): Promise<Conversation>
  deleteMessageContent(messageId: string): Promise<Message>
  deleteConversationContent(conversationId: string): Promise<Message[]>
  linkMessageToTicket(messageId: string, ticketId: string): Promise<Message>
  setMessageAuditEventRef(messageId: string, auditEventRef: string): Promise<Message>
  findRetentionPolicy(id: string): Promise<RetentionPolicy | null>
  retentionSweep(
    now: Date,
    limit?: number,
  ): Promise<{
    sweptCount: number
    deletedCount: number
    conversationIds: string[]
  }>
}

/**
 * chat-agent-turn-resilience-spec.md §4 — az aktív (még nem terminális)
 * forduló-státuszok. Az aktív-forduló invariáns (D7) ezen a halmazon áll, és a
 * `0009_agent_turn` migráció részleges egyedi indexe ugyanezt a hármast szűri.
 */
export const ACTIVE_AGENT_TURN_STATUSES = ['queued', 'running', 'streaming'] as const

export type ActiveAgentTurnStatus = (typeof ACTIVE_AGENT_TURN_STATUSES)[number]

export type TerminalAgentTurnStatus = Exclude<AgentTurnStatus, ActiveAgentTurnStatus>

/**
 * Az aktív-forduló invariáns (D7) megsértése. A DB részleges egyedi indexe a
 * végső kényszer; a repository ezt fordítja tipizált hibára, hogy a hívó
 * megkülönböztethesse a valódi DB-hibától (és később 409-cel válaszolhasson).
 */
export class ActiveAgentTurnExistsError extends Error {
  constructor(readonly conversationId: string) {
    super(`A beszélgetésnek már van aktív agent-fordulója: ${conversationId}`)
    this.name = 'ActiveAgentTurnExistsError'
  }
}

export type CreateAgentTurnInput = {
  conversationId: string
  tenantId: string | null
  agentId: string
  agentVersion: number
  createdById: string
  /**
   * A foglaláskor (§5.1/3, D7) még nincs user-üzenet: a rekord előbb jön létre,
   * hogy a részleges egyedi index dönthessen, és csak utána íródik az üzenet.
   * A bekötés `attachUserMessage`-dzsel történik.
   */
  userMessageId?: string | null
  status?: ActiveAgentTurnStatus
  lockToken?: string | null
  lockedAt?: Date | null
}

export type FinalizeAgentTurnInput = {
  status: TerminalAgentTurnStatus
  assistantMessageId?: string | null
  partialText?: string
  activities?: Prisma.InputJsonValue
  turnCount?: number
  toolCallCount?: number
  deniedCount?: number
  reason?: string | null
  error?: string | null
  finishedAt?: Date
}

/** Futó forduló köztes snapshotja (spec §5.3 / D9, issue #63). */
export type UpdateAgentTurnProgressInput = {
  partialText?: string
  activities?: Prisma.InputJsonValue
  /**
   * issue #180 WP-1 — a loop-elszámolók MENET KÖZBEN is. E nélkül egy futó
   * forduló nullát mutat, és egy elszaladt futásról csak a lezárása után derül
   * ki, hogy tucatnyi körön és több száz eszközhíváson át pörgött — épp akkor
   * nem látszik, amikor még be lehetne avatkozni.
   */
  turnCount?: number
  toolCallCount?: number
  deniedCount?: number
}

/**
 * A perzisztált chat-agent-forduló tára (spec §4/§5). A lock+heartbeat rész a
 * `TicketRepository` dispatch-lock konvencióját követi: a lock megszerzése és
 * elengedése is feltételes `updateMany`, hogy két futó ne írhassa felül egymást.
 */
export interface AgentTurnRepository {
  create(data: CreateAgentTurnInput): Promise<AgentTurn>
  findById(id: string): Promise<AgentTurn | null>
  /** Az invariáns szerint legfeljebb egy ilyen sor létezhet. */
  findActiveByConversation(conversationId: string): Promise<AgentTurn | null>
  /**
   * Tenant-szintű aktív fordulók (Aktív futások panel / lista API).
   * `createdById` megadása esetén csak a felhasználó saját futásai.
   */
  listActiveByTenant(
    tenantId: string | null,
    options?: { createdById?: string; limit?: number },
  ): Promise<AgentTurn[]>
  /**
   * Friss terminális fordulók (Futások panel — lefutott lista).
   * `finishedAt` szerint csökkenő; null finishedAt a végére kerül.
   * `createdById` megadása esetén csak a felhasználó saját futásai.
   */
  listRecentTerminalByTenant(
    tenantId: string | null,
    options?: { createdById?: string; limit?: number },
  ): Promise<AgentTurn[]>
  /**
   * A lefoglalt fordulóhoz utólag köti a most perzisztált user-üzenetet
   * (l. `CreateAgentTurnInput.userMessageId`).
   */
  attachUserMessage(id: string, userMessageId: string): Promise<void>
  /**
   * Lock megszerzése csak akkor, ha a forduló még aktív és nincs más birtokosa.
   * `null` = a lockot valaki más tartja, vagy a forduló már terminális.
   */
  acquireLock(id: string, lockToken: string, now: Date): Promise<AgentTurn | null>
  /** Csak a lock birtokosa engedheti el; a státuszt nem érinti. */
  releaseLock(id: string, lockToken: string): Promise<void>
  /** Csak a lock birtokosa üthet szívet — a stale-reclaim így nem írható vissza. */
  heartbeat(id: string, lockToken: string, now: Date): Promise<AgentTurn | null>
  /**
   * Köztes snapshot (részszöveg / aktivitások). Csak a lock birtokosa írhat
   * aktív fordulóra — idegen token vagy terminális státusz → `null`.
   */
  updateProgress(
    id: string,
    lockToken: string,
    data: UpdateAgentTurnProgressInput,
  ): Promise<AgentTurn | null>
  /**
   * Explicit Stop (D6): `cancelRequested` flag a DB-ben. Csak aktív fordulóra.
   * `null` = a forduló már terminális vagy nem található.
   */
  requestCancel(id: string, byUserId: string, now?: Date): Promise<AgentTurn | null>
  /** Gyors cancel-ellenőrzés a loop checkpointjaihoz. */
  isCancelRequested(id: string): Promise<boolean>
  /**
   * Terminális lezárás: a lock elengedésével együtt, egyetlen feltételes
   * írásban. `null` = a forduló már terminális volt (a lezárás idempotens).
   */
  finalize(id: string, data: FinalizeAgentTurnInput): Promise<AgentTurn | null>
  /** Watchdog: aktív, de a `heartbeatAt`-je a küszöbnél régebbi fordulók. */
  findStale(cutoff: Date, limit: number): Promise<AgentTurn[]>
  /**
   * A beszélgetés legutóbbi terminális fordulója (folytatás-prompthoz).
   * Aktív (queued/running/streaming) sorokat kihagyja.
   */
  findLatestTerminalByConversation(conversationId: string): Promise<AgentTurn | null>
}

export type SandboxAppWithLatestVersion = SandboxApp & {
  versions: SandboxAppVersion[]
}

export type SandboxAppListItem = SandboxApp & {
  activeVersion: SandboxAppVersion | null
}

/**
 * App Registry observability metrikák (§8.3) — tenant-scoped aggregáció a
 * registry-táblákból. Az audit-eredetű eseményszámokat (preview/export/…) a
 * service teszi hozzá; itt csak a táblákból determinisztikusan számolható
 * mutatók szerepelnek. `appIds` a tenant összes app-azonosítója, hogy a service
 * a tenant-globális audit-eseményeket app-azonosító alapján szűrhesse.
 */
export type SandboxAppRegistryMetrics = {
  appsTotal: number
  appsByStatus: Record<string, number>
  appsByCreator: { agent: number; user: number }
  versionsTotal: number
  avgVersionsPerApp: number
  avgArtifactSizeBytes: number
  appIds: string[]
}

export type CreateSandboxAppInput = {
  tenantId: string | null
  sandboxId?: string | null
  name: string
  description?: string | null
  criticality: SandboxAppCriticality
  createdByType: SandboxCreatedByType
  createdByUserId?: string | null
  createdByAgentId?: string | null
  createdFromTicketId?: string | null
  createdFromConversationId?: string | null
  policy: Prisma.InputJsonValue
  tags?: string[]
}

export type AddSandboxAppVersionInput = {
  appId: string
  tenantId: string | null
  changeSummary: string
  artifactSizeBytes: number
  contentHash: string
  mimeType?: string
  createdByType: SandboxCreatedByType
  createdByUserId?: string | null
  createdByAgentId?: string | null
  createdFromRunId?: string | null
  sourceTicketId?: string | null
  validationResult: Prisma.InputJsonValue
}

export type SandboxAppListFilter = {
  tenantId: string | null
  sandboxId?: string | null
  createdByAgentId?: string
  status?: SandboxAppStatus
  search?: string
  limit?: number
  cursor?: string
}

export interface SandboxAppRepository {
  findByIdWithLatestVersion(appId: string): Promise<SandboxAppWithLatestVersion | null>
  findLatestByTicketId(ticketId: string): Promise<SandboxAppWithLatestVersion | null>
  findById(appId: string): Promise<SandboxApp | null>
  create(input: CreateSandboxAppInput): Promise<SandboxApp>
  /**
   * Új immutable verzió tranzakciós verziószám-kiosztással. A visszaadott
   * `artifactRef` a kiosztott verzió object-path-e — a hívó ide tölti fel az
   * artefaktot (a path determinisztikus: lásd artifactObjectPath).
   */
  addVersion(input: AddSandboxAppVersionInput): Promise<SandboxAppVersion>
  /** Ugyanazon app + contentHash — idempotens update_artifact újrapróbáláshoz. */
  findVersionByContentHash(appId: string, contentHash: string): Promise<SandboxAppVersion | null>
  /** GCS feltöltés hibája után az árva verziósor törlése. */
  deleteVersion(versionId: string): Promise<void>
  /** Aktív verzió átállítása: app.activeVersionId + verzió-státuszok (active/superseded). */
  setActiveVersion(params: { appId: string; versionId: string }): Promise<void>
  /** App archiválása (status = 'archived', archivedAt = now). */
  archive(appId: string): Promise<SandboxApp>
  getVersion(appId: string, version: number): Promise<SandboxAppVersion | null>
  getVersionById(versionId: string): Promise<SandboxAppVersion | null>
  listVersions(appId: string): Promise<SandboxAppVersion[]>
  list(filter: SandboxAppListFilter): Promise<{ items: SandboxAppListItem[]; nextCursor?: string }>
  /** Tenant-scoped registry metrikák a táblákból (§8.3). */
  getRegistryMetrics(tenantId: string | null): Promise<SandboxAppRegistryMetrics>
}

export interface ConnectorGrantRepository {
  findActiveGrant(params: {
    tenantId: string | null
    connectorId: string
    userId: string
  }): Promise<import('@prisma/client').ConnectorGrant | null>
  findActiveByConnector(connectorId: string): Promise<import('@prisma/client').ConnectorGrant[]>
  findActiveForInactiveConnectors(
    userId: string,
    tenantId?: string | null,
  ): Promise<import('@prisma/client').ConnectorGrant[]>
  findByUser(
    userId: string,
    tenantId?: string | null,
  ): Promise<
    Array<
      import('@prisma/client').ConnectorGrant & {
        connector: {
          id: string
          name: string
          type: string
          lifecycleState: import('@prisma/client').ConnectorLifecycleState
        }
      }
    >
  >
  create(data: {
    tenantId: string | null
    connectorId: string
    userId: string
    scopes: import('@prisma/client').Prisma.JsonValue
    tokenRef: string
    accountLabel?: string | null
    expiresAt?: Date | null
  }): Promise<import('@prisma/client').ConnectorGrant>
  updateStatus(
    id: string,
    status: import('@prisma/client').ConnectorGrantStatus,
    extra?: { revokedAt?: Date; lastRefreshedAt?: Date; expiresAt?: Date | null },
  ): Promise<import('@prisma/client').ConnectorGrant>
  revokeAllForUser(userId: string): Promise<number>
  findById(id: string): Promise<import('@prisma/client').ConnectorGrant | null>
}

// ── Provisioning Assistant (Connector Onboarding) ───────────────────────────

export type ConnectorDraftWithConnector = ConnectorDraft & {
  connector: Connector
}

export interface CreateConnectorDraftInput {
  tenantId: string | null
  name: string
  connectorType?: ConnectorType
  authMode: ConnectorAuthMode
  sourceType: ConnectorDraftSourceType
  sourceRef: string | null
  sourceHash: string
  config: Prisma.InputJsonValue
  secretAliasSuggested: string | null
  generatedByAgentId: string | null
  generatedByAgentVersion: number | null
  generatedFromConversationId: string | null
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

/**
 * A provisioning draft-réteg repository-ja. KEMÉNY PADLÓ (CR-MVP-002, §6.2):
 * ezen az úton csak a `connectors (lifecycle_state IN draft,validated)` + a
 * `connector_drafts` sorok érhetők el íróan; capabilities / agent_connectors /
 * RBAC / Secret Manager SOSEM. Az `activate`/`assign` külön (emberi) metódus.
 */
export interface ConnectorDraftRepository {
  /** Tranzakciósan létrehoz egy `lifecycle_state=draft` connectort + draft-sort. */
  createDraft(input: CreateConnectorDraftInput): Promise<ConnectorDraftWithConnector>
  findById(draftId: string): Promise<ConnectorDraftWithConnector | null>
  findByConnectorId(connectorId: string): Promise<ConnectorDraftWithConnector | null>
  list(tenantId: string | null): Promise<ConnectorDraftWithConnector[]>
  /** Validációs eredmény mentése (a config-ot NEM módosítja). */
  setValidationResult(draftId: string, result: Prisma.InputJsonValue): Promise<ConnectorDraft>
  setReview(params: {
    draftId: string
    reviewStatus: ConnectorDraftReviewStatus
    reviewedById: string
  }): Promise<ConnectorDraft>
  setSandboxTestResult(draftId: string, ok: boolean): Promise<ConnectorDraft>
  /**
   * Aktiválás: a draft connectort `active`-ra állítja + a beinjektált secret
   * aliasát rögzíti + dual-control approver. CSAK emberi admin-API hívja (§8.5).
   * A `connectors.lifecycle_state draft|validated → active` átmenet KIZÁRÓLAG itt.
   */
  activate(params: {
    draftId: string
    secretAlias: string
    authMode: ConnectorAuthMode
    secondApproverId: string | null
    /** Opcionális config-frissítés aktiváláskor (pl. nem-titkos oauth2 clientId). */
    config?: import('@prisma/client').Prisma.InputJsonValue
  }): Promise<Connector>
  /** Connector → agent hozzárendelés (agent_connectors). CSAK emberi admin (§8.6). */
  assignToAgent(params: {
    connectorId: string
    agentId: string
    accessMode: ConnectorAccessMode
    secretAlias?: string | null
  }): Promise<void>
  /** Connector → agent hozzárendelés visszavonása (agent_connectors). CSAK emberi admin (§8.6). */
  unassignFromAgent(params: { connectorId: string; agentId: string }): Promise<{ removed: boolean }>
  /**
   * Draft/validated connector config-jának javító szerkesztése (CSAK emberi admin).
   * A gate-et resetteli: validationResult=null, reviewStatus=pending, sandboxTestOk=null —
   * hogy a módosított config újra végigmenjen a valid→review→sandbox kapun. Az aktív
   * connectort NEM érinti (a hívó service `lifecycle_state IN draft,validated`-re kapuz).
   */
  updateDraftConfig(params: {
    draftId: string
    config: import('@prisma/client').Prisma.InputJsonValue
    authMode: ConnectorAuthMode
    sourceHash: string
    secretAliasSuggested: string | null
  }): Promise<ConnectorDraftWithConnector>
  /**
   * Aktív connector visszanyitása draftba (CSAK emberi admin). A connector offline lesz
   * (Tool Broker `lifecycle_state != active` → deny), a gate resetelődik (review=pending,
   * sandbox=null, validation=null), így a javított config újra átmegy a teljes kapun.
   * Az agent-hozzárendeléseket és capability-ket NEM bontja — újraaktiváláskor a wiring áll.
   */
  reopen(params: { draftId: string }): Promise<Connector>
  /**
   * Aktív connector auditált megszüntetése (CSAK emberi admin): agent-kötések levétele,
   * aktív user-grantek visszavonása (revoked), majd lifecycle_state=archived. Nem hard-delete —
   * a connector-sor és az audit-előzmény megmarad. A secret-ref törlését a service intézi.
   * Visszaadja az érintett agentId-ket, hogy a hívó capability-syncet futtathasson.
   */
  decommission(params: { draftId: string }): Promise<{ connectorId: string; affectedAgentIds: string[] }>
  /** Aktív connector metaadat draft nélkül (leszerelés / admin ellenőrzés / assign-kapu). */
  findConnectorById(connectorId: string): Promise<{
    id: string
    tenantId: string | null
    lifecycleState: string
    secretAlias: string | null
    connectorMode: 'fixed' | 'self_updating'
    /** Aktív spec capability-set; self_updating assign-hoz kell. */
    activeCapabilitySet: unknown | null
  } | null>
  /** Draft nélküli (pl. seed-ből jött) aktív connector leszerelése — ugyanaz a lifecycle/audit út. */
  decommissionByConnectorId(params: {
    connectorId: string
  }): Promise<{ connectorId: string; affectedAgentIds: string[] }>
  /**
   * SOSEM aktivált draft (lifecycle_state IN draft,validated) végleges hard-delete-je
   * (CSAK emberi admin) — a botched draftok takarításához. A connector-sor törlése
   * kaszkádban viszi a draft-sort, agent_connectors/grantek sorait. Aktív connectorra tilos.
   */
  deleteDraft(params: { draftId: string }): Promise<void>
  /** Meglévő (aktivált) connector-katalógus metaadata, secret nélkül (§9 catalog.read). */
  listActiveCatalog(
    tenantId: string | null,
  ): Promise<Array<{ id: string; type: ConnectorType; name: string }>>
}

export type { ConnectorLifecycleState }

export type TransitionActor =
  | { type: 'human'; userId: string; role: UserRole }
  | { type: 'agent'; agentId: string }
  | { type: 'system' }

// ── IAM / RBAC (Feature-spec IAM-RBAC §3) ───────────────────────────────────

export interface UserRepository {
  findById(id: string): Promise<User | null>
  findByExternalAuthId(externalAuthId: string): Promise<User | null>
  /** Case-insensitive email lookup (pre-provision conflict checks). */
  findManyByEmail(email: string): Promise<User[]>
  findMany(filter?: {
    tenantId?: string | null
    status?: UserStatus
    role?: UserRole
    limit?: number
    offset?: number
    unbounded?: boolean
  }): Promise<User[]>
  /** Batch lookup for membership → user join (IAM tenant member list). */
  findManyByIds(ids: string[]): Promise<User[]>
  countActiveAdmins(tenantId: string | null, excludeUserId?: string): Promise<number>
  create(data: {
    externalAuthId: string
    email: string
    name: string
    role?: UserRole | null
    status?: UserStatus
    tenantId?: string | null
    invitedById?: string | null
  }): Promise<User>
  update(
    id: string,
    data: Partial<{
      externalAuthId: string
      role: UserRole | null
      status: UserStatus
      tenantId: string | null
      invitedById: string | null
      activatedAt: Date | null
      suspendedAt: Date | null
      suspendedById: string | null
      suspendedReason: string | null
      lastLoginAt: Date | null
      email: string
      name: string
      jobDescription: string | null
    }>,
  ): Promise<User>
  upsertByExternalAuthId(params: {
    externalAuthId: string
    create: {
      email: string
      name: string
      role?: UserRole | null
      status?: UserStatus
      tenantId?: string | null
    }
    update: Partial<{
      role: UserRole | null
      status: UserStatus
      activatedAt: Date
      invitedById: string | null
      tenantId: string | null
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
  /** Compare-and-set claim: exactly one concurrent redemption can win. */
  claimPendingRedemption(id: string, email: string, now: Date): Promise<Invitation | null>
  /** Compare-and-set revoke: never overwrite an already redeemed invitation. */
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
    data: Partial<{ status: InvitationStatus; redeemedAt: Date; revokedAt: Date; clerkInvitationId: string | null }>,
  ): Promise<Invitation>
}

export interface RolePermissionRepository {
  findAll(): Promise<RolePermission[]>
  findByKey(permissionKey: string): Promise<RolePermission | null>
  /** Batch permission lookup `permissionKey IN (...)`. */
  findByKeys(permissionKeys: string[]): Promise<RolePermission[]>
  upsert(permissionKey: string, minRole: UserRole, description?: string | null): Promise<RolePermission>
}

// ── Tenant Management (Feature-spec Tenant-Management §4, §10) ────────────────

export interface TenantRepository {
  findById(id: string): Promise<Tenant | null>
  /** Batch tenant lookup — tenant-switcher N×`findById` helyett. */
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
  /** A user összes tagsága (aktív-tenant feloldáshoz, tenant-switcherhez). */
  findByUser(userId: string): Promise<TenantMembership[]>
  findByTenant(tenantId: string, filter?: { status?: TenantMembershipStatus; role?: UserRole }): Promise<TenantMembership[]>
  /** Platform tenant IAM nézethez (§9.3): tenant tagok user e-mail/név mezőivel. */
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
  /** Idempotent activation for invitation delivery retries and concurrent sign-ins. */
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
  findByRole(role: PlatformRole, filter?: { status?: PlatformMembershipStatus }): Promise<PlatformMembership[]>
  /** Platform IAM nézethez (§9.3): minden platform-tag a user e-mail/név mezőivel. */
  findAll(): Promise<PlatformMembershipWithUser[]>
  upsert(data: { userId: string; role: PlatformRole; status?: PlatformMembershipStatus }): Promise<PlatformMembership>
  delete(userId: string, role: PlatformRole): Promise<void>
}

// ── Sandbox verziózás / promóció / graduation (Feature-spec §3) ──────────────

export type CreateSandboxProjectInput = {
  tenantId: string | null
  sandboxId: string | null
  name: string
  description: string | null
  dataBinding?: Prisma.InputJsonValue
  portability?: Prisma.InputJsonValue
}

export type SandboxProjectPointers = {
  testCommitId?: string | null
  liveCommitId?: string | null
  headCommitId?: string | null
}

export type CreateSandboxCommitInput = {
  tenantId: string | null
  projectId: string
  parentCommitId: string | null
  basedOnCommitId: string | null
  source: SandboxCommitSource
  changeSummary: string
  treeRef: string
  treeHash: string
  fileCount: number
  totalSizeBytes: number
  createdByType: SandboxActorType
  createdByUserId: string | null
  createdByAgentId: string | null
  createdFromTicketId: string | null
  createdFromRunId: string | null
  buildCost?: Prisma.InputJsonValue
}

export type CreateSandboxPromotionInput = {
  tenantId: string | null
  projectId: string
  fromCommitId: string
  prevLiveCommitId: string | null
  requestedByType: SandboxActorType
  requestedByUserId: string | null
  requestedByAgentId: string | null
  reason: string | null
}

export type CreateSandboxSnapshotInput = {
  tenantId: string | null
  projectId: string
  env: SandboxEnv
  kind: SandboxSnapshotKind
  status: SandboxSnapshotStatus
  snapshotRef: string
  schemaHash: string
  rowCount: number | null
  sizeBytes: number | null
  createdByType: SandboxActorType
  createdByUserId: string | null
  linkedPromotionId: string | null
  expiresAt: Date | null
}

export type CreateSandboxExportInput = {
  tenantId: string | null
  projectId: string
  scope: SandboxExportScope
  sourceCommitId: string
  sourceSnapshotId: string | null
  requestedByUserId: string
  manifest?: Prisma.InputJsonValue
  responsibilityTransferred: boolean
}

export interface SandboxVersioningRepository {
  // projekt
  createProject(input: CreateSandboxProjectInput): Promise<SandboxProject>
  findProjectById(id: string): Promise<SandboxProject | null>
  findProjectByName(tenantId: string | null, sandboxId: string | null, name: string): Promise<SandboxProject | null>
  listProjects(filter: { tenantId: string | null; sandboxId?: string; limit?: number }): Promise<SandboxProject[]>
  updateProjectPointers(id: string, pointers: SandboxProjectPointers): Promise<SandboxProject>
  archiveProject(id: string): Promise<SandboxProject>

  // commit (a `seq` kiosztás a repository felelőssége, tranzakcióban)
  createCommit(input: CreateSandboxCommitInput): Promise<SandboxCommit>
  findCommitById(id: string): Promise<SandboxCommit | null>
  findCommitByTreeHash(projectId: string, treeHash: string): Promise<SandboxCommit | null>
  listCommits(filter: { projectId: string; limit?: number; beforeSeq?: number }): Promise<SandboxCommit[]>

  // promóció
  createPromotion(input: CreateSandboxPromotionInput): Promise<SandboxPromotion>
  findPromotionById(id: string): Promise<SandboxPromotion | null>
  listPromotions(filter: { projectId: string; status?: SandboxPromotionStatus }): Promise<SandboxPromotion[]>
  updatePromotion(
    id: string,
    data: Partial<{
      status: SandboxPromotionStatus
      prePromotionSnapshotId: string | null
      approvedByUserId: string | null
      reason: string | null
      decidedAt: Date | null
      promotedAt: Date | null
    }>,
  ): Promise<SandboxPromotion>

  // adat-snapshot
  createSnapshot(input: CreateSandboxSnapshotInput): Promise<SandboxDataSnapshot>
  findSnapshotById(id: string): Promise<SandboxDataSnapshot | null>
  listSnapshots(filter: { projectId: string; env?: SandboxEnv }): Promise<SandboxDataSnapshot[]>
  updateSnapshot(
    id: string,
    data: Partial<{
      status: SandboxSnapshotStatus
      snapshotRef: string
      schemaHash: string
      rowCount: number | null
      sizeBytes: number | null
    }>,
  ): Promise<SandboxDataSnapshot>

  // export
  createExport(input: CreateSandboxExportInput): Promise<SandboxExport>
  findExportById(id: string): Promise<SandboxExport | null>
  listExports(filter: { projectId: string }): Promise<SandboxExport[]>
  updateExport(
    id: string,
    data: Partial<{
      status: SandboxExportStatus
      packageRef: string | null
      packageHash: string | null
      manifest: Prisma.InputJsonValue
      completedAt: Date | null
    }>,
  ): Promise<SandboxExport>
}

/**
 * Csatorna-bot tár (Telegram feature-spec #70/#71, D3/D14). A platform-bot a `tenantId = null`
 * sor; egyetlen platform-bot él csatorna-típusonként (a migráció részleges egyedi indexe
 * kényszeríti). A titok-referenciák (`accessKeySecretRef` / `webhookSecretRef`) NYERSEN sosem
 * hagyják el a szervert.
 */
export type CreateChannelBotInput = {
  channelType: ChannelType
  tenantId: string | null
  name: string
  accessKeySecretRef: string
  webhookSecretRef: string
  status?: ChannelBotStatus
  createdById: string | null
}

export type UpdateChannelBotInput = Partial<{
  name: string
  accessKeySecretRef: string
  webhookSecretRef: string
  status: ChannelBotStatus
}>

export interface ChannelBotRepository {
  /** A platform-szintű bot (tenantId IS NULL) az adott csatorna-típusra, vagy `null`. */
  findPlatformBot(channelType: ChannelType): Promise<ChannelBot | null>
  findById(id: string): Promise<ChannelBot | null>
  create(input: CreateChannelBotInput): Promise<ChannelBot>
  update(id: string, input: UpdateChannelBotInput): Promise<ChannelBot>
}

/**
 * Csatorna-identitás tár (Telegram feature-spec #70/#72, D2/D14). A külső fiók ↔ platform-
 * felhasználó kötés. A `lookupHash` a külső azonosító determinisztikus, egyedi kereső-hashe;
 * a nyers azonosító csak titkosítva (`externalUserIdEnc`). SZEREPKÖRT NEM tárol.
 */
export type CreateChannelIdentityInput = {
  channelType: ChannelType
  externalUserIdEnc: string
  lookupHash: string
  tenantId: string | null
  userId: string
}

export interface ChannelIdentityRepository {
  /** A (típus, kereső-hash) párra tartozó identitás bármely státusszal, vagy `null`. */
  findByLookupHash(channelType: ChannelType, lookupHash: string): Promise<ChannelIdentity | null>
  findById(id: string): Promise<ChannelIdentity | null>
  /** Egy felhasználó összes csatorna-kötése (profil-nézethez). */
  listByUser(userId: string): Promise<ChannelIdentity[]>
  /** Egy szervezet aktív kötései a tagok user-mezőivel (admin-nézethez). */
  listByTenantWithUsers(tenantId: string): Promise<Array<ChannelIdentity & { user: Pick<User, 'id' | 'name' | 'email'> }>>
  create(input: CreateChannelIdentityInput): Promise<ChannelIdentity>
  updateStatus(id: string, status: ChannelIdentityStatus): Promise<ChannelIdentity>
  /**
   * Re-link: egy korábban `revoked`/`blocked` (vagy más felhasználóhoz kötött) sor
   * újraaktiválása az új felhasználóra/szervezetre. A `(channelType, lookupHash)` egyedi,
   * ezért ugyanaz a külső fiók egyetlen sorként él tovább.
   */
  reactivate(
    id: string,
    input: { userId: string; tenantId: string | null; linkedAt: Date },
  ): Promise<ChannelIdentity>
}

/**
 * Csatorna-agent-engedély tár (Telegram feature-spec #70/#75, D5/D9/D13/D14). Egy sor = „ez a
 * kötött identitás elérheti ezt az agentet a csatornán, ezzel a projektkulccsal". Az admin
 * hozza létre / vonja vissza; a projektkulcsot a felhasználó állítja a weben. A `(identityId,
 * agentId)` egyedi — ugyanahhoz az agenthez egyetlen engedély tartozik identitásonként.
 */
export type CreateChannelAgentGrantInput = {
  identityId: string
  agentId: string
  projectKey?: string
  grantedById: string | null
}

export interface ChannelAgentGrantRepository {
  listByIdentity(identityId: string): Promise<ChannelAgentGrant[]>
  /** Egy szervezet összes kötésének engedélyei (admin-nézet, batch). */
  listByIdentityIds(identityIds: string[]): Promise<ChannelAgentGrant[]>
  /** Gyors kapu-kérdés (#73): van-e LEGALÁBB egy engedélyezett agent ehhez az identitáshoz? */
  hasAnyGrant(identityId: string): Promise<boolean>
  findByIdentityAndAgent(identityId: string, agentId: string): Promise<ChannelAgentGrant | null>
  create(input: CreateChannelAgentGrantInput): Promise<ChannelAgentGrant>
  updateProjectKey(id: string, projectKey: string): Promise<ChannelAgentGrant>
  deleteById(id: string): Promise<void>
  /**
   * Az identitáshoz tartozó, adott agentre szóló engedély (vagy `null`, ha nincs) — a #74
   * agent-chat forduló-feldolgozó alias-neve `findByIdentityAndAgent`-re.
   */
  findForIdentityAgent(identityId: string, agentId: string): Promise<ChannelAgentGrant | null>
  /**
   * Az identitás összes csatorna-engedélye (agent-váltáshoz / alapértelmezett kiválasztáshoz) —
   * a #74 agent-chat forduló-feldolgozó alias-neve `listByIdentity`-re.
   */
  listForIdentity(identityId: string): Promise<ChannelAgentGrant[]>
}

/**
 * Csatorna-munkamenet tár (Telegram feature-spec #70/#72, D8/D9/D15). A külső szál ↔
 * beszélgetés összerendelés; a `updateWatermark` a duplikáció-védelemhez, az
 * `unlinkedNoticeAt` a bekötetlen „egyszer válaszol, aztán csend" viselkedéshez.
 */
export type ChannelSessionUpdate = Partial<{
  identityId: string | null
  activeAgentId: string | null
  conversationId: string | null
  updateWatermark: bigint
  unlinkedNoticeAt: Date | null
  lastActivityAt: Date
}>

export interface ChannelSessionRepository {
  findById(id: string): Promise<ChannelSession | null>
  findByBotAndThread(botId: string, externalThreadId: string): Promise<ChannelSession | null>
  create(input: { botId: string; externalThreadId: string }): Promise<ChannelSession>
  update(id: string, data: ChannelSessionUpdate): Promise<ChannelSession>
}

/**
 * Csatorna-forduló (worker-munkasor) tár — a worker MÁSODIK munkatípusa (Telegram feature-spec
 * #70/#73/#74, D8/D14). A bejövő üzenet tartós sorba kerül, túléli a webhook-kérést, `attempts`
 * szerint újrapróbálható és `lastError` diagnosztizálható. A `claimNextBatch` atomi (a `queued`
 * sorokat `running`-ra billenti és megnöveli az `attempts`-et, a `staleRunningBefore`-nál régebbi
 * elszállt `running` sorokat is visszaveszi), így egyszerre több worker sem dolgoz fel egy sort
 * kétszer, és egy crash-elakadt sor sem ragad örökre `running`-ban.
 */
export type EnqueueChannelTurnInput = {
  sessionId: string
  inboundRef?: string | null
  inboundText: string | null
  inboundKind: 'text' | 'unsupported'
}

export interface ChannelTurnRepository {
  enqueue(input: EnqueueChannelTurnInput): Promise<ChannelTurn>
  findById(id: string): Promise<ChannelTurn | null>
  /**
   * Legfeljebb `limit` `queued` (vagy elavultan `running`) fordulót foglal le: `running`-ra
   * billenti, megnöveli az `attempts`-et. A visszaadott sorok e worker tulajdonában vannak.
   * A `staleRunningBefore` előtt frissült `running` sorokat is visszaveszi (elszállt worker).
   */
  claimNextBatch(input: { limit: number; now: Date; staleRunningBefore: Date }): Promise<ChannelTurn[]>
  markDone(id: string): Promise<ChannelTurn>
  /** Újrapróbálható hiba: `queued`-re állítja vissza (a worker legközelebb újra felveszi). */
  markRetry(id: string, error: string): Promise<ChannelTurn>
  /** Végleges hiba (kimerült próbálkozások): `failed`. */
  markFailed(id: string, error: string): Promise<ChannelTurn>
}

/**
 * Deep-link összekötő token tár (Telegram feature-spec #70/#72, D12). Egyszer-használatos:
 * a `consume` atomi billentés (verseny-biztos), a második beváltás nem hoz létre kötést.
 */
export type CreateChannelLinkTokenInput = {
  channelType: ChannelType
  jti: string
  signature: string
  userId: string
  tenantId: string | null
  expiresAt: Date
  createdById: string | null
}

export interface ChannelLinkTokenRepository {
  create(input: CreateChannelLinkTokenInput): Promise<ChannelLinkToken>
  findByJti(jti: string): Promise<ChannelLinkToken | null>
  /**
   * Atomi egyszer-használat: CSAK akkor jelöli elhasználtnak (és rögzíti a beváltó
   * kereső-hashét), ha még nincs elhasználva. `null` = már elhasznált / nem létezik.
   */
  consume(jti: string, consumedByLookupHash: string, now: Date): Promise<ChannelLinkToken | null>
}

/**
 * Platform-oldali felhasználói értesítés tár (Telegram feature-spec #70/#72, D12 story 3).
 */
export type CreateUserNotificationInput = {
  userId: string
  tenantId: string | null
  kind: string
  title: string
  body: string
  metadata?: Prisma.InputJsonValue
}

export interface UserNotificationRepository {
  create(input: CreateUserNotificationInput): Promise<UserNotification>
  listForUser(userId: string, limit?: number): Promise<UserNotification[]>
  markRead(id: string, userId: string, now: Date): Promise<UserNotification | null>
}

/**
 * A bot SAJÁT kimenő üzeneteinek nyilvántartása a megőrzési takarításhoz (Telegram
 * feature-spec #70/#78, D4). CSAK a bot által küldött üzenetek `providerMessageId`-ját
 * tartja (nyers tartalom NÉLKÜL) — privát chatben a bot csak a magáét tudja törölni.
 */
export type RecordChannelOutboundInput = {
  sessionId: string
  channelType: ChannelType
  externalThreadId: string
  providerMessageId: string
  kind?: string | null
  sentAt?: Date
}

export interface ChannelOutboundMessageRepository {
  /** Egy elküldött bot-üzenet rögzítése (a `providerMessageId` a későbbi `deleteMessage`-hez). */
  record(input: RecordChannelOutboundInput): Promise<ChannelOutboundMessage>
  /**
   * A megőrzési horizonton túli, még NEM takarított kimenő üzenetek (sentAt < cutoff,
   * purgedAt IS NULL), a legrégebbitől, legfeljebb `limit` darab.
   */
  listExpired(cutoff: Date, limit: number): Promise<ChannelOutboundMessage[]>
  /** Takarítottnak jelöli az üzenetet (idempotens — a `deleteMessage` után vagy ha már nincs meg). */
  markPurged(id: string, purgedAt: Date): Promise<void>
}

/**
 * Eseményvezérelt jóváhagyás gombokkal — a kiküldött gombüzenetek tára (Telegram feature-spec
 * #70/#76, D5/D6/D14). EGY sor = EGY címzettnek kiküldött gombüzenet. A `consume` atomi
 * `pending`→`decided` billentése kényszeríti az EGYSZER-használatot (verseny-biztos): a
 * kettős koppintás második ága nem billent, `null`-t kap vissza. A `supersedeOthers` a többi
 * címzett még nyitott gombjait érvényteleníti, ha valaki már döntött (a többi koppintás így
 * „már eldöntötte valaki" tájékoztatást kap, nem kettős hatást).
 */
export type CreateChannelApprovalPromptInput = {
  promptId: string
  channelType: ChannelType
  ticketId: string
  tenantId: string | null
  gateId: string | null
  stepId: string | null
  requiredActorRole: string | null
  recipientIdentityId: string
  recipientUserId: string
  initiatorUserId: string | null
  allowedActions: string[]
  externalThreadId: string
}

export interface ChannelApprovalPromptRepository {
  create(input: CreateChannelApprovalPromptInput): Promise<ChannelApprovalPrompt>
  findByPromptId(promptId: string): Promise<ChannelApprovalPrompt | null>
  /** A kiküldött gombüzenet provider-azonosítójának rögzítése (a döntés utáni szerkesztéshez). */
  setProviderMessageId(id: string, providerMessageId: string): Promise<void>
  /**
   * Atomi egyszer-használat: CSAK akkor billenti `decided`-re (és rögzíti a döntést + a beváltó
   * kereső-hashét), ha még `pending`. `null` = már nem `pending` (kettős koppintás / verseny).
   */
  consume(
    promptId: string,
    action: string,
    decidedByLookupHash: string,
    now: Date,
  ): Promise<ChannelApprovalPrompt | null>
  /** A ticket többi, még `pending` gombját `superseded`-re állítja (kivéve a megadott promptId-t). */
  supersedeOthers(ticketId: string, exceptPromptId: string): Promise<void>
}

/**
 * A csatorna-táblák állapot-olvasásai az üzemeltetői metrikákhoz (Telegram feature-spec
 * #70/#78, story 59). CSAK aggregáló olvasások — nyers külső azonosítót nem adnak vissza.
 */
export interface ChannelMetricsRepository {
  countTurnsByStatus(since?: Date): Promise<Record<string, number>>
  countSessions(): Promise<{ total: number; linked: number }>
  countIdentitiesByStatus(): Promise<Record<string, number>>
  countPendingOutbound(): Promise<{ pending: number; oldestSentAt: Date | null }>
}

// ── Agent-hozzáférési gráf (Access-Policy §agent-scope, issue #142) ──────────

/** Egy él két igéje. A `canView` és a `canAddress` FÜGGETLEN boolean, nem skála. */
export type AgentAccessVerbs = { canView: boolean; canAddress: boolean }

/** Egy subject→target pár azonosítása (feloldás, bővítés, szűkítés, törlés). */
export type AgentAccessGrantKey = {
  tenantId: string
  subjectType: AgentAccessSubjectType
  subjectUserId?: string | null
  subjectAgentId?: string | null
  targetAgentId: string
}

/**
 * A tenant-invariáns megsértésének tipizált okai. Ezt PostgreSQL `CHECK` nem tudja
 * kifejezni (cross-table), ezért a tár TRANZAKCIÓBAN ellenőrzi — fail-closed: hibás
 * vagy elavult bemenetnél nem jön létre él.
 */
export type AgentAccessGrantWriteFailure =
  | 'subject_not_in_tenant'
  | 'target_not_in_tenant'
  | 'self_edge'
  | 'no_verb'

export type AgentAccessGrantWriteResult =
  | {
      ok: true
      grant: AgentAccessGrant
      previous: AgentAccessVerbs | null
    }
  | { ok: false; reason: AgentAccessGrantWriteFailure }

export type AgentAccessGrantDeleteResult =
  | { ok: true; previous: AgentAccessVerbs; grantId: string }
  | { ok: false; reason: 'not_found' }

/**
 * Az él-írás audit-eseményét a HÍVÓ állítja össze, de a tár írja — ugyanabban a
 * tranzakcióban, mint magát az élt (a spec „tranzakciós/outbox határ" követelménye).
 * Így nincs olyan állapot, ahol a policy megváltozott, de nyoma nincs.
 */
export type AgentAccessAuditBuilder = (change: {
  grantId: string
  previous: AgentAccessVerbs | null
  next: AgentAccessVerbs
}) => Parameters<AuditRepository['append']>[0]

export type UpsertAgentAccessGrantInput = AgentAccessGrantKey & {
  canView: boolean
  canAddress: boolean
  grantedById: string
  buildAudit: AgentAccessAuditBuilder
}

/**
 * Az agent-hozzáférési gráf éleinek tára. MINDEN olvasás tenant-scope-olt — a
 * tenant-határ abszolút (I7), ezért a tár szintjén sincs tenant nélküli lekérdezés.
 *
 * A batch-olvasások (`listBySubject`, `listAgentEdgesForTenant`) a listás
 * chokepointok és az elérhetőségi kúp N+1-mentes kiszolgálásához vannak: egy
 * tucat–pár száz agentes tenantnál a teljes gráf EGY indexelt lekérdezés.
 */
export interface AgentAccessGrantRepository {
  /** Egy konkrét subject→target él, vagy `null`. */
  findEdge(key: AgentAccessGrantKey): Promise<AgentAccessGrant | null>
  /**
   * Egy subject KIMENŐ élei a tenantban (lista-szűrés, Focus-panel): user alanynál a
   * `subjectUserId`, agent alanynál a `subjectAgentId` szerint.
   */
  listBySubject(key: Omit<AgentAccessGrantKey, 'targetAgentId'>): Promise<AgentAccessGrant[]>
  /** Egy cél BEJÖVŐ élei a tenantban (ki érheti el ezt az agentet). */
  listByTarget(tenantId: string, targetAgentId: string): Promise<AgentAccessGrant[]>
  /** A tenant MINDEN `agent` alanyú éle — az elérhetőségi kúp bejárásához. */
  listAgentEdgesForTenant(tenantId: string): Promise<AgentAccessGrant[]>
  /** A tenant MINDEN éle (admin org-ábra betöltés). */
  listForTenant(tenantId: string): Promise<AgentAccessGrant[]>
  /**
   * Létrehozás vagy bővítés/szűkítés EGY sorban (subject→target páronként legfeljebb
   * egy él), a cross-table tenant-invariáns tranzakciós ellenőrzésével és az audit
   * atomi írásával. Visszaadja az előző értékeket, hogy az audit a „mi változott"-at
   * pontosan rögzíthesse.
   */
  upsertEdge(input: UpsertAgentAccessGrantInput): Promise<AgentAccessGrantWriteResult>
  /**
   * Az él törlése (mindkét ige levétele) + audit ugyanabban a tranzakcióban.
   * A `buildAudit` `next` értéke ilyenkor `{ canView: false, canAddress: false }`.
   */
  deleteEdge(
    key: AgentAccessGrantKey & { buildAudit: AgentAccessAuditBuilder },
  ): Promise<AgentAccessGrantDeleteResult>
}
