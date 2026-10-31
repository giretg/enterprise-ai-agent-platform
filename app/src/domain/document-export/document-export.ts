/**
 * #1024: letölthető fájl előállítása a munkatárs válaszából (XLSX, CSV, DOCX, PDF, MD).
 * Nem ír céges rendszerbe és nem ér el külső szolgáltatást: a kész fájl a platform ideiglenes
 * tárolójába kerül (7 nap), a letöltés a platformon át, hozzáférés-ellenőrzéssel megy.
 */
import { markdownBlocks } from './markdown-blocks'
import { renderDocx } from './render-docx'
import { renderPdf } from './render-pdf'
import { renderCsv, renderXlsx, type SheetCell, type SheetInput } from './render-sheet'

export const DOCUMENT_EXPORT_FORMATS = ['xlsx', 'csv', 'docx', 'pdf', 'md'] as const
export type DocumentExportFormat = (typeof DOCUMENT_EXPORT_FORMATS)[number]

export const DOCUMENT_EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const DOCUMENT_EXPORT_MAX_BYTES = 10 * 1024 * 1024
export const DOCUMENT_EXPORT_MAX_ROWS = 100_000
const MAX_SHEETS = 20
const MAX_COLUMNS = 200
const MAX_CELL_CHARS = 32_000

export const DOCUMENT_EXPORT_MIME: Record<DocumentExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
}

export class DocumentExportError extends Error {
  constructor(
    readonly code: 'document_export_invalid_content' | 'document_export_too_large',
    readonly detail: string,
  ) {
    super(detail)
    this.name = 'DocumentExportError'
  }
}

const invalid = (detail: string) => new DocumentExportError('document_export_invalid_content', detail)

/** Fájlnév a felhasználónak: útvonal- és vezérlőkarakter nélkül, a formátum kiterjesztésével. */
export function exportFileName(raw: string | undefined, format: DocumentExportFormat): string {
  const cleaned = (raw ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
  const base = cleaned.replace(/\.(xlsx|csv|docx|pdf|md)$/i, '').trim().slice(0, 120)
  return `${base || 'dokumentum'}.${format}`
}

function cell(value: unknown, where: string): SheetCell {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(`${where}: a szám nem véges`)
    return value
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > MAX_CELL_CHARS) throw invalid(`${where}: a cella legfeljebb ${MAX_CELL_CHARS} karakter`)
    return value
  }
  // Beágyazott objektum: olvasható szövegként marad.
  return JSON.stringify(value).slice(0, MAX_CELL_CHARS)
}

/**
 * A `sheets` JSON-szöveg: munkalapok tömbje (vagy egyetlen munkalap-objektum):
 * `{ name?, headers?: string[], rows: [[…], …], numberFormats?: { [fejléc]: "#,##0 \"Ft\"" } }`.
 */
export function parseSheets(raw: string): SheetInput[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw invalid('sheets: nem érvényes JSON')
  }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { sheets?: unknown }).sheets) ? (parsed as { sheets: unknown[] }).sheets : [parsed]
  if (list.length === 0) throw invalid('sheets: legalább egy munkalap kell')
  if (list.length > MAX_SHEETS) throw invalid(`sheets: legfeljebb ${MAX_SHEETS} munkalap`)
  let totalRows = 0
  return list.map((item, s) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid(`sheets[${s}]: objektum kell (name, headers, rows)`)
    const sheet = item as { name?: unknown; headers?: unknown; rows?: unknown; numberFormats?: unknown }
    if (sheet.headers !== undefined && !Array.isArray(sheet.headers)) throw invalid(`sheets[${s}].headers: szövegek tömbje kell`)
    if (!Array.isArray(sheet.rows)) throw invalid(`sheets[${s}].rows: sorok tömbje kell`)
    const headers = ((sheet.headers as unknown[] | undefined) ?? []).map((h) => String(h ?? ''))
    totalRows += sheet.rows.length
    if (totalRows > DOCUMENT_EXPORT_MAX_ROWS) {
      throw new DocumentExportError('document_export_too_large', `legfeljebb ${DOCUMENT_EXPORT_MAX_ROWS} sor`)
    }
    const rows = sheet.rows.map((row, r) => {
      if (!Array.isArray(row)) throw invalid(`sheets[${s}].rows[${r}]: a sor értékek tömbje kell`)
      if (row.length > MAX_COLUMNS) throw invalid(`sheets[${s}].rows[${r}]: legfeljebb ${MAX_COLUMNS} oszlop`)
      return row.map((value, c) => cell(value, `sheets[${s}].rows[${r}][${c}]`))
    })
    if (headers.length > MAX_COLUMNS) throw invalid(`sheets[${s}].headers: legfeljebb ${MAX_COLUMNS} oszlop`)
    const formats = sheet.numberFormats && typeof sheet.numberFormats === 'object' && !Array.isArray(sheet.numberFormats) ? sheet.numberFormats : {}
    const numberFormats = Object.fromEntries(
      Object.entries(formats).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length <= 100),
    )
    return { name: typeof sheet.name === 'string' ? sheet.name : '', headers, rows, numberFormats }
  })
}

export type DocumentExportInput = {
  format: DocumentExportFormat
  fileName?: string
  title?: string
  sheets?: string
  markdown?: string
}

export type RenderedDocument = {
  bytes: Buffer
  fileName: string
  mimeType: string
  format: DocumentExportFormat
  /** Táblázatnál a sorok száma (audit), egyébként null. */
  rowCount: number | null
}

export async function renderDocument(input: DocumentExportInput): Promise<RenderedDocument> {
  const { format } = input
  const fileName = exportFileName(input.fileName ?? input.title, format)
  const title = input.title?.trim() || undefined
  let bytes: Buffer
  let rowCount: number | null = null
  if (format === 'xlsx' || format === 'csv') {
    if (!input.sheets) throw invalid('xlsx/csv: a sheets mező kötelező')
    const sheets = parseSheets(input.sheets)
    if (format === 'csv' && sheets.length > 1) throw invalid('csv: csak egy munkalap lehet — több munkalaphoz válaszd az xlsx-et')
    rowCount = sheets.reduce((n, s) => n + s.rows.length, 0)
    bytes = format === 'csv' ? renderCsv(sheets[0]) : await renderXlsx(sheets, { title })
  } else {
    if (!input.markdown?.trim()) throw invalid(`${format}: a markdown mező kötelező`)
    if (format === 'md') {
      const body = input.markdown.trimEnd()
      bytes = Buffer.from(`${title && !body.startsWith('# ') ? `# ${title}\n\n` : ''}${body}\n`, 'utf8')
    } else {
      const blocks = markdownBlocks(input.markdown)
      bytes = format === 'docx' ? await renderDocx(blocks, { title }) : await renderPdf(blocks, { title })
    }
  }
  if (bytes.length > DOCUMENT_EXPORT_MAX_BYTES) {
    throw new DocumentExportError('document_export_too_large', `a fájl legfeljebb ${DOCUMENT_EXPORT_MAX_BYTES / 1024 / 1024} MB lehet`)
  }
  return { bytes, fileName, mimeType: DOCUMENT_EXPORT_MIME[format], format, rowCount }
}
