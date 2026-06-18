import type { Conversation, Message, MessageRole } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ConversationRepository } from '../interfaces'

function encodeContent(content: string): string {
  return `inline:${content}`
}

function decodeContent(contentRef: string | null | undefined): string | null {
  if (!contentRef) return null
  if (contentRef.startsWith('inline:')) return contentRef.slice('inline:'.length)
  return contentRef
}

function decodePreviewText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string }
    if (typeof parsed.text === 'string') return parsed.text
  } catch {
    // plain text
  }
  return content
}

export class PostgresConversationRepository implements ConversationRepository {
  async create(data: {
    tenantId: string | null
    agentId: string
    title?: string | null
    createdById: string
  }): Promise<Conversation> {
    return prisma.conversation.create({
      data: {
        tenantId: data.tenantId,
        agentId: data.agentId,
        title: data.title ?? null,
        createdById: data.createdById,
      },
    })
  }

  async findById(id: string): Promise<Conversation | null> {
    return prisma.conversation.findUnique({ where: { id } })
  }

  async findByIdForTenant(id: string, tenantId: string | null): Promise<Conversation | null> {
    const row = await prisma.conversation.findUnique({ where: { id } })
    if (!row) return null
    if (tenantId && row.tenantId && row.tenantId !== tenantId) return null
    return row
  }

  async findManyForAgentUser(params: {
    agentId: string
    createdById: string
    tenantId?: string | null
    limit?: number
  }) {
    const rows = await prisma.conversation.findMany({
      where: {
        agentId: params.agentId,
        createdById: params.createdById,
        status: 'active',
        tenantId: params.tenantId ?? null,
      },
      orderBy: { lastMessageAt: 'desc' },
      take: params.limit ?? 50,
      include: {
        messages: {
          where: { role: 'user', contentDeletedAt: null },
          orderBy: { seq: 'asc' },
          take: 1,
          select: { contentRef: true },
        },
      },
    })

    return rows.map(({ messages, ...conversation }) => {
      const raw = messages[0]?.contentRef ? decodeContent(messages[0].contentRef) : null
      return {
        ...conversation,
        previewText: raw ? decodePreviewText(raw) : null,
      }
    })
  }

  async appendMessage(data: {
    conversationId: string
    role: MessageRole
    content: string
    agentVersion?: number | null
    model?: string | null
    ticketRefId?: string | null
  }): Promise<Message> {
    return prisma.$transaction(async (tx) => {
      const last = await tx.message.findFirst({
        where: { conversationId: data.conversationId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      })
      const seq = (last?.seq ?? 0) + 1

      const message = await tx.message.create({
        data: {
          conversationId: data.conversationId,
          seq,
          role: data.role,
          agentVersion: data.agentVersion ?? null,
          model: data.model ?? null,
          contentRef: encodeContent(data.content),
          ticketRefId: data.ticketRefId ?? null,
        },
      })

      await tx.conversation.update({
        where: { id: data.conversationId },
        data: { lastMessageAt: new Date() },
      })

      return message
    })
  }

  async findMessages(conversationId: string): Promise<Array<Message & { content: string | null }>> {
    const rows = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { seq: 'asc' },
    })
    return rows.map((row) => ({
      ...row,
      content: row.contentDeletedAt ? null : decodeContent(row.contentRef),
    }))
  }

  async findMessageById(id: string): Promise<Message | null> {
    return prisma.message.findUnique({ where: { id } })
  }

  async deleteMessageContent(messageId: string): Promise<Message> {
    return prisma.message.update({
      where: { id: messageId },
      data: {
        contentRef: null,
        contentDeletedAt: new Date(),
      },
    })
  }

  async linkMessageToTicket(messageId: string, ticketId: string): Promise<Message> {
    return prisma.message.update({
      where: { id: messageId },
      data: { ticketRefId: ticketId },
    })
  }
}

export { decodeContent, encodeContent }
