/**
 * Csatolmányok (§6.4, D9): CSV, XLSX, PDF, TXT/MD, PNG/JPG; fájlonként 20 MB, üzenetenként 5 fájl.
 * Tárolás GCS-ben (`<tenant>/<beszélgetés>/<id>`), fejlesztéskor helyi mappában.
 * A modell a kinyert szöveget kapja (CSV/XLSX: első sorok + oszlopok), a képet közvetlenül.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Config } from './config.ts'
import { metadataAccessToken } from './queue.ts'

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 5
const TEXT_LIMIT = 60_000
const PREVIEW_ROWS = 200

const MIME_BY_EXT: Record<string, string> = {
  csv: 'text/csv',
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

function capText(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n… (a fájl további része levágva)` : text
}

function previewLines(text: string): string {
  const lines = text.split(/\r?\n/)
  const head = lines.slice(0, PREVIEW_ROWS).join('\n')
  return lines.length > PREVIEW_ROWS ? `${head}\n… (összesen ${lines.length} sor, az első ${PREVIEW_ROWS} látszik)` : head
}

/** Kinyert szöveg a modellnek; képnél null (azt közvetlenül kapja). */
export async function extractText(data: Buffer, mime: string): Promise<string | null> {
  if (mime.startsWith('image/')) return null
  if (mime === 'text/csv') return capText(previewLines(data.toString('utf8')))
  if (mime.startsWith('text/')) return capText(data.toString('utf8'))
  if (mime === 'application/pdf') {
    const [{ PDFParse }, worker] = await Promise.all([import('pdf-parse'), import('pdf-parse/worker')])
    PDFParse.setWorker(worker.getData())
    const parser = new PDFParse({ data: new Uint8Array(data) })
    try {
      return capText((await parser.getText()).text)
    } finally {
      await parser.destroy()
    }
  }
  if (mime.includes('spreadsheetml')) {
    const { default: ExcelJS } = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(data as unknown as ArrayBuffer)
    const out: string[] = []
    workbook.eachSheet((sheet) => {
      out.push(`## Munkalap: ${sheet.name} (${sheet.rowCount} sor, ${sheet.columnCount} oszlop)`)
      let n = 0
      sheet.eachRow({ includeEmpty: false }, (row) => {
        if (n++ >= PREVIEW_ROWS) return
        const values = Array.isArray(row.values) ? row.values.slice(1) : []
        out.push(values.map((v) => cellText(v)).join(';'))
      })
      if (sheet.rowCount > PREVIEW_ROWS) out.push(`… (az első ${PREVIEW_ROWS} sor látszik)`)
    })
    return capText(out.join('\n'))
  }
  return null
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
