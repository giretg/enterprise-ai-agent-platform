import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import {
  deriveScopeDataKey,
  generateConversationDataKey,
  unwrapConversationDataKey,
  wrapConversationDataKey,
} from '@/domain/privacy/conversation-privacy-key-crypto'
import type { ConversationPrivacyKeyRepository } from '@/repositories/interfaces'

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

  /**
   * A `conversation` scope-azonosító feladat-ticket futásnál a ticket id-ja, amihez
   * nincs `Conversation` sor — ilyenkor a kulcssor beszúrása idegen kulcs hibára fut.
   * Ott determinisztikus scope-kulcsot adunk (l. `deriveScopeDataKey`), különben a
   * fail-closed szabály az egész modellhívást megállítaná.
   */
  async ensureScopeDataKey(tenantId: string, scopeType: string, scopeId: string): Promise<Buffer> {
    if (scopeType === 'conversation') {
      try {
        return await this.ensureDataKey(tenantId, scopeId)
      } catch (error) {
        if (!isMissingConversation(error)) throw error
      }
    }
    return deriveScopeDataKey(tenantId, scopeType, scopeId)
  }

  async getScopeDataKey(
    tenantId: string,
    scopeType: string,
    scopeId: string,
  ): Promise<Buffer | null> {
    if (scopeType === 'conversation') {
      const existing = await this.getDataKey(tenantId, scopeId)
      if (existing) return existing
      const conversation = await prisma.conversation
        .findUnique({ where: { id: scopeId }, select: { id: true } })
        .catch(() => null)
      // Létező beszélgetésnél a hiányzó kulcssor szándékos törlés (crypto-shredding).
      if (conversation) return null
    }
    return deriveScopeDataKey(tenantId, scopeType, scopeId)
  }

  async shredKeysForConversations(conversationIds: string[]): Promise<number> {
    if (conversationIds.length === 0) return 0
    const result = await prisma.conversationPrivacyKey.deleteMany({
      where: { conversationId: { in: conversationIds } },
    })
    return result.count
  }
}

function isMissingConversation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003'
}
