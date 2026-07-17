/**
 * Smoke: document_read a valódi 043_15 PDF-en (DB).
 * Futtatás: npx tsx scripts/document-read-smoke.ts
 */
import fs from 'node:fs'
import { Client } from 'pg'
import { blocksFromDocument, readDocumentPages } from '../src/lib/document-read'

async function main() {
  let url = fs.readFileSync('.env.local', 'utf8').match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim()
  if (!url) throw new Error('DATABASE_URL missing')
  if (
    (url.startsWith('"') && url.endsWith('"')) ||
    (url.startsWith("'") && url.endsWith("'"))
  ) {
    url = url.slice(1, -1)
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await client.connect()

  const docId = process.argv[2] ?? '0e14cc4c-75a7-4a2a-b864-1540068e1dc5'
  const { rows } = await client.query(
    `SELECT id, filename, extracted_text, metadata FROM documents WHERE id=$1`,
    [docId],
  )
  const doc = rows[0]
  if (!doc) throw new Error(`document not found: ${docId}`)

  const blocks = blocksFromDocument(doc.metadata, doc.extracted_text)
  console.log(`document=${doc.filename} blocks=${blocks.length}`)

  const byQuery = readDocumentPages({
    documentId: doc.id,
    filename: doc.filename,
    blocks,
    query: '043/15',
    maxChars: 8000,
  })
  console.log(
    'query 043/15 →',
    JSON.stringify(
      {
        matchCount: byQuery.matchCount,
        pages: byQuery.pages.map((p) => ({ page: p.page, heading: p.heading, len: p.text.length })),
        truncated: byQuery.truncated,
        preview: byQuery.pages[0]?.text.slice(0, 180),
      },
      null,
      2,
    ),
  )

  const byPages = readDocumentPages({
    documentId: doc.id,
    filename: doc.filename,
    blocks,
    pages: '1-2',
  })
  console.log(
    'pages 1-2 →',
    byPages.pages.map((p) => ({ page: p.page, len: p.text.length })),
    'truncated=',
    byPages.truncated,
  )

  await client.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
