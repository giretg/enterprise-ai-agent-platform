/** A worker adatmodellje (§5.1) — a motor ezen az interfészen át dolgozik, így tesztben memóriában fut. */

export type TurnStatus = 'queued' | 'running' | 'awaiting_approval' | 'awaiting_input' | 'succeeded' | 'failed' | 'cancelled'
export const ACTIVE_TURN_STATUSES: readonly TurnStatus[] = ['queued', 'running', 'awaiting_approval', 'awaiting_input']
/** A user döntésére váró, parkolt forduló: nincs futó feladat, a stream lezár. */
export const PARKED_TURN_STATUSES: readonly TurnStatus[] = ['awaiting_approval', 'awaiting_input']

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

/**
 * #1024: letölthető fájl a munkatárs válaszán — a `document_export` `resource_link`-je vagy egy ismert
 * letöltési mező (`warehouse.export_dataset` → `exportUrl`). Csak a platform saját címére mutathat.
 */
export type FileCard = {
  url: string
  name: string
  mimeType: string | null
  size: number | null
  /** ISO időpont; null = nem jár le (pl. adattárház-export). */
  expiresAt: string | null
  /** A `document_export` azonosítója (Drive-mentéshez); null = más forrás. */
  exportId: string | null
  /** A munkatárs eléri-e a Drive-feltöltést (a „Mentés a Drive-ra” gomb ettől látszik). */
  canSaveToDrive?: boolean
}

/** #1025: munkaterv-lépés (`update_plan`). */
export type PlanItem = { title: string; status: 'pending' | 'in_progress' | 'done' }

/** #1025: a munkatárs kérdése (`ask_user`) — a válasz a forduló folytatásakor kerül bele. */
export type Question = {
  question: string
  options: Array<{ label: string; description?: string }>
  allowOther: boolean
  multiSelect: boolean
}
export type QuestionAnswer = { selected: string[]; text?: string; attachmentIds?: string[] }

export type Message = {
  id: string
  conversationId: string
  turnId: string | null
  role: 'user' | 'assistant'
  content: string
  attachments: AttachmentRef[]
  files: FileCard[]
  /** #1025: a megválaszolt kérdés-kártya (a kérdést feltevő assistant-üzeneten). */
  question?: (Question & { answer: QuestionAnswer }) | null
  /** #1025: a forduló utolsó munkaterve (a záró assistant-üzeneten). */
  plan?: PlanItem[] | null
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

/** #1025: `ask_user`-re váró forduló. A `seq` lépés a válasz után fut le helyben. */
export type PendingInput = Question & {
  seq: number
  callId: string
  createdAt: string
  answer?: QuestionAnswer
}

export type TurnContext = {
  definition: string
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  /** #1022: mindig betöltött mag-eszközök (az eszköz-index ezeket nem sorolja fel). */
  core?: string[]
  /** #1022: a `tools[]`-ben teljes sémával küldött eszközök; hiányzik = régi kontextus, minden betöltött. */
  loaded?: string[]
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
  pendingInput: PendingInput | null
  /** #1025: a user válaszára várással töltött idő — nem számít a forduló időkorlátjába. */
  pausedSeconds: number
  createdAt: Date
  finishedAt: Date | null
}

export type StepKind = 'llm' | 'tool'
export type StepStatus = 'running' | 'done' | 'awaiting_approval'

export type LlmStepOutput = {
  content: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
}
export type ToolStepOutput = {
  callId: string
  name: string
  text: string
  isError: boolean
  files?: FileCard[]
  image?: { attachmentId: string; page: number }
  /** #1025: `update_plan` lépés munkaterve. */
  plan?: PlanItem[]
}

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

export type EventType = 'delta' | 'status' | 'tool' | 'approval' | 'question' | 'plan' | 'done' | 'error'
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
  addMessage(input: Omit<Message, 'id' | 'createdAt' | 'files'> & { files?: FileCard[] }): Promise<Message>
  listMessages(conversationId: string, limit?: number): Promise<Message[]>

  // fordulók
  /** null = már fut egy forduló ebben a beszélgetésben (§5.2/6). */
  createTurn(input: { conversationId: string; tenantId: string; userId: string; agentId: string }): Promise<Turn | null>
  getTurn(id: string): Promise<Turn | null>
  /** A beszélgetés legutóbbi, kontextussal rendelkező korábbi fordulójának kontextusa (#1022 ragadós betöltés). */
  lastTurnContext(conversationId: string, excludeTurnId: string): Promise<TurnContext | null>
  activeTurn(conversationId: string): Promise<Turn | null>
  updateTurn(id: string, patch: Partial<Pick<Turn, 'status' | 'stepCount' | 'tokenUsage' | 'error' | 'continuationToken' | 'context' | 'pendingApproval' | 'pendingInput' | 'finishedAt'>>): Promise<void>
  /** Feltételes állapotváltás (pl. cancel csak aktív fordulón). */
  transitionTurn(id: string, from: readonly TurnStatus[], to: TurnStatus, patch?: Partial<Pick<Turn, 'error' | 'finishedAt' | 'pendingApproval' | 'pendingInput' | 'pausedSeconds' | 'continuationToken'>>): Promise<boolean>
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
