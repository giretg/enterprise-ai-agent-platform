import { FileEditorError, WorkspaceStorage } from './workspace-storage'
import {
  xlsxReadSheet,
  xlsxWriteCells,
  xlsxAppendRows,
  xlsxFormatRange,
  xlsxApplyLayout,
  xlsxCreate,
} from './adapters/xlsx-adapter'
import { docxRead } from './adapters/docx-adapter'
import { pdfRead, pdfCreateFromTable } from './adapters/pdf-adapter'
import { pptxCreate } from './adapters/pptx-adapter'
import type { PptxSlideSpec } from './adapters/pptx-adapter'
import type {
  XlsxRow,
  XlsxCellChange,
  CellStyle,
  XlsxLayout,
  XlsxSheetSpec,
} from './adapters/xlsx-adapter'

const MAX_SEARCH_RESULTS = 1000

function resolveSafePath(userPath: string): string {
  const normalized = userPath.replace(/\\/g, '/').replace(/\/+/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') {
      throw new FileEditorError('PATH_TRAVERSAL', `Path traversal detected: ${userPath}`)
    }
    if (part !== '.') resolved.push(part)
  }
  if (!resolved.length) throw new FileEditorError('INVALID_PATH', `Path is empty or invalid: ${userPath}`)
  return resolved.join('/')
}

/**
 * Könyvtár-műveletekhez (list/search): a gyökeret jelölő bemenetek
 * (`""`, `"."`, `"./"`, `"/"`) `undefined`-ra normalizálódnak (= teljes
 * munkaterület), nem dobnak hibát. Egyébként resolveSafePath szabályai.
 */
