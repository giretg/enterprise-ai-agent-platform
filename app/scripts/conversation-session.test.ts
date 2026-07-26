/**
 * Fókuszált ConversationSession DoD tesztváz.
 * Futtatás: npx tsx scripts/conversation-session.test.ts
 *
 * DB és LLM nélkül ellenőrzi:
 *   - delete content skeleton: törölt payload helyén megmarad a message-csontváz,
 *   - cross-tenant deny: más tenant nem olvashatja a szálat,
 *   - promote link: ticket.conversationId + message.ticketRefId létrejön,
 *   - archive append deny: archivált szálra append nem hoz létre üzenetet.
 */
import assert from 'node:assert/strict'
import type { Conversation, Message, MessageRole, Ticket } from '@prisma/client'
import { ConversationService } from '../src/domain/conversation/conversation-service'
import type { AuditRepository, ConversationRepository, TicketRepository } from '../src/repositories/interfaces'
import type { PlaybookService } from '../src/domain/playbook/playbook-service'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: `conv-${Math.random().toString(36).slice(2)}`,
    tenantId: 'tenant-A',
    agentId: 'agent-1',
    title: 'Conversation',
    status: 'active',
    createdById: 'user-1',
    retentionPolicyId: null,
    retainUntil: null,
    legalHold: false,
    createdAt: new Date('2026-06-29T08:00:00.000Z'),
    updatedAt: new Date('2026-06-29T08:00:00.000Z'),
    lastMessageAt: new Date('2026-06-29T08:00:00.000Z'),
    ...overrides,
  } as Conversation
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    conversationId: 'conv-1',
    seq: 1,
    role: 'user',
    actingUserId: null,
    agentVersion: null,
    model: null,
    contentRef: 'inline:hello',
    contentHash: null,
    contentDeletedAt: null,
    ticketRefId: null,
    auditEventRef: null,
    criticality: null,
    createdAt: new Date('2026-06-29T08:01:00.000Z'),
    ...overrides,
  } as Message
}

function decodeContent(contentRef: string | null): string | null {
  if (!contentRef) return null
  return contentRef.startsWith('inline:') ? contentRef.slice('inline:'.length) : contentRef
}

class MemoryConversationRepo {
  conversations = new Map<string, Conversation>()
  messages = new Map<string, Message[]>()

  async create(data: {
    tenantId: string | null
    agentId: string
    title?: string | null
    createdById: string
  }): Promise<Conversation> {
    const row = conversation(data)
    this.conversations.set(row.id, row)
    this.messages.set(row.id, [])
    return row
  }

  async findById(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null
  }

  async findByIdForTenant(id: string, tenantId: string | null): Promise<Conversation | null> {
    const row = this.conversations.get(id)
    if (!row) return null
    if (tenantId && row.tenantId && row.tenantId !== tenantId) return null
    return row
  }

  async list(params: { tenantId?: string | null; agentId?: string; status?: Conversation['status'] }) {
    return [...this.conversations.values()].filter((row) => {
      if (params.tenantId !== undefined && row.tenantId !== params.tenantId) return false
      if (params.agentId && row.agentId !== params.agentId) return false
      if (params.status && row.status !== params.status) return false
      return true
    })
  }

  async findManyForAgentUser() {
    return []
  }

  async appendMessage(data: {
    conversationId: string
    role: MessageRole
    content: string
    actingUserId?: string | null
    agentVersion?: number | null
    model?: string | null
    ticketRefId?: string | null
  }): Promise<Message> {
    if (this.conversations.get(data.conversationId)?.status === 'archived') {
      throw new Error('conversation_archived')
    }
    const rows = this.messages.get(data.conversationId) ?? []
    const row = message({
      id: `msg-${rows.length + 1}`,
      conversationId: data.conversationId,
      seq: rows.length + 1,
      role: data.role,
      actingUserId: data.actingUserId ?? null,
      agentVersion: data.agentVersion ?? null,
      model: data.model ?? null,
      contentRef: `inline:${data.content}`,
      ticketRefId: data.ticketRefId ?? null,
    })
    rows.push(row)
    this.messages.set(data.conversationId, rows)
    return row
  }

  async findMessages(conversationId: string) {
    return (this.messages.get(conversationId) ?? []).map((row) => ({
      ...row,
      content: row.contentDeletedAt ? null : decodeContent(row.contentRef),
    }))
  }

  async findMessageById(id: string): Promise<Message | null> {
    return [...this.messages.values()].flat().find((row) => row.id === id) ?? null
  }

