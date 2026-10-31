import { prisma } from '@/lib/db'
import type { DocumentExportStore, StoredDocumentExport } from '@/domain/document-export/document-export-store'

/** A fájl tartalma (`data`) csak a letöltésnél töltődik be. */
const META = {
  id: true,
  tenantId: true,
  userId: true,
  agentId: true,
  fileName: true,
  format: true,
  mimeType: true,
  byteSize: true,
  createdAt: true,
  expiresAt: true,
} as const

export class PostgresDocumentExportRepository implements DocumentExportStore {
  async create(input: Parameters<DocumentExportStore['create']>[0]): Promise<StoredDocumentExport> {
    return prisma.documentExport.create({ data: { ...input, data: new Uint8Array(input.data) }, select: META })
  }

  async find(id: string): Promise<StoredDocumentExport | null> {
    return prisma.documentExport.findUnique({ where: { id }, select: META })
  }

  async readData(id: string): Promise<Buffer | null> {
    const row = await prisma.documentExport.findUnique({ where: { id }, select: { data: true } })
    return row ? Buffer.from(row.data) : null
  }

  async deleteExpired(now: Date): Promise<number> {
    return (await prisma.documentExport.deleteMany({ where: { expiresAt: { lte: now } } })).count
  }
}
