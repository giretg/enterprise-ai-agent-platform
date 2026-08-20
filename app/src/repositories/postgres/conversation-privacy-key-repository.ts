import { prisma } from '@/lib/db'
import {
  generateConversationDataKey,
  unwrapConversationDataKey,
  wrapConversationDataKey,
} from '@/domain/privacy/conversation-privacy-key-crypto'

export interface ConversationPrivacyKeyRepository {
  ensureDataKey(tenantId: string, conversationId: string): Promise<Buffer>
  getDataKey(tenantId: string, conversationId: string): Promise<Buffer | null>
  shredKeysForConversations(conversationIds: string[]): Promise<number>
}

export class PostgresConversationPrivacyKeyRepository implements ConversationPrivacyKeyRepository {
  async ensureDataKey(tenantId: string, conversationId: string): Promise<Buffer> {
    const existing = await prisma.conversationPrivacyKey.findUnique({
      where: { conversationId },
      select: { wrappedKey: true, tenantId: true },
    })
    if (existing) {
      if (existing.tenantId !== tenantId) {
        throw new Error('conversation_privacy_key: tenant mismatch')
      }
      return unwrapConversationDataKey(tenantId, existing.wrappedKey)
    }

    const dataKey = generateConversationDataKey()
    const wrappedKey = wrapConversationDataKey(tenantId, dataKey)
    await prisma.conversationPrivacyKey.create({
      data: { conversationId, tenantId, wrappedKey },
    })
    return dataKey
  }

  async getDataKey(tenantId: string, conversationId: string): Promise<Buffer | null> {
    const row = await prisma.conversationPrivacyKey.findUnique({
      where: { conversationId },
      select: { wrappedKey: true, tenantId: true },
    })
    if (!row) return null
    if (row.tenantId !== tenantId) return null
    return unwrapConversationDataKey(tenantId, row.wrappedKey)
  }

  async shredKeysForConversations(conversationIds: string[]): Promise<number> {
    if (conversationIds.length === 0) return 0
    const result = await prisma.conversationPrivacyKey.deleteMany({
      where: { conversationId: { in: conversationIds } },
    })
    return result.count
  }
}
