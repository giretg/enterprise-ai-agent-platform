/** Memóriabeli `Store` a motor-tesztekhez — ugyanazokkal a szabályokkal, mint a Postgres-tár. */
import { randomUUID } from 'node:crypto'
import { ACTIVE_TURN_STATUSES, type Attachment, type Conversation, type Message, type Step, type Store, type Turn, type TurnEvent } from '../src/store.ts'

export class MemoryStore implements Store {
  conversations = new Map<string, Conversation>()
  messages: Message[] = []
  turns = new Map<string, Turn & { leaseUntil: number }>()
  steps = new Map<string, Step>()
  events: TurnEvent[] = []
  attachments = new Map<string, Attachment>()
  adminViews: Array<{ tenantId: string; adminUserId: string; conversationId: string }> = []

  async createConversation(input: Parameters<Store['createConversation']>[0]) {
    const c: Conversation = { ...input, id: randomUUID(), title: '', titleSetByUser: false, createdAt: new Date(), lastActivityAt: new Date() }
    this.conversations.set(c.id, c)
    return c
  }
  async getConversation(id: string) {
    return this.conversations.get(id) ?? null
  }
  async listConversations(input: Parameters<Store['listConversations']>[0]) {
    return [...this.conversations.values()].filter(
      (c) =>
        c.tenantId === input.tenantId &&
        (!input.userId || c.userId === input.userId) &&
        (!input.agentId || c.agentId === input.agentId) &&
        (!input.query ||
          c.title.toLowerCase().includes(input.query.toLowerCase()) ||
          this.messages.some((m) => m.conversationId === c.id && m.content.toLowerCase().includes(input.query!.toLowerCase()))),
    )
  }
  async renameConversation(id: string, title: string, byUser: boolean) {
    const c = this.conversations.get(id)!
    c.title = title
    c.titleSetByUser ||= byUser
  }
  async deleteConversation(id: string) {
    this.conversations.delete(id)
  }
  async touchConversation() {}
  async addMessage(input: Parameters<Store['addMessage']>[0]) {
    const m: Message = { ...input, id: randomUUID(), createdAt: new Date() }
    this.messages.push(m)
    return m
  }
  async listMessages(conversationId: string, limit = 500) {
    return this.messages.filter((m) => m.conversationId === conversationId).slice(-limit)
  }
  async createTurn(input: Parameters<Store['createTurn']>[0]) {
    if ([...this.turns.values()].some((t) => t.conversationId === input.conversationId && ACTIVE_TURN_STATUSES.includes(t.status))) return null
    const t = {
      ...input, id: randomUUID(), status: 'queued' as const, stepCount: 0, tokenUsage: {}, error: null, continuationToken: null,
      context: null, pendingApproval: null, createdAt: new Date(), finishedAt: null, leaseUntil: 0,
    }
    this.turns.set(t.id, t)
    return { ...t }
  }
  async getTurn(id: string) {
    const t = this.turns.get(id)
    return t ? structuredClone(t) : null
  }
  async lastTurnContext(conversationId: string, excludeTurnId: string) {
    const prev = [...this.turns.values()].filter((t) => t.conversationId === conversationId && t.id !== excludeTurnId && t.context).at(-1)
    return prev ? structuredClone(prev.context) : null
  }
  async activeTurn(conversationId: string) {
    const t = [...this.turns.values()].find((x) => x.conversationId === conversationId && ACTIVE_TURN_STATUSES.includes(x.status))
    return t ? structuredClone(t) : null
  }
  async updateTurn(id: string, patch: Partial<Turn>) {
    Object.assign(this.turns.get(id)!, patch)
  }
  async transitionTurn(id: string, from: readonly Turn['status'][], to: Turn['status'], patch: Partial<Turn> = {}) {
    const t = this.turns.get(id)
    if (!t || !from.includes(t.status)) return false
    Object.assign(t, patch, { status: to })
    return true
  }
  async claimTurn(id: string) {
    const t = this.turns.get(id)!
    if (t.leaseUntil > Date.now()) return false
    t.leaseUntil = Date.now() + 60_000
    return true
  }
  async releaseTurn(id: string) {
    this.turns.get(id)!.leaseUntil = 0
  }
  async listSteps(turnId: string) {
    return [...this.steps.values()].filter((s) => s.turnId === turnId).sort((a, b) => a.seq - b.seq).map((s) => structuredClone(s))
  }
  async beginStep(input: Parameters<Store['beginStep']>[0]) {
    const key = `${input.turnId}/${input.seq}`
    const existing = this.steps.get(key)
    if (existing?.status === 'done') throw new Error('already done')
    const step: Step = existing
      ? { ...existing, attempts: existing.attempts + 1, status: 'running', inputHash: input.inputHash }
      : { ...input, output: null, status: 'running', attempts: 1 }
    this.steps.set(key, step)
    return step
  }
  async finishStep(turnId: string, seq: number, status: Step['status'], output: Step['output']) {
    Object.assign(this.steps.get(`${turnId}/${seq}`)!, { status, output })
  }
  async appendEvent(turnId: string, type: TurnEvent['type'], payload: Record<string, unknown>) {
    const seq = this.events.filter((e) => e.turnId === turnId).length + 1
    this.events.push({ turnId, seq, type, payload, createdAt: new Date() })
    return seq
  }
  async eventsAfter(turnId: string, after: number) {
    return this.events.filter((e) => e.turnId === turnId && e.seq > after)
  }
  async pruneOldEvents() {}
  async addAttachment(input: Omit<Attachment, 'id'>) {
    const a = { ...input, id: randomUUID() }
    this.attachments.set(a.id, a)
    return a
  }
  async getAttachments(conversationId: string, ids: string[]) {
    return ids.map((id) => this.attachments.get(id)).filter((a): a is Attachment => !!a && a.conversationId === conversationId)
  }
  async listAttachmentPaths(conversationId: string) {
    return [...this.attachments.values()].filter((a) => a.conversationId === conversationId).map((a) => a.storagePath)
  }
  async logAdminView(input: { tenantId: string; adminUserId: string; conversationId: string }) {
    this.adminViews.push(input)
  }
}
