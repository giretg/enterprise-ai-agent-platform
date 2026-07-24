import type {
  ChannelAgentGrant,
  ChannelBot,
  ChannelIdentity,
  ChannelIdentityStatus,
  ChannelLinkToken,
  ChannelOutboundMessage,
  ChannelSession,
  ChannelTurn,
  ChannelType,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  ChannelAgentGrantRepository,
  ChannelBotRepository,
  ChannelIdentityRepository,
  ChannelLinkTokenRepository,
  ChannelMetricsRepository,
  ChannelOutboundMessageRepository,
  ChannelSessionRepository,
  ChannelSessionUpdate,
  ChannelTurnRepository,
  CreateChannelAgentGrantInput,
  CreateChannelBotInput,
  CreateChannelIdentityInput,
  CreateChannelLinkTokenInput,
  EnqueueChannelTurnInput,
  RecordChannelOutboundInput,
  UpdateChannelBotInput,
} from '../interfaces'

/**
 * Csatorna-bot tár (Telegram feature-spec #70/#71, D3/D14). A platform-bot a `tenantId = null`
 * sor; az egyetlen-platform-bot invariánst a `0013` migráció részleges egyedi indexe
 * (`channel_bots_platform_singleton_key`, `tenant_id IS NULL`) kényszeríti — a create egy
 * második platform-botnál P2002-vel bukik.
 */
export class PostgresChannelBotRepository implements ChannelBotRepository {
  async findPlatformBot(channelType: ChannelType): Promise<ChannelBot | null> {
    return prisma.channelBot.findFirst({ where: { channelType, tenantId: null } })
  }

  async findById(id: string): Promise<ChannelBot | null> {
    return prisma.channelBot.findUnique({ where: { id } })
  }

  async create(input: CreateChannelBotInput): Promise<ChannelBot> {
    return prisma.channelBot.create({
      data: {
        channelType: input.channelType,
        tenantId: input.tenantId,
        name: input.name,
        accessKeySecretRef: input.accessKeySecretRef,
        webhookSecretRef: input.webhookSecretRef,
        status: input.status ?? 'active',
        createdById: input.createdById,
      },
    })
  }

  async update(id: string, input: UpdateChannelBotInput): Promise<ChannelBot> {
    return prisma.channelBot.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.accessKeySecretRef !== undefined
          ? { accessKeySecretRef: input.accessKeySecretRef }
          : {}),
        ...(input.webhookSecretRef !== undefined
          ? { webhookSecretRef: input.webhookSecretRef }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    })
  }
}

/**
 * Csatorna-identitás tár (Telegram feature-spec #70/#72, D2/D14). A `(channelType, lookupHash)`
 * egyedi, ezért a re-link ugyanazt a sort aktiválja újra — nem keletkezik két sor ugyanahhoz a
 * külső fiókhoz. SZEREPKÖRT sosem tárol/ír.
 */
export class PostgresChannelIdentityRepository implements ChannelIdentityRepository {
  async findByLookupHash(
    channelType: ChannelType,
    lookupHash: string,
  ): Promise<ChannelIdentity | null> {
    return prisma.channelIdentity.findUnique({
      where: { channelType_lookupHash: { channelType, lookupHash } },
    })
  }

  async findById(id: string): Promise<ChannelIdentity | null> {
    return prisma.channelIdentity.findUnique({ where: { id } })
  }

  async listByUser(userId: string): Promise<ChannelIdentity[]> {
    return prisma.channelIdentity.findMany({
      where: { userId },
      orderBy: { linkedAt: 'desc' },
    })
  }

