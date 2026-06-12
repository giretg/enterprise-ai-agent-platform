import type {
  Agent,
  AuditLog,
  Document,
  ModelCall,
  Ticket,
  TicketState,
  UserRole,
} from '@prisma/client'

export type TicketFilter = {
  state?: TicketState | TicketState[]
  type?: Ticket['type']
  agentId?: string
}

export interface TicketRepository {
  findMany(filter?: TicketFilter): Promise<Ticket[]>
  findById(id: string): Promise<Ticket | null>
  create(data: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt'>): Promise<Ticket>
  update(id: string, data: Partial<Pick<Ticket, 'state' | 'payload' | 'assigneeType' | 'assigneeId'>>): Promise<Ticket>
}

export interface AgentRepository {
  findMany(): Promise<Agent[]>
  findById(id: string): Promise<Agent | null>
  findByIdWithDetails(id: string): Promise<{
    agent: Agent
    memoryContent: string | null
    memoryVersion: number | null
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
  create(data: Omit<Document, 'id' | 'createdAt'>): Promise<Document>
  update(id: string, data: Partial<Pick<Document, 'status' | 'extractedText'>>): Promise<Document>
}

export interface AuditRepository {
  append(data: Omit<AuditLog, 'id' | 'seq' | 'createdAt'>): Promise<AuditLog>
  findMany(filter?: { action?: string; limit?: number }): Promise<AuditLog[]>
}

export interface ModelCallRepository {
  create(data: Omit<ModelCall, 'id' | 'createdAt'>): Promise<ModelCall>
  getCostSummary(since?: Date): Promise<{ tokens: number; cost: number }>
}

export type TransitionActor =
  | { type: 'human'; userId: string; role: UserRole }
  | { type: 'agent'; agentId: string }
  | { type: 'system' }
