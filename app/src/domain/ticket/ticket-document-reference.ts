import { prisma } from '@/lib/db'

/**
 * Igaz, ha a dokumentum a ticket bemeneti, legacy forrás- vagy komment-
 * csatolmányaként elérhető. Ez a document_read és dokumentumspecifikus toolok
 * ticket-scope jogosultsági kapuja.
 */
export async function ticketReferencesDocument(
  ticketId: string,
  documentId: string,
): Promise<boolean> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { sourceDocumentId: true },
  })
  if (ticket?.sourceDocumentId === documentId) return true

  const inputAttachment = await prisma.ticketAttachment.findUnique({
    where: { ticketId_documentId: { ticketId, documentId } },
    select: { id: true },
  })
  if (inputAttachment) return true

  const commentAttachment = await prisma.ticketCommentAttachment.findFirst({
    where: { documentId, comment: { ticketId } },
    select: { id: true },
  })
  return Boolean(commentAttachment)
}