  async findMessageByIdForTenant(id: string, tenantId: string | null): Promise<Message | null> {
    const row = await this.findMessageById(id)
    if (!row) return null
    const conv = this.conversations.get(row.conversationId)
    if (!conv) return null
    if (tenantId && conv.tenantId && conv.tenantId !== tenantId) return null
    return row
  }

  async archive(id: string): Promise<Conversation> {
    const row = this.conversations.get(id)
    if (!row) throw new Error('Conversation not found')
    const archived = { ...row, status: 'archived' as const }
    this.conversations.set(id, archived)
    return archived
  }

  async deleteMessageContent(messageId: string): Promise<Message> {
    const row = await this.findMessageById(messageId)
    if (!row) throw new Error('Message not found')
    row.contentRef = null
    row.contentDeletedAt = new Date('2026-06-29T08:02:00.000Z')
    return row
  }

  async linkMessageToTicket(messageId: string, ticketId: string): Promise<Message> {
    const row = await this.findMessageById(messageId)
    if (!row) throw new Error('Message not found')
    row.ticketRefId = ticketId
    return row
  }

  async deleteConversationContent(conversationId: string): Promise<Message[]> {
    const rows = this.messages.get(conversationId) ?? []
    for (const row of rows) {
      row.contentRef = null
      row.contentDeletedAt = new Date('2026-06-29T08:02:00.000Z')
    }
    return rows
  }

  async setMessageAuditEventRef(messageId: string, auditEventRef: string): Promise<Message> {
    const row = await this.findMessageById(messageId)
    if (!row) throw new Error('Message not found')
    return { ...row, auditEventRef } as Message
  }

  async findRetentionPolicy() {
    return null
  }

  /**
   * A `PostgresConversationRepository.retentionSweep` szerződését tükrözi (#117): a lejárt
   * (`retainUntil <= now`), jogi zár alatt NEM álló beszélgetések még élő üzenet-tartalmát
   * üríti, a legrégebbi határidejűvel kezdve, `limit` darabig.
   */
  async retentionSweep(now: Date, limit?: number) {
    const due = [...this.conversations.values()]
      .filter((conv) => {
        if (conv.legalHold) return false
        if (!conv.retainUntil || conv.retainUntil.getTime() > now.getTime()) return false
        return (this.messages.get(conv.id) ?? []).some(
          (row) => row.contentDeletedAt == null && row.contentRef != null,
        )
      })
      .sort((a, b) => (a.retainUntil?.getTime() ?? 0) - (b.retainUntil?.getTime() ?? 0))
      .slice(0, Math.max(1, Math.min(limit ?? 50, 100)))

    let deletedCount = 0
    for (const conv of due) {
      for (const row of this.messages.get(conv.id) ?? []) {
        if (row.contentDeletedAt != null || row.contentRef == null) continue
        row.contentRef = null
        row.contentDeletedAt = now
        deletedCount++
      }
    }

    return {
      sweptCount: due.length,
      deletedCount,
      conversationIds: due.map((conv) => conv.id),
    }
  }
}

class MemoryTicketRepo {
  tickets: Ticket[] = []

  async create(data: Record<string, unknown>): Promise<Ticket> {
    const ticket = {
      id: `ticket-${this.tickets.length + 1}`,
      tenantId: data.tenantId ?? null,
      type: data.type,
      title: data.title,
      state: data.state,
      assigneeType: data.assigneeType,
      assigneeId: data.assigneeId ?? null,
      agentId: data.agentId ?? null,
      playbookRef: data.playbookRef ?? null,
      conversationId: data.conversationId ?? null,
      payload: data.payload,
      sourceDocumentId: data.sourceDocumentId ?? null,
      executeAfter: data.executeAfter ?? null,
      dueBy: data.dueBy ?? null,
      createdById: data.createdById,
      createdAt: new Date('2026-06-29T08:03:00.000Z'),
      updatedAt: new Date('2026-06-29T08:03:00.000Z'),
    } as Ticket
    this.tickets.push(ticket)
    return ticket
  }
}

function buildService() {
  const conversations = new MemoryConversationRepo()
  const tickets = new MemoryTicketRepo()
  const audit = {
    events: [] as Record<string, unknown>[],
    failAppend: false,
    append: async (event: Record<string, unknown>) => {
      if (audit.failAppend) throw new Error('audit_unavailable')
      const stored = { id: `audit-${audit.events.length + 1}`, ...event }
      audit.events.push(stored)
      return stored
    },
  } as unknown as AuditRepository & { events: Record<string, unknown>[]; failAppend: boolean }
  const playbooks = {
    getActiveRefByName: async () => 'playbook:wiki-interaction@v1',
    auditProcessStart: async () => undefined,
  } as unknown as PlaybookService

  return {
    service: new ConversationService(
      conversations as unknown as ConversationRepository,
      tickets as unknown as TicketRepository,
      audit,
      playbooks,
    ),
    conversations,
    tickets,
    audit,
  }
}

