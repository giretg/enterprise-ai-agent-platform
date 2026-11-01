/** #1023: actual file parsers, bounded prompts and byte-exact transfers. npm test */
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { attachmentManifest, attachmentMime, extractText, readDocument, viewPdfPage, type BlobStorage } from '../src/attachments.ts'
import { readAttachmentTool, resolveAttachmentReferences } from '../src/attachment-tools.ts'
import { buildMessages } from '../src/engine.ts'
import { MemoryStore } from './memory-store.ts'
import type { Attachment } from '../src/store.ts'

// A real PDF with xref offsets; each page has searchable text and can be rasterized.
function pdf(pageCount: number, scanned = false) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids: string[] = []
  for (let page = 1; page <= pageCount; page++) {
    const id = objects.length + 1
    kids.push(`${id} 0 R`)
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`)
    const text = scanned ? '' : `BT /F1 12 Tf 72 720 Td (Page ${page}: termination notice ${page} days) Tj ET`
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  }
  objects[1] = `<< /Type /Pages /Count ${pageCount} /Kids [${kids.join(' ')}] >>`
  let out = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  return Buffer.from(`${out}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)
}

const store = new MemoryStore()
const conversation = await store.createConversation({ tenantId: 't', tenantSlug: 't', userId: 'u', agentId: 'a', agentName: 'A' })
const blobs = new Map<string, Buffer>()
const storage: BlobStorage = { put: async (path, bytes) => void blobs.set(path, bytes), get: async (path) => blobs.get(path)!, remove: async () => {} }
async function attach(name: string, data: Buffer): Promise<Attachment> {
  const mime = attachmentMime(name)!
  blobs.set(name, data)
  return store.addAttachment({ conversationId: conversation.id, name, mime, size: data.length, storagePath: name, extractedText: await extractText(data, mime) })
}

const document = await attach('contract.pdf', pdf(80))
assert.equal(JSON.parse(document.extractedText!).pages, 80)
const page = JSON.parse((await readAttachmentTool(store, storage, conversation.id, 'attachment_read', { id: document.id, pages: [62, 62] })).text)
assert.match(page.content, /62\. oldal[\s\S]*termination notice 62 days/)
const search = JSON.parse((await readAttachmentTool(store, storage, conversation.id, 'attachment_search', { id: document.id, query: 'notice 62' })).text)
assert.match(search.matches[0].location, /62/)
assert.match(await viewPdfPage(pdf(1, true), 1), /^data:image\/png;base64,/)
assert.equal((await readDocument(pdf(1, true), 'application/pdf')).pages![0].trim(), '')
await assert.rejects(viewPdfPage(pdf(1), 2))

