import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import {
  PLATFORM_CHAT_INSTALL_ID,
  PLATFORM_CHAT_INSTALL_KIND,
  type PlatformChatGatewayStore,
} from '@/domain/platform-chat/gateway'

const SESSION_RETENTION_MS = 24 * 3600_000

/** #1004 WP-3/WP-10: szerveroldali platform-chat install + session, napi költés-számláló. */
export class PostgresPlatformChatGatewayRepository implements PlatformChatGatewayStore {
  async registerSession(input: Parameters<PlatformChatGatewayStore['registerSession']>[0]) {
    const { tenantId, userId, agentId, sessionId, now } = input
    const key = { tenantId_userId_installId: { tenantId, userId, installId: PLATFORM_CHAT_INSTALL_ID } }
    await prisma.$transaction(async (tx) => {
      // A Guard-mezők erre a fajtára nem értelmezettek: üresek maradnak.
      const install = await tx.clientInstall.upsert({
        where: key,
        create: {
          tenantId,
          userId,
          installId: PLATFORM_CHAT_INSTALL_ID,
          kind: PLATFORM_CHAT_INSTALL_KIND,
          lastHeartbeatAt: now,
          configHash: '',
          managedDirHash: '',
          policyVersion: '',
          guardVersion: '',
          hermesVersion: '',
        },
        update: { lastHeartbeatAt: now, kind: PLATFORM_CHAT_INSTALL_KIND },
        select: { id: true },
      })
      await tx.clientInstallSession.upsert({
        where: { clientInstallId_sessionId_agentId: { clientInstallId: install.id, sessionId, agentId } },
        create: { clientInstallId: install.id, sessionId, agentId, lastSeenAt: now },
        update: { lastSeenAt: now },
      })
      await tx.clientInstallSession.deleteMany({
        where: { clientInstallId: install.id, lastSeenAt: { lt: new Date(now.getTime() - SESSION_RETENTION_MS) } },
      })
    })
  }

  async findSession(input: Parameters<PlatformChatGatewayStore['findSession']>[0]) {
    const row = await prisma.clientInstallSession.findFirst({
      where: {
        sessionId: input.sessionId,
        agentId: input.agentId,
        install: {
          tenantId: input.tenantId,
          userId: input.userId,
          installId: PLATFORM_CHAT_INSTALL_ID,
          kind: PLATFORM_CHAT_INSTALL_KIND,
        },
      },
      select: { lastSeenAt: true },
    })
    return row
  }

  async spendOn(input: { tenantId: string; day: string }) {
    const row = await prisma.platformChatDailyUsage.findUnique({
      where: { tenantId_day: { tenantId: input.tenantId, day: new Date(`${input.day}T00:00:00Z`) } },
      select: { costUsd: true },
    })
    return row ? Number(row.costUsd) : 0
  }

  async addSpend(input: { tenantId: string; day: string; costUsd: number }) {
    const day = new Date(`${input.day}T00:00:00Z`)
    const cost = new Prisma.Decimal(input.costUsd.toFixed(6))
    await prisma.platformChatDailyUsage.upsert({
      where: { tenantId_day: { tenantId: input.tenantId, day } },
      create: { tenantId: input.tenantId, day, costUsd: cost, calls: 1 },
      update: { costUsd: { increment: cost }, calls: { increment: 1 } },
    })
  }
}
