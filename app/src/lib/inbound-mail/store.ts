/**
 * #1032 bejövő levél — Prisma-tároló: események, agentenkénti szabály, figyelt postafiókok,
 * push-feliratkozások.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { mailboxConnectorInfo } from '@/domain/agent-mailbox/agent-mailbox'
import type { InboundMailHeaders, InboundMailProvider, InboundMailRule } from '@/domain/inbound-mail/inbound-mail'
import type {
  EventPatch,
  InboundMailEventRecord,
  InboundMailStatus,
  InboundMailStore,
  WatchedMailbox,
} from '@/domain/inbound-mail/service'
import { loadPrimaryMailboxAddresses } from '@/lib/agent-mailbox'

type EventRow = Prisma.InboundMailEventGetPayload<object>

function toRecord(row: EventRow): InboundMailEventRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    connectorId: row.connectorId,
    agentId: row.agentId,
    messageId: row.messageId,
    threadId: row.threadId,
    fromAddress: row.fromAddress,
    subject: row.subject,
    receivedAt: row.receivedAt,
    status: row.status,
    action: row.action,
    reason: row.reason,
    processedBy: row.processedBy,
    responsibleUserId: row.responsibleUserId,
    conversationId: row.conversationId,
    handoffId: row.handoffId,
    source: row.source,
    error: row.error,
    createdAt: row.createdAt,
  }
}

export function toRule(row: Prisma.AgentInboundMailRuleGetPayload<object>): InboundMailRule {
  return {
    mode: row.mode,
    instructions: row.instructions,
    responsibleUserId: row.responsibleUserId,
    handoffToUserId: row.handoffToUserId,
    handoffToAgentId: row.handoffToAgentId,
    senderAllowlist: row.senderAllowlist ?? [],
    dailyRunLimit: row.dailyRunLimit,
  }
}

const mailboxSelect = {
  id: true,
  tenantId: true,
  name: true,
  type: true,
  authMode: true,
  config: true,
  lifecycleState: true,
  primaryForAgents: {
    where: { retiredAt: null },
    select: { id: true, name: true, currentDefinitionVersionId: true, approverUserId: true },
    take: 1,
  },
} satisfies Prisma.ConnectorSelect

type MailboxRow = Prisma.ConnectorGetPayload<{ select: typeof mailboxSelect }>

function toMailbox(row: MailboxRow): WatchedMailbox | null {
  const info = mailboxConnectorInfo(row)
  if (!info || row.lifecycleState !== 'active') return null
  const agent = row.primaryForAgents[0]
  return {
    tenantId: row.tenantId,
    connectorId: row.id,
    provider: info.kind as InboundMailProvider,
    address: info.address,
    agent: agent
      ? { id: agent.id, name: agent.name, definitionId: agent.currentDefinitionVersionId, approverUserId: agent.approverUserId }
      : null,
  }
}

export async function loadWatchedMailbox(connectorId: string, tenantId?: string): Promise<WatchedMailbox | null> {
  const row = await prisma.connector.findFirst({ where: { id: connectorId, ...(tenantId ? { tenantId } : {}) }, select: mailboxSelect })
  return row ? toMailbox(row) : null
}

/** Minden postafiók, amely valamelyik (nem nyugdíjazott) agent saját címe. */
export async function listWatchedMailboxes(): Promise<WatchedMailbox[]> {
  const rows = await prisma.connector.findMany({
    where: { lifecycleState: 'active', primaryForAgents: { some: { retiredAt: null } } },
    select: mailboxSelect,
    orderBy: { id: 'asc' },
  })
  return rows.map(toMailbox).filter((row): row is WatchedMailbox => Boolean(row?.agent))
}

