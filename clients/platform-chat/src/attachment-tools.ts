/** Beszélgetéshez kötött helyi olvasás és MCP-átadás (#1023). */
import { attachmentSandboxPath, readDocument, viewPdfPage, type BlobStorage } from './attachments.ts'
import type { Attachment, Store } from './store.ts'

const READ_LIMIT = 12_000
const IMAGE_VIEW_MAX_BYTES = 5 * 1024 * 1024
const ATTACHMENT_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const ATTACHMENT_REF = /^attachment:\/\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i
export const ATTACHMENT_TOOLS = ['attachment_read', 'attachment_search', 'attachment_view'] as const
export const ATTACHMENT_TOOL_DEFINITIONS = ATTACHMENT_TOOLS.map((name) => ({
  type: 'function',
  function: {
    name,
    description: name === 'attachment_read'
      ? 'Read a bounded attachment excerpt. pages and rows are inclusive 1-based [start,end]; offset is a 0-based character offset. Results cite page/row numbers. Read further using nextOffset. For totals/filtering over a table use sandbox_run or warehouse.prepare_import with attachment://id; never calculate from a preview.'
      : name === 'attachment_search'
        ? 'Find literal text in the full attachment, returning page/row/line numbers and context. offset paginates matches.'
        : 'View a PDF page or attached image using the company model. page is 1-based. If the model cannot accept images it will be told.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ...(name === 'attachment_view' ? { page: { type: 'integer', minimum: 1 } }
          : name === 'attachment_search' ? { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }
            : {
              pages: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2 },
              sheet: { type: 'string' },
              rows: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2 },
              offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: READ_LIMIT },
            }),
      },
      required: name === 'attachment_search' ? ['id', 'query'] : ['id'], additionalProperties: false,
    },
  },
}))

export async function conversationAttachment(store: Store, conversationId: string, id: unknown): Promise<Attachment> {
  if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)) throw new Error('Érvénytelen csatolmány-azonosító.')
  const [att] = await store.getAttachments(conversationId, [id])
  if (!att || att.conversationId !== conversationId) throw new Error('A csatolmány nem érhető el ebben a beszélgetésben.')
  return att
}

function integer(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('Érvénytelen olvasási tartomány.')
  return value
}

function range(value: unknown, total: number): [number, number] {
  if (value === undefined) return [1, total]
  if (!Array.isArray(value) || value.length !== 2) throw new Error('A tartomány két sorszámból áll: [első, utolsó].')
  const start = integer(value[0], 1), end = integer(value[1], total)
  if (start < 1 || end < start || end > total) throw new Error('Nincs ilyen oldal vagy sor a fájlban.')
  return [start, end]
}

export async function readAttachmentTool(store: Store, storage: BlobStorage, conversationId: string, name: string, args: Record<string, unknown>) {
  const att = await conversationAttachment(store, conversationId, args.id)
  if (name === 'attachment_view') {
    if (att.mime.startsWith('image/') && att.size > IMAGE_VIEW_MAX_BYTES) throw new Error('A kép túl nagy a közvetlen megjelenítéshez. Legfeljebb 5 MB-os képet csatolj.')
    if (att.mime !== 'application/pdf' && !att.mime.startsWith('image/')) throw new Error('Képként PDF-oldal vagy képfájl nézhető meg.')
    const page = integer(args.page, 1)
    if (page < 1 || (att.mime.startsWith('image/') && page !== 1)) throw new Error('Nincs ilyen oldal a fájlban.')
    return { text: `${att.name}, ${page}. oldal`, image: { attachmentId: att.id, page } }
  }
  if (att.mime.startsWith('image/')) throw new Error('A képhez használd az attachment_view eszközt.')
  const doc = await readDocument(await storage.get(att.storagePath), att.mime)
  const offset = integer(args.offset, 0)
  const units: Array<{ location: string; text: string }> = []
  if (doc.pages) {
    const [start, end] = range(name === 'attachment_read' ? args.pages : undefined, doc.pages.length)
    doc.pages.forEach((text, i) => { if (i + 1 >= start && i + 1 <= end) units.push({ location: `${i + 1}. oldal`, text }) })
  } else if (doc.sheets) {
    const sheets = args.sheet === undefined ? doc.sheets : doc.sheets.filter((s) => s.name === args.sheet)
    if (!sheets.length) throw new Error('Nincs ilyen munkalap a fájlban.')
    for (const sheet of sheets) {
      const [start, end] = range(name === 'attachment_read' ? args.rows : undefined, sheet.rows.length)
      sheet.rows.forEach((row, i) => { if (i + 1 >= start && i + 1 <= end) units.push({ location: `${sheet.name}, ${i + 1}. sor`, text: row.join(';') }) })
    }
  } else {
    const lines = (doc.text ?? '').split(/\r?\n/)
    const [start, end] = range(name === 'attachment_read' ? args.rows : undefined, lines.length)
    lines.forEach((text, i) => { if (i + 1 >= start && i + 1 <= end) units.push({ location: `${i + 1}. sor`, text }) })
  }
  if (name === 'attachment_search') {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 500) throw new Error('Adj meg legfeljebb 500 karakteres keresőkifejezést.')
    const query = args.query.toLocaleLowerCase()
    const matches: Array<{ location: string; context: string }> = []
    let total = 0
    for (const unit of units) {
      const lower = unit.text.toLocaleLowerCase()
      let index = lower.indexOf(query)
      while (index >= 0) {
        if (total >= offset && matches.length < 20) matches.push({ location: unit.location, context: unit.text.slice(Math.max(0, index - 120), index + query.length + 120) })
        total++
        index = lower.indexOf(query, index + query.length)
      }
    }
    return { text: JSON.stringify({ matches, total, nextOffset: offset + matches.length < total ? offset + matches.length : null }) }
  }
  if (args.pages !== undefined && !doc.pages) throw new Error('Ez a fájl nem oldalakra tagolt.')
  if (args.sheet !== undefined && !doc.sheets) throw new Error('Ez a fájl nem tartalmaz munkalapokat.')
  const text = units.map((u) => `[${u.location}]\n${u.text}`).join('\n')
  const limit = integer(args.limit, READ_LIMIT, READ_LIMIT)
  if (limit < 1) throw new Error('A limit legalább 1 legyen.')
  return { text: JSON.stringify({ content: text.slice(offset, offset + limit), nextOffset: offset + limit < text.length ? offset + limit : null, totalCharacters: text.length }) }
}

