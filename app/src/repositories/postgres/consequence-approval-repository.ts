import { Prisma, type ConsequenceApproval, type ConsequenceApprovalStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ConsequenceApprovalRepository } from '@/repositories/interfaces'

export class PostgresConsequenceApprovalRepository implements ConsequenceApprovalRepository {
  async create(
    data: Omit<ConsequenceApproval, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ConsequenceApproval> {
    return prisma.consequenceApproval.create({
      data: {
        ...data,
        args: data.args as Prisma.InputJsonValue,
        resultMeta: (data.resultMeta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
  }

  async findById(id: string): Promise<ConsequenceApproval | null> {
    return prisma.consequenceApproval.findUnique({ where: { id } })
  }

  async listPendingByConversation(
    conversationId: string,
    createdAfter: Date,
  ): Promise<ConsequenceApproval[]> {
    // A `[conversationId, status]` index fedi; a beszélgetésenkénti darabszám
    // természetesen kicsi, de a felső korlát megvéd egy elszabadult futástól.
    return prisma.consequenceApproval.findMany({
      where: { conversationId, status: 'pending', createdAt: { gt: createdAfter } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    })
  }

  async casUpdateStatus(
    id: string,
    expectedStatus: ConsequenceApprovalStatus,
    patch: {
      status: ConsequenceApprovalStatus
      approvedBy?: string | null
      approvedAt?: Date | null
      rejectedBy?: string | null
      rejectedAt?: Date | null
      resultMeta?: unknown
      blockedToolCallId?: string | null
    },
  ): Promise<ConsequenceApproval | null> {
    const result = await prisma.consequenceApproval.updateMany({
      where: { id, status: expectedStatus },
      data: {
        status: patch.status,
        ...(patch.approvedBy !== undefined ? { approvedBy: patch.approvedBy } : {}),
        ...(patch.approvedAt !== undefined ? { approvedAt: patch.approvedAt } : {}),
        ...(patch.rejectedBy !== undefined ? { rejectedBy: patch.rejectedBy } : {}),
        ...(patch.rejectedAt !== undefined ? { rejectedAt: patch.rejectedAt } : {}),
        ...(patch.blockedToolCallId !== undefined
          ? { blockedToolCallId: patch.blockedToolCallId }
          : {}),
        ...(patch.resultMeta !== undefined
          ? { resultMeta: patch.resultMeta as Prisma.InputJsonValue }
          : {}),
      },
    })
    if (result.count === 0) return null
    return prisma.consequenceApproval.findUnique({ where: { id } })
  }
}