  async listByTenantWithUsers(
    tenantId: string,
  ): Promise<Array<ChannelIdentity & { user: { id: string; name: string; email: string } }>> {
    return prisma.channelIdentity.findMany({
      where: { tenantId, status: 'active' },
      orderBy: { linkedAt: 'desc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    })
  }

  async create(input: CreateChannelIdentityInput): Promise<ChannelIdentity> {
    return prisma.channelIdentity.create({
      data: {
        channelType: input.channelType,
        externalUserIdEnc: input.externalUserIdEnc,
        lookupHash: input.lookupHash,
        tenantId: input.tenantId,
        userId: input.userId,
        status: 'active',
      },
    })
  }

  async updateStatus(id: string, status: ChannelIdentityStatus): Promise<ChannelIdentity> {
    return prisma.channelIdentity.update({ where: { id }, data: { status } })
  }

  async reactivate(
    id: string,
    input: { userId: string; tenantId: string | null; linkedAt: Date },
  ): Promise<ChannelIdentity> {
    return prisma.channelIdentity.update({
      where: { id },
      data: {
        status: 'active',
        userId: input.userId,
        tenantId: input.tenantId,
        linkedAt: input.linkedAt,
      },
    })
  }
}

/**
 * Csatorna-agent-engedély tár (Telegram feature-spec #70/#75, D5/D9/D13/D14). A `(identityId,
 * agentId)` egyedi, ezért az ismételt engedélyezés ugyanazt a sort érinti — nem keletkezik két
 * engedély ugyanahhoz az agenthez. A projektkulcsot külön billenti (a felhasználó állítja).
 */
export class PostgresChannelAgentGrantRepository implements ChannelAgentGrantRepository {
  async listByIdentity(identityId: string): Promise<ChannelAgentGrant[]> {
    return prisma.channelAgentGrant.findMany({
      where: { identityId },
      orderBy: { grantedAt: 'asc' },
    })
  }

  async hasAnyGrant(identityId: string): Promise<boolean> {
    return (await prisma.channelAgentGrant.count({ where: { identityId } })) > 0
  }

  async listByIdentityIds(identityIds: string[]): Promise<ChannelAgentGrant[]> {
    if (identityIds.length === 0) return []
    return prisma.channelAgentGrant.findMany({
      where: { identityId: { in: identityIds } },
      orderBy: { grantedAt: 'asc' },
    })
  }

  async findByIdentityAndAgent(
    identityId: string,
    agentId: string,
  ): Promise<ChannelAgentGrant | null> {
    return prisma.channelAgentGrant.findUnique({
      where: { identityId_agentId: { identityId, agentId } },
    })
  }

  async create(input: CreateChannelAgentGrantInput): Promise<ChannelAgentGrant> {
    return prisma.channelAgentGrant.create({
      data: {
        identityId: input.identityId,
        agentId: input.agentId,
        ...(input.projectKey !== undefined ? { projectKey: input.projectKey } : {}),
        grantedById: input.grantedById,
      },
    })
  }

  async updateProjectKey(id: string, projectKey: string): Promise<ChannelAgentGrant> {
    return prisma.channelAgentGrant.update({ where: { id }, data: { projectKey } })
  }

  async deleteById(id: string): Promise<void> {
    await prisma.channelAgentGrant.delete({ where: { id } })
  }

  /** Alias `findByIdentityAndAgent`-re — a #74 agent-chat forduló-feldolgozó ezt a nevet várja. */
  async findForIdentityAgent(
    identityId: string,
    agentId: string,
  ): Promise<ChannelAgentGrant | null> {
    return this.findByIdentityAndAgent(identityId, agentId)
  }

  /** Alias `listByIdentity`-re — a #74 agent-chat forduló-feldolgozó ezt a nevet várja. */
  async listForIdentity(identityId: string): Promise<ChannelAgentGrant[]> {
    return this.listByIdentity(identityId)
  }
}

/**
 * Csatorna-munkamenet tár (Telegram feature-spec #70/#72, D8/D9/D15). A `(botId,
 * externalThreadId)` egyedi — szálanként egyetlen munkamenet.
 */
export class PostgresChannelSessionRepository implements ChannelSessionRepository {
  async findById(id: string): Promise<ChannelSession | null> {
    return prisma.channelSession.findUnique({ where: { id } })
  }

  async findByBotAndThread(
    botId: string,
    externalThreadId: string,
  ): Promise<ChannelSession | null> {
    return prisma.channelSession.findUnique({
      where: { botId_externalThreadId: { botId, externalThreadId } },
    })
  }

  async create(input: { botId: string; externalThreadId: string }): Promise<ChannelSession> {
    return prisma.channelSession.create({
      data: { botId: input.botId, externalThreadId: input.externalThreadId },
    })
  }

  async update(id: string, data: ChannelSessionUpdate): Promise<ChannelSession> {
    return prisma.channelSession.update({
      where: { id },
      data: {
        ...(data.identityId !== undefined ? { identityId: data.identityId } : {}),
        ...(data.activeAgentId !== undefined ? { activeAgentId: data.activeAgentId } : {}),
        ...(data.conversationId !== undefined ? { conversationId: data.conversationId } : {}),
        ...(data.updateWatermark !== undefined ? { updateWatermark: data.updateWatermark } : {}),
        ...(data.unlinkedNoticeAt !== undefined ? { unlinkedNoticeAt: data.unlinkedNoticeAt } : {}),
        ...(data.lastActivityAt !== undefined ? { lastActivityAt: data.lastActivityAt } : {}),
      },
    })
  }
}

/**
 * Deep-link összekötő token tár (Telegram feature-spec #70/#72, D12). Az egyszer-használat
 * a `consume` atomi `updateMany where jti AND consumed_at IS NULL` billentése — verseny-
 * biztos (a kettős koppintás második ága nem billent, `null`-t kap vissza).
 */
export class PostgresChannelLinkTokenRepository implements ChannelLinkTokenRepository {
  async create(input: CreateChannelLinkTokenInput): Promise<ChannelLinkToken> {
    return prisma.channelLinkToken.create({
      data: {
        channelType: input.channelType,
        jti: input.jti,
        signature: input.signature,
        userId: input.userId,
        tenantId: input.tenantId,
        expiresAt: input.expiresAt,
        createdById: input.createdById,
      },
    })
  }

  async findByJti(jti: string): Promise<ChannelLinkToken | null> {
    return prisma.channelLinkToken.findUnique({ where: { jti } })
  }

  async consume(
    jti: string,
    consumedByLookupHash: string,
    now: Date,
  ): Promise<ChannelLinkToken | null> {
    // Atomi egyszer-használat: csak akkor billent, ha még nincs elhasználva. A count-alapú
    // updateMany a versenyt zárja; a nyertes utána visszaolvassa a sort.
    const res = await prisma.channelLinkToken.updateMany({
      where: { jti, consumedAt: null },
      data: { consumedAt: now, consumedByLookupHash },
    })
    if (res.count === 0) return null
    return prisma.channelLinkToken.findUnique({ where: { jti } })
  }
}

/**
 * A bot SAJÁT kimenő üzeneteinek tára a megőrzési takarításhoz (Telegram feature-spec
 * #70/#78, D4). Csak a `providerMessageId`-t és a törléshez kellő szál-azonosítót tartja —
 * nyers üzenettartalmat SOHA. A takarító a `listExpired`-del olvassa a horizonton túli,
 * még nem takarított sorokat, majd `markPurged`-del idempotensen lezárja őket.
 */
export class PostgresChannelOutboundMessageRepository
  implements ChannelOutboundMessageRepository
{
  async record(input: RecordChannelOutboundInput): Promise<ChannelOutboundMessage> {
    return prisma.channelOutboundMessage.create({
      data: {
        sessionId: input.sessionId,
        channelType: input.channelType,
        externalThreadId: input.externalThreadId,
        providerMessageId: input.providerMessageId,
        kind: input.kind ?? null,
        ...(input.sentAt ? { sentAt: input.sentAt } : {}),
      },
    })
  }

  async listExpired(cutoff: Date, limit: number): Promise<ChannelOutboundMessage[]> {
    return prisma.channelOutboundMessage.findMany({
      where: { purgedAt: null, sentAt: { lt: cutoff } },
      orderBy: { sentAt: 'asc' },
      take: limit,
    })
  }

  async markPurged(id: string, purgedAt: Date): Promise<void> {
    await prisma.channelOutboundMessage.update({ where: { id }, data: { purgedAt } })
  }
}

/**
 * Csatorna-forduló (worker-munkasor) tár — a worker MÁSODIK munkatípusa (Telegram feature-spec
 * #70/#73/#74, D8/D14). A `claimNextBatch` egy tranzakcióban foglalja le a sorokat (`queued` →
 * `running`, `attempts++`), hogy egy forduló ne induljon el kétszer még párhuzamos workereknél
 * sem. Az elavult `running` sorokat (elszállt worker) a `staleRunningBefore` alapján visszaveszi,
 * így a forduló újrapróbálható (D8 — túléli a webhook-kérést).
 */
export class PostgresChannelTurnRepository implements ChannelTurnRepository {
  async enqueue(input: EnqueueChannelTurnInput): Promise<ChannelTurn> {
    return prisma.channelTurn.create({
      data: {
        sessionId: input.sessionId,
        inboundRef: input.inboundRef ?? null,
        inboundText: input.inboundText,
        inboundKind: input.inboundKind,
        status: 'queued',
      },
    })
  }

  async findById(id: string): Promise<ChannelTurn | null> {
    return prisma.channelTurn.findUnique({ where: { id } })
  }

  async claimNextBatch(input: {
    limit: number
    now: Date
    staleRunningBefore: Date
  }): Promise<ChannelTurn[]> {
    return prisma.$transaction(async (tx) => {
      // `FOR UPDATE SKIP LOCKED`: a párhuzamos workerek nem ütköznek — mindegyik más sorokat
      // foglal. A `queued` és az elavult `running` (elszállt worker) sorok is jogosultak.
      const candidates = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "channel_turns"
        WHERE "status" = 'queued'
           OR ("status" = 'running' AND "updated_at" < ${input.staleRunningBefore})
        ORDER BY "created_at" ASC
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      `
      const ids = candidates.map((c) => c.id)
      if (ids.length === 0) return []
      await tx.channelTurn.updateMany({
        where: { id: { in: ids } },
        data: { status: 'running', attempts: { increment: 1 }, updatedAt: input.now },
      })
      return tx.channelTurn.findMany({
        where: { id: { in: ids } },
        orderBy: { createdAt: 'asc' },
      })
    })
  }

  async markDone(id: string): Promise<ChannelTurn> {
    return prisma.channelTurn.update({ where: { id }, data: { status: 'done', lastError: null } })
  }

  async markRetry(id: string, error: string): Promise<ChannelTurn> {
    return prisma.channelTurn.update({
      where: { id },
      data: { status: 'queued', lastError: error.slice(0, 500) },
    })
  }

  async markFailed(id: string, error: string): Promise<ChannelTurn> {
    return prisma.channelTurn.update({
      where: { id },
      data: { status: 'failed', lastError: error.slice(0, 500) },
    })
  }
}

/**
 * A csatorna-táblák állapot-olvasásai az üzemeltetői metrikákhoz (Telegram feature-spec
 * #70/#78, story 59). CSAK aggregáló `groupBy`/`count` — nyers külső azonosítót nem ad vissza.
 */
export class PostgresChannelMetricsRepository implements ChannelMetricsRepository {
  async countTurnsByStatus(since?: Date): Promise<Record<string, number>> {
    const rows = await prisma.channelTurn.groupBy({
      by: ['status'],
      _count: { _all: true },
      ...(since ? { where: { createdAt: { gte: since } } } : {}),
    })
    const out: Record<string, number> = {}
    for (const r of rows) out[r.status] = r._count._all
    return out
  }

  async countSessions(): Promise<{ total: number; linked: number }> {
    const [total, linked] = await Promise.all([
      prisma.channelSession.count(),
      prisma.channelSession.count({ where: { identityId: { not: null } } }),
    ])
    return { total, linked }
  }

  async countIdentitiesByStatus(): Promise<Record<string, number>> {
    const rows = await prisma.channelIdentity.groupBy({
      by: ['status'],
      _count: { _all: true },
    })
    const out: Record<string, number> = {}
    for (const r of rows) out[r.status] = r._count._all
    return out
  }

  async countPendingOutbound(): Promise<{ pending: number; oldestSentAt: Date | null }> {
    const [pending, oldest] = await Promise.all([
      prisma.channelOutboundMessage.count({ where: { purgedAt: null } }),
      prisma.channelOutboundMessage.findFirst({
        where: { purgedAt: null },
        orderBy: { sentAt: 'asc' },
        select: { sentAt: true },
      }),
    ])
    return { pending, oldestSentAt: oldest?.sentAt ?? null }
  }
}
