/** A worker adatmodellje (§5.1) — a motor ezen az interfészen át dolgozik, így tesztben memóriában fut. */

export type TurnStatus = 'queued' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'cancelled'
export const ACTIVE_TURN_STATUSES: readonly TurnStatus[] = ['queued', 'running', 'awaiting_approval']

export type Conversation = {
  id: string
  tenantId: string
  tenantSlug: string
  userId: string
  agentId: string
  agentName: string
  title: string
  titleSetByUser: boolean
  createdAt: Date
  lastActivityAt: Date
}

export type AttachmentRef = { id: string; name: string; mime: string; size: number }

export type Message = {
  id: string
  conversationId: string
  turnId: string | null
  role: 'user' | 'assistant'
  content: string
  attachments: AttachmentRef[]
  createdAt: Date
}

export type PendingApproval = {
  seq: number
  requestState: string
  inputKey: string
  message: string
  createdAt: string
  decision?: 'approve' | 'reject'
}

export type TurnContext = {
  definition: string
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
}

export type Turn = {
  id: string
  conversationId: string
  tenantId: string
  userId: string
  agentId: string
  status: TurnStatus
  stepCount: number
  tokenUsage: { promptTokens?: number; completionTokens?: number; costUsd?: number }
  error: string | null
  continuationToken: string | null
  context: TurnContext | null
  pendingApproval: PendingApproval | null
  createdAt: Date
  finishedAt: Date | null
}

export type StepKind = 'llm' | 'tool'
export type StepStatus = 'running' | 'done' | 'awaiting_approval'

export type LlmStepOutput = {
  content: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
}
export type ToolStepOutput = { callId: string; name: string; text: string; isError: boolean }

export type Step = {
  turnId: string
  seq: number
  kind: StepKind
  inputHash: string
  output: LlmStepOutput | ToolStepOutput | null
  status: StepStatus
  attempts: number
  idempotencyKey: string | null
}

export type EventType = 'delta' | 'status' | 'tool' | 'approval' | 'done' | 'error'
export type TurnEvent = { turnId: string; seq: number; type: EventType; payload: Record<string, unknown>; createdAt: Date }

export type Attachment = AttachmentRef & {
  conversationId: string
  storagePath: string
  extractedText: string | null
}

export interface Store {
  // beszélgetések
  createConversation(input: Omit<Conversation, 'id' | 'createdAt' | 'lastActivityAt' | 'title' | 'titleSetByUser'>): Promise<Conversation>
  getConversation(id: string): Promise<Conversation | null>
  listConversations(input: {
    tenantId: string
    userId?: string
    agentId?: string
    query?: string
    limit: number
  }): Promise<Conversation[]>
  renameConversation(id: string, title: string, byUser: boolean): Promise<void>
  deleteConversation(id: string): Promise<void>
  touchConversation(id: string): Promise<void>

  // üzenetek
  addMessage(input: Omit<Message, 'id' | 'createdAt'>): Promise<Message>
  listMessages(conversationId: string, limit?: number): Promise<Message[]>

  // fordulók
  /** null = már fut egy forduló ebben a beszélgetésben (§5.2/6). */
  createTurn(input: { conversationId: string; tenantId: string; userId: string; agentId: string }): Promise<Turn | null>
  getTurn(id: string): Promise<Turn | null>
  activeTurn(conversationId: string): Promise<Turn | null>
  updateTurn(id: string, patch: Partial<Pick<Turn, 'status' | 'stepCount' | 'tokenUsage' | 'error' | 'continuationToken' | 'context' | 'pendingApproval' | 'finishedAt'>>): Promise<void>
  /** Feltételes állapotváltás (pl. cancel csak aktív fordulón). */
  transitionTurn(id: string, from: readonly TurnStatus[], to: TurnStatus, patch?: Partial<Pick<Turn, 'error' | 'finishedAt' | 'pendingApproval' | 'continuationToken'>>): Promise<boolean>
  /** Rövid bérlet a lépés futtatására; false = valaki más dolgozik rajta. */
  claimTurn(id: string, leaseSeconds: number): Promise<boolean>
  releaseTurn(id: string): Promise<void>

  // lépések
  listSteps(turnId: string): Promise<Step[]>
  /** Lépés-sor indítása vagy újrapróbálása: attempts++ ; a kész lépést nem írja felül. */
  beginStep(input: { turnId: string; seq: number; kind: StepKind; inputHash: string; idempotencyKey: string | null }): Promise<Step>
  finishStep(turnId: string, seq: number, status: StepStatus, output: Step['output']): Promise<void>

  // események
  appendEvent(turnId: string, type: EventType, payload: Record<string, unknown>): Promise<number>
  eventsAfter(turnId: string, afterSeq: number, limit?: number): Promise<TurnEvent[]>
  pruneOldEvents(olderThanDays: number): Promise<void>

  // csatolmányok
  addAttachment(input: Omit<Attachment, 'id'>): Promise<Attachment>
  getAttachments(conversationId: string, ids: string[]): Promise<Attachment[]>
  listAttachmentPaths(conversationId: string): Promise<string[]>

  // admin-betekintés
  logAdminView(input: { tenantId: string; adminUserId: string; conversationId: string }): Promise<void>
}
