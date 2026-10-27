import { prisma } from '@/lib/db'
import type { ClientInstallStore } from '@/domain/client-policy/client-install'

export class PostgresClientInstallRepository implements ClientInstallStore {
  async recordHeartbeat(input: Parameters<ClientInstallStore['recordHeartbeat']>[0]) {
    const { tenantId, userId, installId, agentId, now, sessionsOlderThan, sessions } = input
    const state = {
      lastHeartbeatAt: now,
      configHash: input.configHash,
      managedDirHash: input.managedDirHash,
      policyVersion: input.policyVersion,
      guardVersion: input.guardVersion,
      hermesVersion: input.hermesVersion,
    }
    return prisma.$transaction(async (tx) => {
      // A verzióváltás és a sessionök cseréje telepítésenként egyetlen műveletként látszódjon.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(774, hashtext(${`${tenantId}|${userId}|${installId}`}))`
      const key = { tenantId_userId_installId: { tenantId, userId, installId } }
      const previous = await tx.clientInstall.findUnique({ where: key, select: { lastHeartbeatAt: true, guardVersion: true } })
      const install = await tx.clientInstall.upsert({
        where: key,
        create: { tenantId, userId, installId, ...state },
        update: state,
        select: { id: true },
      })
      // A már futó, régi Guard sessionje nem örökölheti az új Guard verzióját.
      if (previous && previous.guardVersion !== input.guardVersion) {
        await tx.clientInstallSession.deleteMany({ where: { clientInstallId: install.id } })
      }
      for (const sessionId of sessions) {
        await tx.clientInstallSession.upsert({
          where: { clientInstallId_sessionId_agentId: { clientInstallId: install.id, sessionId, agentId } },
          create: { clientInstallId: install.id, sessionId, agentId, lastSeenAt: now },
          update: { lastSeenAt: now },
        })
      }
      await tx.clientInstallSession.deleteMany({
        where: { clientInstallId: install.id, lastSeenAt: { lt: sessionsOlderThan } },
      })
      return { previousHeartbeatAt: previous?.lastHeartbeatAt ?? null }
    })
  }

  async findInstall(input: Parameters<ClientInstallStore['findInstall']>[0]) {
    const row = await prisma.clientInstall.findUnique({
      where: { tenantId_userId_installId: { tenantId: input.tenantId, userId: input.userId, installId: input.installId } },
      select: {
        lastHeartbeatAt: true,
        managedDirHash: true,
        guardVersion: true,
        sessions: input.sessionId
          ? { where: { sessionId: input.sessionId, agentId: input.agentId }, select: { lastSeenAt: true } }
          : false,
      },
    })
    return row && { lastHeartbeatAt: row.lastHeartbeatAt, managedDirHash: row.managedDirHash, guardVersion: row.guardVersion, sessionLastSeenAt: row.sessions?.[0]?.lastSeenAt ?? null }
  }
}
