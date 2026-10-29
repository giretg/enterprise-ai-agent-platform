import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { PublicChatStore, SessionRow } from '@/domain/public-chat/service'
import type { TranscriptEntry } from '@/domain/public-chat/runtime'

function toSession(row: {
  id: string
  agentId: string
  visitorId: string
  isTest: boolean
  context: Prisma.JsonValue | null
  messages: Prisma.JsonValue
  messageCount: number
  handoff: string
  lastActivityAt: Date
}): SessionRow {
  return {
    id: row.id,
    agentId: row.agentId,
    visitorId: row.visitorId,
    isTest: row.isTest,
    context: row.context && typeof row.context === 'object' && !Array.isArray(row.context) ? (row.context as Record<string, unknown>) : null,
    messages: Array.isArray(row.messages) ? (row.messages as unknown as TranscriptEntry[]) : [],
    messageCount: row.messageCount,
    handoff: row.handoff,
    lastActivityAt: row.lastActivityAt,
  }
}

const day = (value: string) => new Date(`${value}T00:00:00Z`)

export const publicChatStore: PublicChatStore = {
  async findAssistantBySlug(slug) {
    const row = await prisma.publicAssistant.findUnique({
      where: { slug },
      include: { agent: { select: { name: true, kind: true, retiredAt: true } } },
    })
    if (!row || row.agent.retiredAt) return null
    return {
      agentId: row.agentId,
      tenantId: row.tenantId,
      slug: row.slug,
      agentName: row.agent.name,
      agentKind: row.agent.kind,
      draft: row.draft,
      published: row.published,
      paused: row.paused,
      lastLoadedAt: row.lastLoadedAt,
    }
  },
  async findSession(id) {
    const row = await prisma.publicChatSession.findUnique({ where: { id } })
    return row ? toSession(row) : null
  },
  countRecentSessionsByIp(ipHash, since) {
    return prisma.publicChatSession.count({ where: { ipHash, createdAt: { gte: since } } })
  },
  async createSession(input) {
    const row = await prisma.publicChatSession.create({
      data: {
        tenantId: input.tenantId,
        agentId: input.agentId,
        visitorId: input.visitorId,
        isTest: input.isTest,
        context: (input.context ?? Prisma.DbNull) as Prisma.InputJsonValue,
        ipHash: input.ipHash,
        createdAt: input.now,
        lastActivityAt: input.now,
      },
    })
    return toSession(row)
  },
  async saveTurn(input) {
    await prisma.publicChatSession.update({
      where: { id: input.sessionId },
      data: {
        messages: input.messages as unknown as Prisma.InputJsonValue,
        messageCount: input.messages.length,
        lastActivityAt: input.now,
        ...(input.handoff
          ? { handoff: input.handoff.kind, handoffContact: input.handoff.contact, handoffSummary: input.handoff.summary }
          : {}),
      },
    })
  },
  async addSignal(input) {
    await prisma.publicChatSignal.create({ data: { ...input, question: input.question.slice(0, 500) } })
  },
  async deleteVisitorSessions(input) {
    const res = await prisma.publicChatSession.deleteMany({
      where: { agentId: input.agentId, visitorId: input.visitorId, ...(input.sessionId ? { id: input.sessionId } : {}) },
    })
    return res.count
  },
  async markLoaded(input) {
    await prisma.publicAssistant.update({
      where: { agentId: input.agentId },
      data: { lastLoadedAt: input.now, lastLoadedDomain: input.domain },
    })
  },
  async spendOn(input) {
    const row = await prisma.publicChatDailyUsage.findUnique({
      where: { tenantId_day: { tenantId: input.tenantId, day: day(input.day) } },
    })
    return row ? Number(row.costUsd) : 0
  },
  async addSpend(input) {
    await prisma.publicChatDailyUsage.upsert({
      where: { tenantId_day: { tenantId: input.tenantId, day: day(input.day) } },
      create: { tenantId: input.tenantId, day: day(input.day), costUsd: input.costUsd, calls: 1 },
      update: { costUsd: { increment: input.costUsd }, calls: { increment: 1 } },
    })
  },
}
