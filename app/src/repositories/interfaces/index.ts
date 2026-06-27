import type {
  Agent,
  AuditLog,
  Connector,
  ConnectorAccessMode,
  ConnectorType,
  Conversation,
  Document,
  Message,
  MessageRole,
  ModelCall,
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
  ToolCall,
  Ticket,
  TicketSource,
  TicketState,
  TicketTransition,
  UserRole,
} from '@prisma/client'

export type TicketFilter = {
  tenantId?: string | null
  state?: TicketState | TicketState[]
  type?: Ticket['type']
  agentId?: string
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
    > &
      Partial<
        Pick<Ticket, 'tenantId' | 'lockToken' | 'lockedAt' | 'playbookRef' | 'conversationId' | 'source'>
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
  findMany(): Promise<Agent[]>
  findById(id: string): Promise<Agent | null>
  findByIdWithDetails(id: string): Promise<{
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
  }): Promise<{ agent: Agent; apiKey: string }>
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
  append(data: Omit<AuditLog, 'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash'>): Promise<AuditLog>
  findMany(filter?: {
    action?: string
    targetType?: string
    targetId?: string
    limit?: number
  }): Promise<AuditLog[]>
  findAll(): Promise<AuditLog[]>
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
  /** Aggregate Gateway metrics for the governance dashboard (§11: hatékonyság + költség). */
  getGovernanceSummary(since?: Date): Promise<ModelCallGovernanceSummary>
  /** Per-ticket Gateway usage breakdown, most recent first. */
  getPerTicketBreakdown(since?: Date, limit?: number): Promise<ModelCallTicketBreakdown[]>
}

export interface ToolBrokerRepository {
  findCapability(agentId: string, toolName: string): Promise<{ allowed: boolean } | null>
  findConnectorForAgent(
    agentId: string,
    type: ConnectorType,
    accessMode: ConnectorAccessMode,
  ): Promise<Connector | null>
  findCapabilitiesForAgent(agentId: string): Promise<{ toolName: string; allowed: boolean }[]>
  findConnectorsForAgent(agentId: string): Promise<{ connector: Connector; accessMode: ConnectorAccessMode }[]>
  findDocumentsForConnector(
    connectorId: string,
  ): Promise<{ id: string; filename: string; extractedText: string | null }[]>
  createToolCall(data: Omit<ToolCall, 'id' | 'createdAt'>): Promise<ToolCall>
  getToolSummary(since?: Date): Promise<{ calls: number; denied: number; errors: number }>
  /** Tool-call counts keyed by ticket id for the governance per-ticket breakdown (§11). */
  getToolCallCountsByTicket(since?: Date): Promise<Record<string, number>>
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

export interface ConversationRepository {
  create(data: {
    tenantId: string | null
    agentId: string
    title?: string | null
    createdById: string
  }): Promise<Conversation>
  findById(id: string): Promise<Conversation | null>
  findByIdForTenant(id: string, tenantId: string | null): Promise<Conversation | null>
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
    agentVersion?: number | null
    model?: string | null
    ticketRefId?: string | null
  }): Promise<Message>
  findMessages(conversationId: string): Promise<Array<Message & { content: string | null }>>
  findMessageById(id: string): Promise<Message | null>
  deleteMessageContent(messageId: string): Promise<Message>
  linkMessageToTicket(messageId: string, ticketId: string): Promise<Message>
}

export type SandboxAppWithLatestVersion = SandboxApp & {
  versions: SandboxAppVersion[]
}

export type SandboxAppListItem = SandboxApp & {
  activeVersion: SandboxAppVersion | null
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

export type TransitionActor =
  | { type: 'human'; userId: string; role: UserRole }
  | { type: 'agent'; agentId: string }
  | { type: 'system' }