async function main() {
  console.log('=== ConversationSession DoD fókuszteszt ===')

  await test('delete content skeleton — payload törölve, message-sor megmarad', async () => {
    const { service } = buildService()
    const conv = await service.createConversation({
      agentId: 'agent-1',
      createdById: 'user-1',
      tenantId: 'tenant-A',
    })
    const msg = await service.appendMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'PII tartalom',
      actorId: 'user-1',
    })

    await service.deleteMessageContent({ messageId: msg.id, actorId: 'admin-1' })
    const after = await service.getConversation(conv.id, 'tenant-A')

    assert.equal(after.messages.length, 1)
    assert.equal(after.messages[0]?.id, msg.id)
    assert.equal(after.messages[0]?.content, null)
    assert.ok(after.messages[0]?.contentDeletedAt)
  })

  await test('cross-tenant deny — más tenant Conversation not found hibát kap', async () => {
    const { service } = buildService()
    const conv = await service.createConversation({
      agentId: 'agent-1',
      createdById: 'user-1',
      tenantId: 'tenant-A',
    })

    await assert.rejects(
      () => service.getConversation(conv.id, 'tenant-B'),
      /Conversation not found/,
    )
  })

  await test('promote link — ticket visszamutat a conversationre és a message-re', async () => {
    const { service, conversations } = buildService()
    const conv = await service.createConversation({
      agentId: 'agent-1',
      createdById: 'user-1',
      tenantId: 'tenant-A',
    })
    const agentMessage = await service.appendMessage({
      conversationId: conv.id,
      role: 'agent',
      content: JSON.stringify({ question: 'Jóváhagyandó válasz', answer: 'OK' }),
    })

    const ticket = await service.promoteToTicket({
      conversationId: conv.id,
      createdById: 'user-1',
      tenantId: 'tenant-A',
      answerPayload: { question: 'Jóváhagyandó válasz', answer: 'OK' },
      agentMessageId: agentMessage.id,
    })

    assert.equal(ticket.conversationId, conv.id)
    assert.equal((await conversations.findMessageById(agentMessage.id))?.ticketRefId, ticket.id)
  })

  await test('promote cross-tenant deny — ticket nem nyílhat idegen conversationből', async () => {
    const { service, tickets } = buildService()
    const conv = await service.createConversation({
      agentId: 'agent-1',
      createdById: 'user-1',
      tenantId: 'tenant-A',
    })
    const agentMessage = await service.appendMessage({
      conversationId: conv.id,
      role: 'agent',
      content: JSON.stringify({ question: 'Más tenant válasza', answer: 'OK' }),
    })

    await assert.rejects(
      () =>
        service.promoteToTicket({
          conversationId: conv.id,
          createdById: 'user-2',
          tenantId: 'tenant-B',
          answerPayload: { question: 'Más tenant válasza', answer: 'OK' },
          agentMessageId: agentMessage.id,
        }),
      /Conversation not found/,
    )
    assert.equal(tickets.tickets.length, 0)
  })

  await test('archive append deny — archived szálra append elutasítva', async () => {
    const { service, conversations } = buildService()
    const conv = await service.createConversation({
      agentId: 'agent-1',
      createdById: 'user-1',
      tenantId: 'tenant-A',
    })

    await service.archiveConversation({ conversationId: conv.id, actorId: 'admin-1', tenantId: 'tenant-A' })
    await assert.rejects(
      () => service.appendMessage({ conversationId: conv.id, role: 'user', content: 'should deny' }),
      /conversation_archived/,
    )
    assert.equal(conversations.messages.get(conv.id)?.length ?? 0, 0)
  })

  await test('persist-ACK seam — audit hiba előtt jelzi a már commitolt üzenetet', async () => {
    const { service, conversations, audit } = buildService()
    const conv = await service.createConversation({
      agentId: 'agent-1',
      createdById: 'user-1',
      tenantId: 'tenant-A',
    })
    let persistedMessageId: string | null = null
    audit.failAppend = true

    await assert.rejects(
      () =>
        service.appendMessage({
          conversationId: conv.id,
          role: 'user',
          content: 'DB-ben maradó kérdés',
          onPersisted: (message) => {
            persistedMessageId = message.id
          },
        }),
      /audit_unavailable/,
    )

    assert.equal(persistedMessageId, 'msg-1')
    assert.equal(conversations.messages.get(conv.id)?.[0]?.id, persistedMessageId)
  })

  await test('acting user — user és agent fordulón is eltárolódik', async () => {
    const { service } = buildService()
    const conv = await service.createConversation({
      agentId: 'agent-1',
      createdById: 'user-1',
      tenantId: 'tenant-A',
    })

    await service.appendMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'Kérdés',
      actingUserId: 'user-1',
      actorType: 'human',
      actorId: 'user-1',
    })
    await service.appendMessage({
      conversationId: conv.id,
      role: 'agent',
      content: 'Válasz',
      actingUserId: 'user-1',
      actorType: 'agent',
      actorId: 'agent-1',
    })

    const after = await service.getConversation(conv.id, 'tenant-A')
    assert.deepEqual(after.messages.map((row) => row.actingUserId), ['user-1', 'user-1'])
  })

  // Megőrzési takarítás (#117): a takarító a dispatcher ciklusából fut, ezért itt a
  // szolgáltatás-szerződést mérjük — mit ürít, mit hagy békén, és mikor NEM ír auditot.
  const RETENTION_NOW = new Date('2026-07-01T10:00:00.000Z')

  async function seedExpiredConversation(
    service: ConversationService,
    repo: MemoryConversationRepo,
    params: { retainUntil: Date | null; legalHold?: boolean; content?: string },
  ) {
    const conv = await service.createConversation({
      agentId: 'agent-1',
      createdById: 'user-1',
      tenantId: 'tenant-A',
    })
    await service.appendMessage({
      conversationId: conv.id,
      role: 'user',
      content: params.content ?? 'megőrzési határidőn túli tartalom',
    })
    const stored = repo.conversations.get(conv.id)!
    stored.retainUntil = params.retainUntil
    stored.legalHold = params.legalHold ?? false
    return conv
  }

  await test('retention sweep — lejárt szál tartalma ürül, a csontváz megmarad', async () => {
    const { service, conversations, audit } = buildService()
    const conv = await seedExpiredConversation(service, conversations, {
      retainUntil: new Date('2026-06-30T10:00:00.000Z'),
    })

    const result = await service.retentionSweep({ now: RETENTION_NOW })

    assert.equal(result.sweptCount, 1)
    assert.equal(result.deletedCount, 1)
    const after = await service.getConversation(conv.id, 'tenant-A')
    assert.equal(after.messages.length, 1)
    assert.equal(after.messages[0]?.content, null)
    assert.ok(after.messages[0]?.contentDeletedAt)
    assert.equal(audit.events.filter((e) => e.action === 'retention.sweep').length, 1)
  })

  await test('retention sweep — üres futásra NINCS audit-sor (nem terheljük a hash-láncot)', async () => {
    const { service, conversations, audit } = buildService()
    await seedExpiredConversation(service, conversations, {
      retainUntil: new Date('2026-08-30T10:00:00.000Z'),
    })
    const auditCountBefore = audit.events.length

    const result = await service.retentionSweep({ now: RETENTION_NOW })

    assert.equal(result.sweptCount, 0)
    assert.equal(result.deletedCount, 0)
    assert.equal(audit.events.length, auditCountBefore)
    assert.equal(audit.events.filter((e) => e.action === 'retention.sweep').length, 0)
  })

  await test('retention sweep — jogi zár alatti szálhoz nem nyúlunk', async () => {
    const { service, conversations } = buildService()
    const conv = await seedExpiredConversation(service, conversations, {
      retainUntil: new Date('2026-06-30T10:00:00.000Z'),
      legalHold: true,
    })

    const result = await service.retentionSweep({ now: RETENTION_NOW })

    assert.equal(result.sweptCount, 0)
    const after = await service.getConversation(conv.id, 'tenant-A')
    assert.equal(after.messages[0]?.content, 'megőrzési határidőn túli tartalom')
  })

  await test('retention sweep — a limit darabol, a maradék a következő körre marad', async () => {
    const { service, conversations } = buildService()
    for (let i = 0; i < 3; i++) {
      await seedExpiredConversation(service, conversations, {
        retainUntil: new Date(`2026-06-2${i + 5}T10:00:00.000Z`),
      })
    }

    const first = await service.retentionSweep({ now: RETENTION_NOW, limit: 2 })
    assert.equal(first.sweptCount, 2)

    const second = await service.retentionSweep({ now: RETENTION_NOW, limit: 2 })
    assert.equal(second.sweptCount, 1)

    const third = await service.retentionSweep({ now: RETENTION_NOW, limit: 2 })
    assert.equal(third.sweptCount, 0)
  })

  if (failures > 0) {
    console.error(`\n${failures} ConversationSession teszt bukott.`)
    process.exit(1)
  }

  console.log('\nConversationSession fókuszteszt kész.')
}

void main()
