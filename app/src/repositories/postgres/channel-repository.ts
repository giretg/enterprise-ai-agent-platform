import type {
  ChannelBot,
  ChannelIdentity,
  ChannelIdentityStatus,
  ChannelLinkToken,
  ChannelSession,
  ChannelType,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  ChannelBotRepository,
  ChannelIdentityRepository,
  ChannelLinkTokenRepository,
  ChannelSessionRepository,
  ChannelSessionUpdate,
  CreateChannelBotInput,
  CreateChannelIdentityInput,
  CreateChannelLinkTokenInput,
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
