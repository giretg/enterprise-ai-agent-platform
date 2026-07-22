import type { ChannelBot, ChannelType } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  ChannelBotRepository,
  CreateChannelBotInput,
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
