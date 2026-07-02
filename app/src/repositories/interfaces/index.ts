import type {
  Agent,
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
  SandboxApp,
  SandboxAppCriticality,
  SandboxAppStatus,
  SandboxAppVersion,
  SandboxCreatedByType,
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
  DelegationEdge,
  DelegationStatus,
  ProcessActorType,
  ToolCall,
  Ticket,
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
}

export interface TicketRepository {
  findMany(filter?: TicketFilter): Promise<Ticket[]>
  findReadyForDispatch(now: Date, limit: number): Promise<Ticket[]>
  findStaleInProgressDispatches(cutoff: Date, limit: number): Promise<Ticket[]>
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
        >
      >,
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
      >
    >,
  ): Promise<Ticket>
  acquireDispatchLock(id: string, lockToken: string, now: Date): Promise<Ticket | null>
  releaseDispatchLock(id: string, lockToken: string): Promise<void>
  completeDispatchLock(id: string, lockToken: string): Promise<Ticket | null>
  recordTransition(data: Omit<TicketTransition, 'id' | 'ts'>): Promise<TicketTransition>
  findTransitions(ticketId: string): Promise<TicketTransition[]>
  /** Transition statistics for the governance dashboard (§11: kontroll — jóváhagyott vs. automatikus lépések, visszadobási arány). */
  getTransitionStats(since?: Date): Promise<TransitionStats>
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
  markMaterialized(
    id: string,
    ticketId: string,
    data: {
      status: ScheduledTaskStatus
      runCount: number
      lastRunAt: Date
      materializedAt: Date
      nextRunAt: Date
    },
  ): Promise<ScheduledTask | null>
  revoke(id: string): Promise<ScheduledTask>
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
  markSignalEscalated(id: string, ticketId: string, now: Date): Promise<void>
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

export interface AgentRepository {
  findMany(filter?: { tenantId?: string | null }): Promise<Agent[]>
  findById(id: string, tenantId?: string | null): Promise<Agent | null>
  findByIdWithDetails(id: string, tenantId?: string | null): Promise<{
    agent: Agent
    memoryContent: string | null
    memoryVersion: number | null
    recipe: { name: string; ticketType: string; version: number; status: string } | null
    resources: { id: string; name: string; type: string; scope: string; version: number; accessMode: string }[]
    apiKeyPreview: string | null
  } | null>
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
  updateSelfEvolutionProfile(input: {
    agentId: string
    profile: Agent['selfEvolutionProfile']
  }): Promise<Agent>
  rotateApiKey(agentId: string): Promise<{ keyId: string; apiKey: string; scopes: string[] }>
  revokeApiKey(keyId: string): Promise<{ keyId: string; agentId: string }>
  delete(agentId: string): Promise<{ id: string; name: string }>
  authenticateApiKey(rawKey: string): Promise<{ agentId: string; scopes: string[] } | null>
}

export interface DocumentRepository {
  findById(id: string): Promise<Document | null>
  findByConnectorId(connectorId: string): Promise<Document[]>
  create(data: Omit<Document, 'id' | 'createdAt'>): Promise<Document>
  update(
    id: string,
    data: Partial<Pick<Document, 'status' | 'extractedText' | 'connectorId'>>,
  ): Promise<Document>
  delete(id: string): Promise<void>
}

export interface PlatformSettingsRepository {
  get(key: string): Promise<unknown | null>
  set(key: string, value: Prisma.InputJsonValue, updatedById?: string | null): Promise<void>
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
  /** Teljes lánc vagy egy [fromSeq..toSeq] szegmens, seq szerint rendezve (§6.3 részleges verifikáció). */
  findAll(range?: { fromSeq?: bigint; toSeq?: bigint }): Promise<AuditLog[]>
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
}

export type ModelCallTicketBreakdown = {
  ticketId: string
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
  /** Find all applicable budgets for a given call context, from most-specific to least-specific. */
  findApplicable(filter: { tenantId?: string; agentId?: string; ticketType?: string }): Promise<ModelBudget[]>
}

export { ModelBudgetPeriod, ModelBudgetScope, ModelRoutingScope }

