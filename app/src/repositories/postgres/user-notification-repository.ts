import type { UserNotification } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  CreateUserNotificationInput,
  UserNotificationRepository,
} from '../interfaces'

/**
 * Platform-oldali felhasználói értesítés tár (Telegram feature-spec #70/#72, D12 story 3).
 * A `markRead` a `userId`-ra is szűr, hogy egy felhasználó csak a SAJÁT értesítését jelölhesse
 * olvasottnak (fail-closed — más felhasználó sorát nem billentheti).
 */
export class PostgresUserNotificationRepository implements UserNotificationRepository {
  async create(input: CreateUserNotificationInput): Promise<UserNotification> {
    return prisma.userNotification.create({
      data: {
        userId: input.userId,
        tenantId: input.tenantId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    })
  }

  async listForUser(userId: string, limit = 50): Promise<UserNotification[]> {
    return prisma.userNotification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
  }

  async markRead(id: string, userId: string, now: Date): Promise<UserNotification | null> {
    const res = await prisma.userNotification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: now },
    })
    if (res.count === 0) return null
    return prisma.userNotification.findUnique({ where: { id } })
  }
}
