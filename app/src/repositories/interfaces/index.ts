import type {
  Agent,
  AuditLog,
  Connector,
  ConnectorAccessMode,
  ConnectorType,
  Document,
  ModelCall,
  Prisma,
  Recipe,
  RecipeScope,
  RecipeTicketType,
  RecipeVersion,
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
  findById(id: string): Promise<Ticket | null>
  create(
    data: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'lockToken' | 'lockedAt'> &
      Partial<Pick<Ticket, 'lockToken' | 'lockedAt'>>,
  ): Promise<Ticket>
  update(
    id: string,
    data: Partial<
      Pick<Ticket, 'state' | 'payload' | 'assigneeType' | 'assigneeId' | 'lockToken' | 'lockedAt'>
    >,
  ): Promise<Ticket>
  acquireDispatchLock(id: string, lockToken: string, now: Date): Promise<Ticket | null>
  releaseDispatchLock(id: string, lockToken: string): Promise<void>
  recordTransition(data: Omit<TicketTransition, 'id' | 'ts'>): Promise<TicketTransition>
  findTransitions(ticketId: string): Promise<TicketTransition[]>
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
  create(input: {
    name: string
    roleDescription: string
    systemPrompt: string
    modelConfig: Agent['modelConfig']
    initialMemory?: string
    createdById: string
  }): Promise<{ agent: Agent; apiKey: string }>
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
}

export interface ModelCallRepository {
  create(data: Omit<ModelCall, 'id' | 'createdAt'>): Promise<ModelCall>
  getCostSummary(since?: Date): Promise<{ tokens: number; cost: number }>
  getUsageForAgentSince(agentId: string, since: Date): Promise<{ calls: number; tokens: number }>
  getUsageForTicket(ticketId: string): Promise<{ calls: number; tokens: number }>
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

export type TransitionActor =
  | { type: 'human'; userId: string; role: UserRole }
  | { type: 'agent'; agentId: string }
  | { type: 'system' }
