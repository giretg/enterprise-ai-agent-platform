/**
 * Csatolmányok (§6.4, D9): CSV, XLSX, PDF, DOCX, PPTX, JSON, TXT/MD, PNG/JPG; fájlonként 20 MB, üzenetenként 5 fájl.
 * Tárolás GCS-ben (`<tenant>/<beszélgetés>/<id>`), fejlesztéskor helyi mappában.
 * A modell csak manifestet és kezdőrészletet kap; a teljes fájlt helyi eszközökkel olvassa.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { SaxesParser } from 'saxes'
import type { Config } from './config.ts'
import { metadataAccessToken } from './queue.ts'

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 5
const PREVIEW_CHARS = 3000
const PREVIEW_ROWS = 20

const MIME_BY_EXT: Record<string, string> = {
  csv: 'text/csv',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
}

/** A kiterjesztés dönt (a böngésző által küldött MIME-típus nem megbízható). null = nem támogatott. */
export function attachmentMime(fileName: string): string | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  return MIME_BY_EXT[ext] ?? null
}

export interface BlobStorage {
  put(path: string, data: Buffer, mime: string): Promise<void>
  get(path: string): Promise<Buffer>
  remove(paths: string[]): Promise<void>
}

export function createStorage(config: Config, fetchImpl: typeof fetch = fetch): BlobStorage {
  if (config.storage.kind === 'local') {
    const root = config.storage.dir
    return {
      async put(path, data) {
        const full = join(root, path)
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, data)
      },
      get: (path) => readFile(join(root, path)),
      async remove(paths) {
        await Promise.all(paths.map((p) => rm(join(root, p), { force: true })))
      },
    }
  }
  const bucket = config.storage.bucket
  const object = (path: string) => `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(path)}`
  const auth = async () => ({ authorization: `Bearer ${await metadataAccessToken(fetchImpl)}` })
  return {
    async put(path, data, mime) {
      const res = await fetchImpl(
        `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(path)}`,
        { method: 'POST', headers: { ...(await auth()), 'content-type': mime }, body: new Uint8Array(data) },
      )
      if (!res.ok) throw new Error(`gcs upload: ${res.status}`)
    },
    async get(path) {
      const res = await fetchImpl(`${object(path)}?alt=media`, { headers: await auth() })
      if (!res.ok) throw new Error(`gcs download: ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    },
    async remove(paths) {
      await Promise.all(
        paths.map(async (p) => {
          const res = await fetchImpl(object(p), { method: 'DELETE', headers: await auth() })
          if (!res.ok && res.status !== 404) throw new Error(`gcs delete: ${res.status}`)
        }),
      )
    },
  }
}

export type AttachmentDocument = {
  pages?: string[]
  sheets?: Array<{ name: string; rows: string[][]; columns: number }>
  text?: string
}

async function pdfParser(data: Buffer) {
  const [{ PDFParse }, worker] = await Promise.all([import('pdf-parse'), import('pdf-parse/worker')])
  PDFParse.setWorker(worker.getData())
  return new PDFParse({ data: new Uint8Array(data) })
}

export async function viewPdfPage(data: Buffer, page: number): Promise<string> {
  const parser = await pdfParser(data)
  try {
    const result = await parser.getScreenshot({ partial: [page], desiredWidth: 1600, imageDataUrl: true, imageBuffer: false })
    const image = result.pages.find((p) => p.pageNumber === page)
    if (!image) throw new Error('Nincs ilyen oldal a fájlban.')
    return image.dataUrl
  } finally {
    await parser.destroy()
  }
}

/** A teljes fájl csak a workerben él; a modell lapozott, korlátos részleteket kap. */
export async function readDocument(data: Buffer, mime: string): Promise<AttachmentDocument> {
  if (mime === 'application/pdf') {
    const parser = await pdfParser(data)
    try {
      return { pages: (await parser.getText()).pages.map((p) => p.text) }
    } finally {
      await parser.destroy()
    }
  }
  if (mime.includes('spreadsheetml') || mime === 'text/csv') {
    const { default: ExcelJS } = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    if (mime === 'text/csv') {
      const { Readable } = await import('node:stream')
      const first = data.toString('utf8').split(/\r?\n/, 1)[0]
      await workbook.csv.read(Readable.from([data]), { parserOptions: { delimiter: first.includes(';') ? ';' : ',' } })
    } else await workbook.xlsx.load(data as unknown as ArrayBuffer)
    let cells = 0
    return { sheets: workbook.worksheets.map((sheet) => {
      // ponytail: legfeljebb 2 millió cella memóriában; e fölött streaming olvasó szükséges.
      cells += sheet.rowCount * sheet.columnCount
      if (cells > 2_000_000) throw new Error('A táblázat túl nagy a közvetlen olvasáshoz. Használd az adattárházat.')
      const rows: string[][] = []
      for (let i = 1; i <= sheet.rowCount; i++) {
        const row = sheet.getRow(i)
        rows.push(Array.from({ length: sheet.columnCount }, (_, col) => cellText(row.getCell(col + 1).value)))
      }
      return { name: sheet.name, rows, columns: sheet.columnCount }
    }) }
  }
  if (mime.includes('wordprocessingml') || mime.includes('presentationml')) {
    const zip = await JSZip.loadAsync(data)
    const names = mime.includes('wordprocessingml') ? ['word/document.xml'] : Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const pages: string[] = []
    let size = 0
    for (const name of names) {
      const file = zip.file(name)
      if (!file) throw new Error('A dokumentum tartalma nem olvasható.')
      // ponytail: XML-ként legfeljebb 40 MB; nagyobb Office-fájlhoz streaming ZIP-olvasó kell.
      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        const stream = file.nodeStream()
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 40 * 1024 * 1024) {
            stream.pause()
            reject(new Error('A kicsomagolt dokumentum túl nagy.'))
          } else chunks.push(Buffer.from(chunk))
        }).on('error', reject).on('end', resolve).resume()
      })
      const content = Buffer.concat(chunks).toString('utf8')
      const parser = new SaxesParser({ xmlns: true })
      let text = '', inText = false
      parser.on('opentag', (tag) => {
        if (tag.local === 't') inText = true
        if (tag.local === 'tab') text += '\t'
        if (tag.local === 'br') text += '\n'
      })
      parser.on('text', (value) => { if (inText) text += value })
      parser.on('closetag', (tag) => {
        if (tag.local === 't') inText = false
        if (tag.local === 'p') text += '\n'
      })
      parser.write(content).close()
      pages.push(text)
    }
    return mime.includes('presentationml') ? { pages } : { text: pages.join('\n') }
  }
  return { text: data.toString('utf8') }
}

export function documentSummary(doc: AttachmentDocument) {
  return {
    ...(doc.pages ? { pages: doc.pages.length } : {}),
    ...(doc.sheets ? { sheets: doc.sheets.map((s) => ({ name: s.name, rows: s.rows.length, columns: s.columns, headers: s.rows[0]?.slice(0, 100).map((v) => v.slice(0, 200)) })) } : {}),
    ...(doc.text !== undefined ? { characters: doc.text.length, lines: doc.text.split(/\r?\n/).length } : {}),
  }
}

/** A meglévő extractedText mezőben csak manifest + rövid kezdőrészlet marad; nincs migráció. */
export async function extractText(data: Buffer, mime: string): Promise<string | null> {
  if (mime.startsWith('image/')) return null
  const doc = await readDocument(data, mime)
  const preview = doc.sheets ? doc.sheets.map((s) => `## ${s.name}\n${s.rows.slice(0, PREVIEW_ROWS).map((r) => r.join(';')).join('\n')}`).join('\n')
    : doc.pages ? doc.pages[0] ?? '' : doc.text ?? ''
  return JSON.stringify({ attachmentManifest: 1, ...documentSummary(doc), preview: preview.slice(0, PREVIEW_CHARS) })
}

export function attachmentSandboxPath(att: { id: string; name: string }): string {
  return `attachments/${att.id}-${att.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
}

export function attachmentManifest(att: { id: string; name: string; mime: string; size: number; extractedText: string | null }, preview: boolean): string {
  let metadata: Record<string, unknown> = {}
  let excerpt = att.extractedText ?? ''
  try {
    const parsed = JSON.parse(excerpt)
    if (parsed?.attachmentManifest === 1) {
      const { preview: head, attachmentManifest: _version, ...rest } = parsed
      metadata = rest
      excerpt = typeof head === 'string' ? head : ''
    }
  } catch { /* Régi csatolmány: a kezdőrészlet még sima szöveg. */ }
  return JSON.stringify({ id: att.id, reference: `attachment://${att.id}`, name: att.name, mime: att.mime, size: att.size, sandboxPath: `/work/in/${attachmentSandboxPath(att)}`, ...metadata,
    ...(preview && excerpt ? { preview: excerpt.slice(0, PREVIEW_CHARS) } : {}) })
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const v = value as { result?: unknown; text?: unknown; richText?: Array<{ text: string }> }
    if (v.result !== undefined) return cellText(v.result)
    if (typeof v.text === 'string') return v.text
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('')
    return JSON.stringify(value)
  }
  return String(value).replace(/[\r\n;]+/g, ' ')
}
