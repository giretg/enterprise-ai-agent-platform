import type { ContactInquiryStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ContactInquiryRepository } from '@/repositories/interfaces'

export class PostgresContactInquiryRepository implements ContactInquiryRepository {
  async create(data: { name: string; phone: string; email: string; message: string }) {
    return prisma.contactInquiry.create({ data })
  }

  async findMany(filter?: { status?: ContactInquiryStatus; limit?: number }) {
    return prisma.contactInquiry.findMany({
      ...(filter?.status ? { where: { status: filter.status } } : {}),
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: filter?.limit ?? 100,
    })
  }

  async markReviewed(id: string, reviewedById: string) {
    return prisma.contactInquiry.update({
      where: { id },
      data: { status: 'reviewed', reviewedAt: new Date(), reviewedById },
    })
  }
}
