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
  Prisma,
  Recipe,
  RecipeScope,
  RecipeTicketType,
  RecipeVersion,
  SandboxApp,
  SandboxAppVersion,
  Playbook,
  PlaybookVersion,
  ToolCall,
  Ticket,
  TicketState,
  TicketTransition,
  UserRole,
} from '@prisma/client'

export type TicketFilter = {
  state?: TicketState | TicketState[]
  type?: Ticket['type']
  agentId?: string
}

export interface TicketRepository {
  findMany(filter?: TicketFilter): Promise<Ticket[]>
  findReadyForDispatch(now: Date, limit: number): Promise<Ticket[]>
  findStaleInProgressDispatches(cutoff: Date, limit: number): Promise<Ticket[]>
  findById(id: string): Promise<Ticket | null>
  create(
    data: Omit<
      Ticket,
      'id' | 'createdAt' | 'updatedAt' | 'lockToken' | 'lockedAt' | 'playbookRef' | 'conversationId'
    > &
      Partial<Pick<Ticket, 'lockToken' | 'lockedAt' | 'playbookRef' | 'conversationId'>>,
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
}

export interface AuditRepository {
  append(data: Omit<AuditLog, 'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash'>): Promise<AuditLog>
  findMany(filter?: { action?: string; limit?: number }): Promise<AuditLog[]>
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

export interface SandboxAppRepository {
  findByIdWithLatestVersion(appId: string): Promise<SandboxAppWithLatestVersion | null>
  findLatestByTicketId(ticketId: string): Promise<SandboxAppWithLatestVersion | null>
  createFromTicket(input: {
    name: string
    htmlContent: string
    htmlHash: string
    sourceTicketId: string
    createdBy: string
    tenantId: string | null
  }): Promise<SandboxAppWithLatestVersion>
  addVersion(input: {
    appId: string
    htmlContent: string
    htmlHash: string
    sourceTicketId: string
    createdBy: string
  }): Promise<SandboxAppWithLatestVersion>
}

export type TransitionActor =
  | { type: 'human'; userId: string; role: UserRole }
  | { type: 'agent'; agentId: string }
  | { type: 'system' }
