/**
 * Chat -> task promóció bemeneti csatolmányainak regressziós tesztje.
 *
 * Run: npx tsx scripts/ticket-input-attachments.test.ts
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { config } from 'dotenv'

import { TicketInputAttachmentList } from '../src/components/tickets/ticket-input-attachment-list'
import { buildPromotedTaskAttachmentTransfer } from '../src/domain/agent/skill-task-promotion'
import {
  buildOriginalDocumentMetadata,
  resolveStoredDocumentDownload,
} from '../src/lib/document-storage'
import { ticketInputAttachmentDownloadUrl } from '../src/lib/ticket-input-attachments'

const attachmentDocuments = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    filename: 'tulajdoni-lap.pdf',
    mimeType: 'application/pdf',
    metadata: { byteSize: 1234 },
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    filename: 'nyilvantartas.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    metadata: { byteSize: 5678 },
  },
]
const transfer = buildPromotedTaskAttachmentTransfer(attachmentDocuments)

assert.equal(
  transfer.sourceDocumentId,
  '11111111-1111-4111-8111-111111111111',
  'az első bemeneti dokumentum legyen a legacy sourceDocumentId is',
)
assert.deepEqual(transfer.attachments, [
  {
    documentId: '11111111-1111-4111-8111-111111111111',
    filename: 'tulajdoni-lap.pdf',
    mimeType: 'application/pdf',
    byteSize: 1234,
  },
  {
    documentId: '22222222-2222-4222-8222-222222222222',
    filename: 'nyilvantartas.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    byteSize: 5678,
  },
])

const originalPdf = resolveStoredDocumentDownload({
  bytes: Buffer.from('%PDF-1.7\noriginal'),
  filename: 'tulajdoni-lap.pdf',
  mimeType: 'application/pdf',
})
assert.equal(originalPdf.filename, 'tulajdoni-lap.pdf')
assert.equal(originalPdf.contentType, 'application/pdf')
assert.equal(originalPdf.originalAvailable, true)
assert.deepEqual(buildOriginalDocumentMetadata(1234, { extraction: { blocks: [] } }), {
  extraction: { blocks: [] },
  storageFormat: 'original',
  byteSize: 1234,
})

const legacyExtraction = resolveStoredDocumentDownload({
  bytes: Buffer.from('# Oldal 1\n\nKinyert szöveg', 'utf8'),
  filename: 'tulajdoni-lap.pdf',
  mimeType: 'application/pdf',
})
assert.equal(legacyExtraction.filename, 'tulajdoni-lap.pdf.txt')
assert.equal(legacyExtraction.contentType, 'text/plain; charset=utf-8')
assert.equal(legacyExtraction.originalAvailable, false)

assert.equal(
  ticketInputAttachmentDownloadUrl('ticket-1', 'attachment-2'),
  '/api/v1/tickets/ticket-1/attachments/attachment-2',
)

const markup = renderToStaticMarkup(
  createElement(TicketInputAttachmentList, {
    ticketId: 'ticket-1',
    attachments: [
      {
        id: 'attachment-2',
        documentId: 'document-2',
        filename: 'tulajdoni-lap.pdf',
        mimeType: 'application/pdf',
        byteSize: 1234,
      },
    ],
  }),
)
assert.match(markup, /Bemeneti csatolmányok/)
assert.match(markup, /tulajdoni-lap\.pdf/)
assert.match(markup, /href="\/api\/v1\/tickets\/ticket-1\/attachments\/attachment-2"/)
assert.match(markup, /Letöltés/)

async function verifyRepositoryPersistence(): Promise<void> {
  config({ path: resolve(process.cwd(), '.env.local'), quiet: true })
  if (!process.env.DATABASE_URL_TEST || !process.env.DIRECT_URL_TEST) {
    throw new Error('DATABASE_URL_TEST és DIRECT_URL_TEST szükséges az integrációs regresszióhoz')
  }
  process.env.DATABASE_MODE = 'test'

  const [
    { setActiveDatabaseMode },
    { prisma },
    { PostgresTicketRepository },
    { ticketReferencesDocument },
    { listTicketInputAttachments, loadTicketInputAttachmentDownload },
  ] = await Promise.all([
    import('../src/lib/database-mode'),
    import('../src/lib/db'),
    import('../src/repositories/postgres/ticket-repository'),
    import('../src/domain/ticket/ticket-document-reference'),
    import('../src/domain/ticket/ticket-input-attachment-service'),
  ])
  setActiveDatabaseMode('test')

  const suffix = randomUUID()
  const userId = randomUUID()
  const tenantId = randomUUID()
  const documentIds = [randomUUID(), randomUUID()]
  const storageRefs = [
    `uploads/test-${suffix}-tulajdoni-lap.pdf`,
    `uploads/test-${suffix}-nyilvantartas.xlsx`,
  ]
  let ticketId: string | null = null

  try {
    await mkdir(resolve(process.cwd(), 'uploads'), { recursive: true })
    await writeFile(resolve(process.cwd(), storageRefs[0]), Buffer.from('%PDF-1.7\noriginal-test'))
    await writeFile(resolve(process.cwd(), storageRefs[1]), Buffer.from('PK\u0003\u0004original-test'))
    await prisma.user.create({
      data: {
        id: userId,
        externalAuthId: `ticket-attachment-test-${suffix}`,
        email: `ticket-attachment-${suffix}@example.test`,
        name: 'Ticket attachment test',
        status: 'active',
      },
    })
    for (const [index, documentId] of documentIds.entries()) {
      await prisma.document.create({
        data: {
          id: documentId,
          filename: attachmentDocuments[index].filename,
          storageRef: storageRefs[index],
          extractedText: `test-${index}`,
          uploadedById: userId,
          mimeType: attachmentDocuments[index].mimeType,
          metadata: buildOriginalDocumentMetadata(attachmentDocuments[index].metadata.byteSize),
        },
      })
    }

    const repository = new PostgresTicketRepository()
    const ticket = await repository.create(
      {
        tenantId,
        type: 'interaction',
        title: 'PDF-es task-promóció regresszió',
        state: 'ready',
        assigneeType: null,
        assigneeId: null,
        agentId: null,
        payload: { attachmentDocumentIds: documentIds },
        sourceDocumentId: documentIds[0],
        executeAfter: null,
        dueBy: null,
        createdById: userId,
      },
      {
        attachments: transfer.attachments.map((attachment, index) => ({
          ...attachment,
          documentId: documentIds[index],
        })),
      },
    )
    ticketId = ticket.id

    const persisted = await prisma.ticket.findUnique({
      where: { id: ticket.id },
      include: { attachments: { orderBy: { seq: 'asc' } } },
    })
    assert.equal(persisted?.sourceDocumentId, documentIds[0])
    assert.deepEqual(persisted?.attachments.map((attachment) => attachment.documentId), documentIds)
    assert.deepEqual(persisted?.attachments.map((attachment) => attachment.seq), [1, 2])
    assert.equal(await ticketReferencesDocument(ticket.id, documentIds[0]), true)
    assert.equal(
      await ticketReferencesDocument(ticket.id, documentIds[1]),
      true,
      'a második bemeneti csatolmány is olvasható legyen az agent tooljaival',
    )
    assert.equal(await ticketReferencesDocument(ticket.id, randomUUID()), false)

    const visibleAttachments = await listTicketInputAttachments(ticket.id)
    assert.deepEqual(visibleAttachments.map((attachment) => attachment.filename), [
      'tulajdoni-lap.pdf',
      'nyilvantartas.xlsx',
    ])
    const download = await loadTicketInputAttachmentDownload({
      ticketId: ticket.id,
      attachmentId: visibleAttachments[0].id,
      tenantId,
    })
    assert.equal(download?.filename, 'tulajdoni-lap.pdf')
    assert.equal(download?.contentType, 'application/pdf')
    assert.equal(download?.bytes.subarray(0, 5).toString('ascii'), '%PDF-')
  } finally {
    if (ticketId) await prisma.ticket.delete({ where: { id: ticketId } }).catch(() => undefined)
    await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined)
    await Promise.all(storageRefs.map((storageRef) => unlink(resolve(process.cwd(), storageRef)).catch(() => undefined)))
  }
}

verifyRepositoryPersistence()
  .then(() => console.log('ticket-input-attachments.test.ts: ok'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