function resolveDirPath(userPath?: string): string | undefined {
  if (!userPath) return undefined
  const trimmed = userPath.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === './' || trimmed === '/') return undefined
  return resolveSafePath(trimmed)
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`)
}

function addLineNumbers(text: string): string {
  return text
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
    .join('\n')
}

export type FileReadResult = {
  path: string
  totalLines: number
  content: string
}

export type FileWriteResult = {
  path: string
  bytesWritten: number
}

export type FileEditResult = {
  path: string
  replacements: number
}

export type FileListEntry = {
  path: string
  type: 'file' | 'dir'
}

export type FileListResult = {
  path: string
  entries: FileListEntry[]
}

export type FileGlobResult = {
  paths: string[]
}

export type FileSearchMatch = {
  path: string
  lineNumber: number
  line: string
}

export type FileSearchResult = {
  matches: FileSearchMatch[]
  truncated: boolean
}

export type FileDeleteResult = {
  deleted: boolean
  path: string
}

export type XlsxReadSheetResult = {
  sheet: string
  headers: string[]
  rows: XlsxRow[]
  rowCount: number
}

export type XlsxWriteCellsResult = {
  path: string
  cellsUpdated: number
}

export type XlsxAppendRowsResult = {
  path: string
  rowsAppended: number
}

export type XlsxFormatRangeResult = {
  path: string
  range: string
}

export type XlsxLayoutResult = {
  path: string
  operations: number
}

export type XlsxCreateResult = {
  path: string
  sheets: number
}

export type DocxReadResult = {
  text: string
  messages: string[]
}

export type PdfReadResult = {
  text: string
  numPages: number
  pagesRead: string
}

export type PdfCreateResult = {
  path: string
  bytesWritten: number
  rows: number
}

export type PptxCreateResult = {
  path: string
  bytesWritten: number
  slides: number
}

export type HtmlCreateResult = {
  path: string
  bytesWritten: number
  wrapped: boolean
}

export class FileEditorService {
  constructor(private readonly storage: WorkspaceStorage) {}

  async readFile(
    tenantId: string,
    ticketId: string,
    args: { path: string; offset?: number; limit?: number },
  ): Promise<FileReadResult> {
    const safePath = resolveSafePath(args.path)
    const buf = await this.storage.read(tenantId, ticketId, safePath)
    if (!buf) throw new FileEditorError('FILE_NOT_FOUND', `File not found: ${safePath}`)

    const text = buf.toString('utf8')
    const lines = text.split('\n')
    const totalLines = lines.length
    const offset = Math.max(0, (args.offset ?? 1) - 1)
    const limit = args.limit ?? 2000
    const sliced = lines.slice(offset, offset + limit)

    const numbered = sliced.map((line, i) => `${String(offset + i + 1).padStart(6)}\t${line}`).join('\n')

    return { path: safePath, totalLines, content: numbered }
  }

  async readTextFileOrNull(
    tenantId: string,
    ticketId: string,
    args: { path: string },
  ): Promise<string | null> {
    const safePath = resolveSafePath(args.path)
    const buf = await this.storage.read(tenantId, ticketId, safePath)
    return buf ? buf.toString('utf8') : null
  }

  /** Nyers bájtok (numerikus sortördelés nélkül) — pl. git blob-hash számításhoz. */
  async readRawFile(
    tenantId: string,
    ticketId: string,
    args: { path: string },
  ): Promise<Buffer | null> {
    const safePath = resolveSafePath(args.path)
    return this.storage.read(tenantId, ticketId, safePath)
  }

  async writeFile(
    tenantId: string,
    ticketId: string,
    args: { path: string; content: string },
  ): Promise<FileWriteResult> {
    const safePath = resolveSafePath(args.path)
    const buf = Buffer.from(args.content, 'utf8')
    await this.storage.write(tenantId, ticketId, safePath, buf)
    return { path: safePath, bytesWritten: buf.length }
  }

  async editFile(
    tenantId: string,
    ticketId: string,
    args: { path: string; old_string: string; new_string: string; replace_all?: boolean },
  ): Promise<FileEditResult> {
    const safePath = resolveSafePath(args.path)
    const buf = await this.storage.read(tenantId, ticketId, safePath)
    if (!buf) throw new FileEditorError('FILE_NOT_FOUND', `File not found: ${safePath}`)

    const text = buf.toString('utf8')

    let count = 0
    let idx = 0
    while ((idx = text.indexOf(args.old_string, idx)) !== -1) {
      count++
      idx += args.old_string.length
    }

    if (count === 0) {
      throw new FileEditorError('STRING_NOT_FOUND', `old_string not found in: ${safePath}`)
    }
    if (count > 1 && !args.replace_all) {
      throw new FileEditorError(
        'AMBIGUOUS_MATCH',
        `old_string appears ${count} times in ${safePath}; set replace_all: true for bulk replace`,
      )
    }

    const updated = args.replace_all
      ? text.split(args.old_string).join(args.new_string)
      : text.replace(args.old_string, args.new_string)

    await this.storage.write(tenantId, ticketId, safePath, Buffer.from(updated, 'utf8'))
    return { path: safePath, replacements: args.replace_all ? count : 1 }
  }

  async listFiles(
    tenantId: string,
    ticketId: string,
    args: { path?: string; recursive?: boolean },
  ): Promise<FileListResult> {
    const requestedPath = resolveDirPath(args.path)
    const all = await this.storage.list(tenantId, ticketId, requestedPath)

    if (args.recursive) {
      return {
        path: requestedPath ?? '',
        entries: all.map((p) => ({ path: p, type: 'file' as const })),
      }
    }

    const prefix = requestedPath ? `${requestedPath}/` : ''
    const seen = new Set<string>()
    const entries: FileListEntry[] = []

    for (const fullPath of all) {
      const relative = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath
      const parts = relative.split('/')
      const name = parts[0]
      if (!name || seen.has(name)) continue
      seen.add(name)
      entries.push({
        path: prefix + name,
        type: parts.length > 1 ? 'dir' : 'file',
      })
    }

    return { path: requestedPath ?? '', entries }
  }

  async globFiles(
    tenantId: string,
    ticketId: string,
    args: { pattern: string },
  ): Promise<FileGlobResult> {
    const all = await this.storage.list(tenantId, ticketId)
    const regex = globToRegex(args.pattern)
    return { paths: all.filter((p) => regex.test(p)) }
  }

  async searchFiles(
    tenantId: string,
    ticketId: string,
    args: {
      pattern: string
      path?: string
      glob?: string
      ignore_case?: boolean
      max_results?: number
    },
  ): Promise<FileSearchResult> {
    const searchPath = resolveDirPath(args.path)
    const all = await this.storage.list(tenantId, ticketId, searchPath)

    const files = args.glob ? all.filter((p) => globToRegex(args.glob!).test(p)) : all
    const regex = new RegExp(args.pattern, args.ignore_case ? 'i' : '')
    const maxResults = Math.min(args.max_results ?? 100, MAX_SEARCH_RESULTS)
    const matches: FileSearchMatch[] = []
    let truncated = false

    outer: for (const filePath of files) {
      const buf = await this.storage.read(tenantId, ticketId, filePath)
      if (!buf) continue
      const lines = buf.toString('utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push({ path: filePath, lineNumber: i + 1, line: lines[i] })
          if (matches.length >= maxResults) {
            truncated = true
            break outer
          }
        }
      }
    }

    return { matches, truncated }
  }

  async deleteFile(
    tenantId: string,
    ticketId: string,
    args: { path: string },
  ): Promise<FileDeleteResult> {
    const safePath = resolveSafePath(args.path)
    await this.storage.delete(tenantId, ticketId, safePath)
    return { deleted: true, path: safePath }
  }

  async xlsxReadSheet(
    tenantId: string,
    ticketId: string,
    args: { path: string; sheet?: string; max_rows?: number },
  ): Promise<XlsxReadSheetResult> {
    const safePath = resolveSafePath(args.path)
    const buf = await this.storage.read(tenantId, ticketId, safePath)
    if (!buf) throw new FileEditorError('FILE_NOT_FOUND', `File not found: ${safePath}`)
    const result = await xlsxReadSheet(buf, args.sheet, args.max_rows ?? 500)
    return { ...result, rowCount: result.rows.length }
  }

  /**
   * XLSX írásműveletekhez: beolvassa a meglévő munkafüzetet, vagy ha hiányzik
   * (ill. 0 bájtos / sérült, pl. egy korábbi file_write után), egy üres
   * munkafüzetet inicializál a kért (vagy alapértelmezett) munkalappal. Így az
   * agent „létrehozás nélkül is írhat" — nem kell külön xlsx_create-et hívnia,
   * és nem akad el FILE_NOT_FOUND hibán.
   */
  private async readOrInitXlsx(
    tenantId: string,
    ticketId: string,
    safePath: string,
    sheet?: string,
  ): Promise<Buffer> {
    const buf = await this.storage.read(tenantId, ticketId, safePath)
    if (buf && buf.length > 0) return buf
    return xlsxCreate([{ name: sheet ?? 'Sheet1' }])
  }

  async xlsxWriteCells(
    tenantId: string,
    ticketId: string,
    args: { path: string; sheet?: string; changes: XlsxCellChange[] },
  ): Promise<XlsxWriteCellsResult> {
    const safePath = resolveSafePath(args.path)
    const buf = await this.readOrInitXlsx(tenantId, ticketId, safePath, args.sheet)
    const updated = await xlsxWriteCells(buf, args.changes, args.sheet)
    await this.storage.write(tenantId, ticketId, safePath, updated)
    return { path: safePath, cellsUpdated: args.changes.length }
  }

  async xlsxAppendRows(
    tenantId: string,
    ticketId: string,
    args: { path: string; sheet?: string; rows: XlsxRow[] },
  ): Promise<XlsxAppendRowsResult> {
    const safePath = resolveSafePath(args.path)
    const buf = await this.readOrInitXlsx(tenantId, ticketId, safePath, args.sheet)
    const updated = await xlsxAppendRows(buf, args.rows, args.sheet)
    await this.storage.write(tenantId, ticketId, safePath, updated)
    return { path: safePath, rowsAppended: args.rows.length }
  }

  async xlsxFormatRange(
    tenantId: string,
    ticketId: string,
    args: { path: string; sheet?: string; range: string; style: CellStyle },
  ): Promise<XlsxFormatRangeResult> {
    const safePath = resolveSafePath(args.path)
    const buf = await this.readOrInitXlsx(tenantId, ticketId, safePath, args.sheet)
    const updated = await xlsxFormatRange(buf, args.range, args.style, args.sheet)
    await this.storage.write(tenantId, ticketId, safePath, updated)
    return { path: safePath, range: args.range }
  }

  async xlsxLayout(
    tenantId: string,
    ticketId: string,
    args: { path: string; sheet?: string } & XlsxLayout,
  ): Promise<XlsxLayoutResult> {
    const safePath = resolveSafePath(args.path)
    const buf = await this.readOrInitXlsx(tenantId, ticketId, safePath, args.sheet)
    const { mergeCells, columnWidths, rowHeights, freeze, autoFilter } = args
    const layout: XlsxLayout = { mergeCells, columnWidths, rowHeights, freeze, autoFilter }
    const updated = await xlsxApplyLayout(buf, layout, args.sheet)
    await this.storage.write(tenantId, ticketId, safePath, updated)
    const operations =
      (layout.mergeCells?.length ?? 0) +
      (layout.columnWidths?.length ?? 0) +
      (layout.rowHeights?.length ?? 0) +
      (layout.freeze ? 1 : 0) +
      (layout.autoFilter ? 1 : 0)
    return { path: safePath, operations }
  }

  async xlsxCreate(
    tenantId: string,
    ticketId: string,
    args: { path: string; sheets: XlsxSheetSpec[] },
  ): Promise<XlsxCreateResult> {
    const safePath = resolveSafePath(args.path)
    const existing = await this.storage.read(tenantId, ticketId, safePath)
    // Csak valódi (nem 0 bájtos) fájlnál tiltjuk a felülírást — egy korábbi
    // hibás file_write 0 bájtos csonkját felül lehet írni.
    if (existing && existing.length > 0) {
      throw new FileEditorError('FILE_ALREADY_EXISTS', `File already exists: ${safePath}`)
    }
    const buf = await xlsxCreate(args.sheets)
    await this.storage.write(tenantId, ticketId, safePath, buf)
    return { path: safePath, sheets: args.sheets.length }
  }

  async docxRead(
    tenantId: string,
    ticketId: string,
    args: { path: string },
  ): Promise<DocxReadResult> {
    const safePath = resolveSafePath(args.path)
    const buf = await this.storage.read(tenantId, ticketId, safePath)
    if (!buf) throw new FileEditorError('FILE_NOT_FOUND', `File not found: ${safePath}`)
    return docxRead(buf)
  }

  async pdfRead(
    tenantId: string,
    ticketId: string,
    args: { path: string; page_range?: string },
  ): Promise<PdfReadResult> {
    const safePath = resolveSafePath(args.path)
    const buf = await this.storage.read(tenantId, ticketId, safePath)
    if (!buf) throw new FileEditorError('FILE_NOT_FOUND', `File not found: ${safePath}`)
    return pdfRead(buf, args.page_range)
  }

  /**
   * Táblázatos PDF létrehozása. Forrás vagy egy meglévő XLSX (`source_xlsx`),
   * vagy közvetlenül megadott `headers` + `rows`. Ezzel az agent valódi .pdf-et
   * tud előállítani (pl. „csinálj PDF-et az Excelből"), nem csak HTML/MD-t.
   */
  async pdfCreate(
    tenantId: string,
    ticketId: string,
    args: {
      path: string
      source_xlsx?: string
      sheet?: string
      title?: string
      headers?: string[]
      rows?: Array<Array<string | number | boolean | null>>
    },
  ): Promise<PdfCreateResult> {
    let safePath = resolveSafePath(args.path)
    if (!/\.pdf$/i.test(safePath)) safePath = `${safePath}.pdf`

    let headers: string[]
    let rows: Array<Array<string | number | boolean | null>>

    if (args.source_xlsx) {
      const srcPath = resolveSafePath(args.source_xlsx)
      const srcBuf = await this.storage.read(tenantId, ticketId, srcPath)
      if (!srcBuf) throw new FileEditorError('FILE_NOT_FOUND', `Source file not found: ${srcPath}`)
      const sheet = await xlsxReadSheet(srcBuf, args.sheet)
      headers = sheet.headers
      rows = sheet.rows.map((r) => headers.map((h) => r[h] ?? ''))
    } else if (args.rows && args.rows.length > 0) {
      headers = args.headers ?? []
      rows = args.rows
    } else {
      throw new FileEditorError(
        'INVALID_ARGS',
        'pdf_create requires either source_xlsx or non-empty rows',
      )
    }

    const buf = await pdfCreateFromTable({ title: args.title, headers, rows })
    await this.storage.write(tenantId, ticketId, safePath, buf)
    return { path: safePath, bytesWritten: buf.length, rows: rows.length }
  }

  /**
   * PPTX prezentáció létrehozása diaspecifikációkból. Az eredmény valódi,
   * letölthető .pptx (16:9). Ezzel az agent bemutatót tud készíteni (pl.
   * „csinálj egy prezentációt a Q3 eredményekről"), nem csak PDF-et vagy HTML-t.
   */
  async pptxCreate(
    tenantId: string,
    ticketId: string,
    args: {
      path: string
      title?: string
      author?: string
      subject?: string
      slides: PptxSlideSpec[]
    },
  ): Promise<PptxCreateResult> {
    let safePath = resolveSafePath(args.path)
    if (!/\.pptx$/i.test(safePath)) safePath = `${safePath}.pptx`

    if (!Array.isArray(args.slides) || args.slides.length === 0) {
      throw new FileEditorError('INVALID_ARGS', 'pptx_create requires at least one slide')
    }

    const buf = await pptxCreate({
      title: args.title,
      author: args.author,
      subject: args.subject,
      slides: args.slides,
    })
    await this.storage.write(tenantId, ticketId, safePath, buf)
    return { path: safePath, bytesWritten: buf.length, slides: args.slides.length }
  }

  /**
   * HTML fájl létrehozása a munkaterületen. A `.html` kiterjesztést garantálja.
   * Ha a `html` nem teljes dokumentum (nincs <!doctype/<html), egy minimális,
   * érvényes HTML5 vázba csomagolja (charset + viewport + title). Ez különbözteti
   * meg a nyers file_write-tól: az agent adhat csak törzs-töredéket is.
   * Megjegyzés: ez sima munkaterületi fájl — NEM izolált, futtatható sandbox app.
   */
  async createHtml(
    tenantId: string,
    ticketId: string,
    args: { path: string; html: string; title?: string },
  ): Promise<HtmlCreateResult> {
    let safePath = resolveSafePath(args.path)
    if (!/\.html?$/i.test(safePath)) safePath = `${safePath}.html`

    const isFullDoc = /<!doctype\s+html|<html[\s>]/i.test(args.html)
    const wrapped = !isFullDoc
    const document = wrapped ? wrapHtmlDocument(args.html, args.title) : args.html

    const buf = Buffer.from(document, 'utf8')
    await this.storage.write(tenantId, ticketId, safePath, buf)
    return { path: safePath, bytesWritten: buf.length, wrapped }
  }
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function wrapHtmlDocument(bodyHtml: string, title?: string): string {
  const safeTitle = escapeHtmlText(title?.trim() || 'Dokumentum')
  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
</head>
<body>
${bodyHtml}
</body>
</html>
`
}

export { FileEditorError } from './workspace-storage'
export { addLineNumbers }