const workbook = new ExcelJS.Workbook()
const sheet = workbook.addWorksheet('Revenue')
sheet.addRow(['month', 'amount'])
for (let i = 0; i < 5000; i++) sheet.addRow(['March', 10])
const excel = await attach('revenue.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()))
const manifest = JSON.parse(excel.extractedText!)
assert.equal(manifest.sheets[0].rows, 5001)
assert.deepEqual(manifest.sheets[0].headers, ['month', 'amount'])
assert.ok(manifest.preview.split('\n').length <= 21)
const tail = JSON.parse((await readAttachmentTool(store, storage, conversation.id, 'attachment_read', { id: excel.id, sheet: 'Revenue', rows: [4999, 5001] })).text)
assert.match(tail.content, /5001\. sor/)
const warehouse = await resolveAttachmentReferences(store, storage, conversation.id, 'warehouse.prepare_import', { fileBase64: `attachment://${excel.id}` })
const passed = Buffer.from(warehouse.fileBase64 as string, 'base64')
assert.deepEqual(passed, blobs.get(excel.storagePath))
const loaded = new ExcelJS.Workbook()
await loaded.xlsx.load(passed as unknown as ArrayBuffer)
let total = 0
loaded.worksheets[0].eachRow((row, i) => { if (i > 1) total += Number(row.getCell(2).value) })
assert.equal(total, 50_000)
const sandbox = await resolveAttachmentReferences(store, storage, conversation.id, 'sandbox_run', { inputs: `attachment://${excel.id}` })
const input = JSON.parse(sandbox.inputFiles as string)[0]
assert.deepEqual(Buffer.from(input.contentBase64, 'base64'), passed)
assert.match(input.path, /\.xlsx$/)

for (const ext of ['docx', 'pptx']) {
  const zip = new JSZip()
  zip.file(ext === 'docx' ? 'word/document.xml' : 'ppt/slides/slide1.xml', '<w:document xmlns:w="urn:w"><w:p><w:r><w:t>Árvíz &amp; szerződés</w:t></w:r></w:p></w:document>')
  const att = await attach(`source.${ext}`, await zip.generateAsync({ type: 'nodebuffer' }))
  assert.match((await readAttachmentTool(store, storage, conversation.id, 'attachment_read', { id: att.id })).text, /Árvíz & szerződés/)
}
const csv = await readDocument(Buffer.from('name,value\n"hello, world",12\n"multi\nline",20'), 'text/csv')
assert.equal(csv.sheets![0].rows.length, 3)
assert.equal(csv.sheets![0].columns, 2)
assert.equal(csv.sheets![0].rows[1][0], 'hello, world')
const json = await attach('data.json', Buffer.from('{"secret":"old body not repeated"}'))
assert.match((await readAttachmentTool(store, storage, conversation.id, 'attachment_read', { id: json.id })).text, /old body/)
const drive = await resolveAttachmentReferences(store, storage, conversation.id, 'google_drive_upload_file', { contentBase64: `attachment://${document.id}`, parentFolderId: 'contracts', idempotencyKey: 'stable' })
assert.equal(drive.name, 'contract.pdf')
assert.equal(drive.parentFolderId, 'contracts')
assert.equal(drive.idempotencyKey, 'stable')
assert.deepEqual(Buffer.from(drive.contentBase64 as string, 'base64'), blobs.get(document.storagePath))
const kb = await resolveAttachmentReferences(store, storage, conversation.id, 'kb_ingest', { content: `attachment://${json.id}` })
assert.equal(kb.filename, json.name)
assert.equal(kb.content, undefined)
assert.deepEqual(Buffer.from(kb.contentBase64 as string, 'base64'), blobs.get(json.storagePath))
await assert.rejects(readAttachmentTool(store, storage, 'other', 'attachment_read', { id: document.id }), /ebben a beszélgetésben/)
await assert.rejects(resolveAttachmentReferences(store, storage, 'other', 'google_drive_upload_file', { contentBase64: `attachment://${document.id}` }), /ebben a beszélgetésben/)
await assert.rejects(readAttachmentTool(store, storage, conversation.id, 'attachment_read', { id: excel.id, rows: [1, 9000] }))
await assert.rejects(resolveAttachmentReferences(store, storage, conversation.id, 'gmail_send', { body: `attachment://${document.id}` }))
const large = await store.addAttachment({ ...document, name: 'large.pdf', size: 11 * 1024 * 1024 })
await assert.rejects(resolveAttachmentReferences(store, storage, conversation.id, 'google_drive_upload_file', { contentBase64: `attachment://${large.id}` }), /túl nagy/)

// Ten turns, five attachments: old extracted text never appears in subsequent prompts.
for (let turn = 0; turn < 10; turn++) {
  await store.addMessage({ conversationId: conversation.id, turnId: `turn-${turn}`, role: 'user', content: 'Question', attachments: [document, excel, json, document, excel] })
}
const messages = await buildMessages({ store, storage, limits: { historyMessages: 30, maxSteps: 25, maxTurnSeconds: 2400, maxAttemptsPerStep: 3, toolResultChars: 12000 } }, conversation, { definition: '', tools: [] }, [], 'turn-9')
const old = messages.slice(1, -1).map((m) => String(m.content)).join('\n')
const latest = String(messages.at(-1)?.content)
assert.ok(!old.includes('termination notice') && !old.includes('old body not repeated') && !old.includes('March'))
assert.ok(!old.includes('"preview"'))
assert.match(latest, /termination notice/)
assert.match(latest, /"preview"/)
assert.ok(old.length < 40_000, `az előzmény ${old.length} karakter, a csatolmány-szöveg nélkül kell maradnia`)
assert.ok(!attachmentManifest(document, false).includes('termination notice'))
console.log('platform-chat attachments: all passed (80-page PDF, 5000-row XLSX, Office, scoped access, byte-exact transfer, compact history)')