export interface ToolBrokerRepository {
  findCapability(agentId: string, toolName: string): Promise<{ allowed: boolean } | null>
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
  findConnectorsForAgent(agentId: string): Promise<{ connector: Connector; accessMode: ConnectorAccessMode; agentSecretAlias: string | null }[]>
  findDocumentsForConnector(
    connectorId: string,
  ): Promise<{ id: string; filename: string; extractedText: string | null }[]>
  createToolCall(data: Omit<ToolCall, 'id' | 'createdAt'>): Promise<ToolCall>
  getToolSummary(since?: Date): Promise<{ calls: number; denied: number; errors: number }>
  /** Tool-call counts keyed by ticket id for the governance per-ticket breakdown (§11). */
  getToolCallCountsByTicket(since?: Date): Promise<Record<string, number>>
  /** Web Search rate-limit (maxQueriesPerTicket) — Feature-spec WebSearchTool §5.4. */
  countToolCallsForTicket(ticketId: string, toolName: string): Promise<number>
  /** Web Search rate-limit (maxQueriesPerAgentDay) — Feature-spec WebSearchTool §5.4. */
  countToolCallsForAgentSince(agentId: string, toolName: string, since: Date): Promise<number>
  /** Governance/agent-card nézethez — Feature-spec WebSearchTool §7.1/§7.3. */
  listToolCallsByName(
    toolName: string,
    filter?: { agentId?: string; since?: Date },
    limit?: number,
  ): Promise<ToolCall[]>
}

export type RecipeWithVersions = Recipe & { versions: RecipeVersion[] }

export interface RecipeRepository {
  list(): Promise<RecipeWithVersions[]>
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

export type PlaybookV2WithVersions = PlaybookV2 & { versions: PlaybookVersionV2[] }

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
}

export type CreatePlaybookAssignmentInput = {
  tenantId: string | null
  playbookId: string
  playbookVersionId: string
  assignmentType: string
  assignmentKey: string
  isDefault: boolean
  createdById: string
}

export interface PlaybookV2Repository {
  createPlaybook(input: CreatePlaybookV2Input): Promise<PlaybookV2>
  findPlaybook(tenantId: string | null, id: string): Promise<PlaybookV2 | null>
  findPlaybookByKey(tenantId: string | null, key: string): Promise<PlaybookV2 | null>
  listPlaybooks(tenantId: string | null): Promise<PlaybookV2WithVersions[]>
  updatePlaybook(
    id: string,
    data: Partial<{
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
      validationResult: Prisma.InputJsonValue
      compiledSpec: Prisma.InputJsonValue
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

  /** Tranzakció: ha isDefault, a (tenant, type, key) párra létező aktív default-ot revoke-olja. */
  createAssignment(input: CreatePlaybookAssignmentInput): Promise<PlaybookAssignment>
  findDefaultAssignment(
    tenantId: string | null,
    assignmentType: string,
    assignmentKey: string,
  ): Promise<PlaybookAssignment | null>
}

// --- Fázis 2 Playbook process runtime (Feature-spec — Playbook §4.5–4.7, §8.2) ---

export type CreateProcessInstanceInput = {
  tenantId: string | null
  processType: string
  playbookId: string
  playbookVersionId: string
  playbookRef: string
  playbookContentHash: string
  startedByType: ProcessActorType
  startedByUserId?: string | null
  startedByAgentId?: string | null
  conversationId?: string | null
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
  listProcesses(tenantId: string | null): Promise<ProcessInstance[]>
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

export interface ConversationRepository {
  create(data: {
    tenantId: string | null
    agentId: string
    title?: string | null
    createdById: string
    retentionPolicyId?: string | null
    legalHold?: boolean
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
  findByUser(
    userId: string,
    tenantId?: string | null,
  ): Promise<
    Array<
      import('@prisma/client').ConnectorGrant & {
        connector: { id: string; name: string; type: string }
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
  findMany(filter?: { tenantId?: string | null; status?: UserStatus; role?: UserRole }): Promise<User[]>
  countActiveAdmins(tenantId: string | null, excludeUserId?: string): Promise<number>
  create(data: {
    externalAuthId: string
    email: string
    name: string
    role?: UserRole | null
    status?: UserStatus
    tenantId?: string | null
  }): Promise<User>
  update(
    id: string,
    data: Partial<{
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
  findMany(filter?: { tenantId?: string | null; status?: InvitationStatus }): Promise<Invitation[]>
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
    data: Partial<{ status: InvitationStatus; redeemedAt: Date; revokedAt: Date }>,
  ): Promise<Invitation>
}

export interface RolePermissionRepository {
  findAll(): Promise<RolePermission[]>
  findByKey(permissionKey: string): Promise<RolePermission | null>
  upsert(permissionKey: string, minRole: UserRole, description?: string | null): Promise<RolePermission>
}