export async function attachmentImage(storage: BlobStorage, att: Attachment, page: number) {
  if (att.mime.startsWith('image/') && att.size > IMAGE_VIEW_MAX_BYTES) throw new Error('A kép túl nagy a közvetlen megjelenítéshez. Legfeljebb 5 MB-os képet csatolj.')
  const data = await storage.get(att.storagePath)
  return att.mime === 'application/pdf' ? viewPdfPage(data, page) : `data:${att.mime};base64,${data.toString('base64')}`
}

/** Csak a támogatott célmezőkben, teljes hivatkozásként engedünk bájtbehelyettesítést. */
export async function resolveAttachmentReferences(store: Store, storage: BlobStorage, conversationId: string, tool: string, original: Record<string, unknown>) {
  const args = { ...original }
  const refs = Object.entries(args).filter(([, value]) => typeof value === 'string' && value.includes('attachment://'))
  for (const [key, value] of refs) {
    const ref = typeof value === 'string' ? value.match(ATTACHMENT_REF) : null
    if (!ref) throw new Error('A csatolmány-hivatkozás önálló mezőérték legyen: attachment://<id>.')
    const supported = tool === 'google_drive_upload_file' ? ['contentBase64', 'textContent']
      : tool === 'warehouse.prepare_import' ? ['fileBase64']
        : tool === 'kb_ingest' ? ['contentBase64', 'content']
          : tool === 'sandbox_run' ? ['inputs'] : []
    if (!supported.includes(key)) throw new Error('Ez az eszköz ebben a mezőben nem fogad csatolmányt.')
    const att = await conversationAttachment(store, conversationId, ref[1])
    const max = tool === 'kb_ingest' ? 2 * 1024 * 1024 : tool === 'sandbox_run' ? 5 * 1024 * 1024 : 10 * 1024 * 1024
    if (att.size > max) throw new Error(`A(z) ${att.name} túl nagy a közvetlen átadáshoz (legfeljebb ${max / 1024 / 1024} MB). Töltsd fel az eszköz saját oldalán.`)
    const data = await storage.get(att.storagePath)
    if (data.length > max) throw new Error('A fájl túl nagy a közvetlen átadáshoz. Töltsd fel az eszköz saját oldalán.')
    if (tool === 'sandbox_run') {
      // Az id a névben ütközésmentes, a név szűrése kizárja a könyvtárbejárást.
      const path = attachmentSandboxPath(att)
      delete args.inputs
      args.inputFiles = JSON.stringify([{ path, contentBase64: data.toString('base64') }])
    } else if (tool === 'warehouse.prepare_import') {
      args.fileBase64 = data.toString('base64')
      args.fileName = att.name
    } else {
      delete args.content
      delete args.textContent
      args.contentBase64 = data.toString('base64')
      args.mimeType = att.mime
      args[tool === 'kb_ingest' ? 'filename' : 'name'] = att.name
    }
  }
  if (JSON.stringify(args).includes('attachment://')) throw new Error('Nem támogatott csatolmány-hivatkozás. Használd a céleszköz fájlmezőjét.')
  return args
}