export const prismaInboundMailStore: InboundMailStore = {
  async insertEvent(input) {
    const mail: InboundMailHeaders = input.mail
    // ON CONFLICT DO NOTHING: az ismételt kézbesítés nem hiba (és nem naplóz hibát).
    const { count } = await prisma.inboundMailEvent.createMany({
      data: [
        {
          tenantId: input.tenantId,
          connectorId: input.connectorId,
          agentId: input.agentId,
          messageId: mail.messageId,
          threadId: mail.threadId,
          fromAddress: mail.from,
          subject: mail.subject,
          receivedAt: mail.receivedAt,
          responsibleUserId: input.responsibleUserId,
          source: input.source,
        },
      ],
      skipDuplicates: true,
    })
    const row = await prisma.inboundMailEvent.findUniqueOrThrow({
      where: { connectorId_messageId: { connectorId: input.connectorId, messageId: mail.messageId } },
    })
    return { event: toRecord(row), created: count === 1 }
  },
  async updateEvent(id: string, patch: EventPatch, from?: readonly InboundMailStatus[]) {
    const result = await prisma.inboundMailEvent.updateMany({
      where: { id, ...(from ? { status: { in: [...from] } } : {}) },
      data: patch,
    })
    return result.count === 1
  },
  async findEvent(tenantId, id) {
    const row = await prisma.inboundMailEvent.findFirst({ where: { id, tenantId } })
    return row ? toRecord(row) : null
  },
  async knownMessageIds(connectorId, messageIds) {
    if (messageIds.length === 0) return new Set()
    const rows = await prisma.inboundMailEvent.findMany({
      where: { connectorId, messageId: { in: messageIds } },
      select: { messageId: true },
    })
    return new Set(rows.map((row) => row.messageId))
  },
  countProcessed({ agentId, since, threadId }) {
    return prisma.inboundMailEvent.count({
      where: { agentId, action: 'process', createdAt: { gte: since }, ...(threadId ? { threadId } : {}) },
    })
  },
  async loadRule(agentId) {
    const row = await prisma.agentInboundMailRule.findUnique({ where: { agentId } })
    return row ? toRule(row) : null
  },
  async platformAddresses(tenantId) {
    return new Set([...(await loadPrimaryMailboxAddresses(tenantId)).values()].map((address) => address.toLowerCase()))
  },
  async listClaimed(limit) {
    const rows = await prisma.inboundMailEvent.findMany({
      where: { status: 'claimed' },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    })
    return rows.map(toRecord)
  },
}

export async function listAgentEvents(tenantId: string, agentId: string, limit = 50) {
  const rows = await prisma.inboundMailEvent.findMany({
    where: { tenantId, agentId },
    orderBy: { receivedAt: 'desc' },
    take: limit,
  })
  return rows.map(toRecord)
}

export async function listClaimedForAgent(tenantId: string, agentId: string) {
  const rows = await prisma.inboundMailEvent.findMany({ where: { tenantId, agentId, status: 'claimed' }, take: 20 })
  return rows.map(toRecord)
}

/** A felhasználónak szóló új levél-jelzések (értesítés a felületen). */
export async function listNewForUser(tenantId: string, userId: string, limit = 20) {
  const rows = await prisma.inboundMailEvent.findMany({
    where: { tenantId, responsibleUserId: userId, status: 'new' },
    orderBy: { receivedAt: 'desc' },
    take: limit,
    include: { agent: { select: { name: true } } },
  })
  return rows.map((row) => ({ ...toRecord(row), agentName: row.agent?.name ?? null }))
}

export function countNewForUser(tenantId: string, userId: string) {
  return prisma.inboundMailEvent.count({ where: { tenantId, responsibleUserId: userId, status: 'new' } })
}

// --- push-feliratkozások ---

export type WatchRow = Prisma.MailWatchSubscriptionGetPayload<object>

export const watchStore = {
  find(connectorId: string) {
    return prisma.mailWatchSubscription.findUnique({ where: { connectorId } })
  },
  findByExternalId(provider: string, externalId: string) {
    return prisma.mailWatchSubscription.findFirst({ where: { provider, externalId } })
  },
  listByProvider(provider: string) {
    return prisma.mailWatchSubscription.findMany({ where: { provider } })
  },
  upsert(input: { tenantId: string; connectorId: string; provider: string } & Partial<Pick<WatchRow, 'externalId' | 'cursor' | 'expiresAt' | 'lastPolledAt' | 'lastEventAt' | 'lastError'>>) {
    const { tenantId, connectorId, provider, ...rest } = input
    return prisma.mailWatchSubscription.upsert({
      where: { connectorId },
      create: { tenantId, connectorId, provider, ...rest },
      update: { provider, ...rest },
    })
  },
  update(connectorId: string, patch: Partial<Pick<WatchRow, 'externalId' | 'cursor' | 'expiresAt' | 'lastPolledAt' | 'lastEventAt' | 'lastError'>>) {
    return prisma.mailWatchSubscription.updateMany({ where: { connectorId }, data: patch })
  },
}
