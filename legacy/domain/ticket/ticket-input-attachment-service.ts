import path from 'node:path'
import { readFile } from 'node:fs/promises'

import { prisma } from '@/lib/db'
import { resolveStoredDocumentDownload } from '@/lib/document-storage'

export type TicketInputAttachmentView = {
  id: string
  documentId: string
  filename: string
  mimeType: string | null
  byteSize: number | null
}

export async function listTicketInputAttachments(
  ticketId: string,
): Promise<TicketInputAttachmentView[]> {
  return prisma.ticketAttachment.findMany({
    where: { ticketId },
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      documentId: true,
      filename: true,
      mimeType: true,
      byteSize: true,
    },
  })
}

function resolveDocumentPath(storageRef: string): string | null {
  const uploadRoot = path.resolve(/* turbopackIgnore: true */ process.cwd(), 'uploads')
  const uploadRootPrefix = uploadRoot.endsWith(path.sep) ? uploadRoot : `${uploadRoot}${path.sep}`
  const absolutePath = path.resolve(/* turbopackIgnore: true */ process.cwd(), storageRef)
  return absolutePath.startsWith(uploadRootPrefix) ? absolutePath : null
}

export async function loadTicketInputAttachmentDownload(input: {
  ticketId: string
  attachmentId: string
  tenantId: string
}) {
  const attachment = await prisma.ticketAttachment.findFirst({
    where: {
      id: input.attachmentId,
      ticketId: input.ticketId,
      ticket: { tenantId: input.tenantId },
    },
    include: { document: { select: { storageRef: true } } },
  })
  if (!attachment) return null

  const absolutePath = resolveDocumentPath(attachment.document.storageRef)
  if (!absolutePath) return null

  let bytes: Buffer
  try {
    bytes = await readFile(absolutePath)
  } catch {
    return null
  }

  return resolveStoredDocumentDownload({
    bytes,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
  })
}
