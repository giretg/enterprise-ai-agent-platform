import type { ExtractedBlock } from './kb-v3'
import { assertSafeOfficeArchive } from './office-archive-guard'
import { loadPdfParse } from './pdf-parse'

/**
 * KB-v3 Sprint 2 — Extraction pipeline (Knowledge-Base-v3-OKF-Spec §7.3/§7.4).
 *
 * Formátumfüggő kinyerés **forrás-provenance-szal**: minden extraction-szelet
 * (blokk) normalizált szöveget és a rá mutató, formátumfüggő forrás-refet hordoz
 * (§4.7):
 *   - PDF  → oldal-szint (`page`)      — `pdf-parse` `getText()` oldal-tömbje,
 *   - DOCX → heading/section-út        — `mammoth` HTML + heading-szekciózás,
 *   - XLSX → cella-tartomány (`cell`)  — `exceljs`, `Sheet!A1:E20`,
 *   - MD/HTML/plain → section (heading) — direkt parser.
 *
 * A kimenet a `buildOkfBundle` bemenete (`blocks`): innen egy szelet = egy
 * OKF-oldal a saját forrás-linkjével. A `markdown` a legacy `extractedText`
 * mezőt tölti (backward compatibility, §4.2).
 *
 * A layout-aware span-pontos citation (bekezdés/byte-offset) külön bővítési
 * döntés (D-G/D7) — itt oldal/section/cella a granularitás.
 */

export type ExtractionFormat = 'pdf' | 'docx' | 'xlsx' | 'html' | 'text'

/** A `Document.metadata` alkulcsa, ahol a strukturált extraction eltárolódik (§8.2). */
export const EXTRACTION_METADATA_KEY = 'extraction'

export type StructuredExtraction = {
  format: ExtractionFormat
  /** Normalizált teljes markdown a legacy `extractedText`-hez. */
  markdown: string
  /** Formátumfüggő extraction-szeletek a `buildOkfBundle`-nek. */
  blocks: ExtractedBlock[]
}

function detectFormat(filename: string, mimeType?: string | null): ExtractionFormat {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  if (ext === '.pdf' || mimeType === 'application/pdf') return 'pdf'
  if (ext === '.docx' || mimeType?.includes('wordprocessingml')) return 'docx'
  if (ext === '.xlsx' || ext === '.xlsm' || mimeType?.includes('spreadsheetml')) return 'xlsx'
  if (ext === '.html' || ext === '.htm' || mimeType === 'text/html') return 'html'
  return 'text'
}

/**
 * A feltöltött fájl formátumfüggő kinyerése. A hívó a `filename`/`mimeType`
 * alapján választ; ismeretlen/plain esetén a text-út fut (heading-split).
 */
export async function extractStructured(input: {
  buffer: Buffer
  filename: string
  mimeType?: string | null
}): Promise<StructuredExtraction> {
  const format = detectFormat(input.filename, input.mimeType)
  switch (format) {
    case 'pdf':
      return extractPdf(input.buffer)
    case 'docx':
      return extractDocx(input.buffer)
    case 'xlsx':
      return extractXlsx(input.buffer)
    case 'html':
      return extractHtml(input.buffer.toString('utf8'))
    default:
      return extractPlainText(input.buffer.toString('utf8'))
  }
}

/** Plain text / markdown / HTML → heading-szintű blokkok (section source ref). */
export function extractTextContent(text: string): StructuredExtraction {
  return extractPlainText(text)
}

/** A feltöltéskor a `Document.metadata`-ba mentendő extraction-payload. */
export function toExtractionMetadata(
  extraction: StructuredExtraction,
): { format: ExtractionFormat; blocks: ExtractedBlock[] } {
  return { format: extraction.format, blocks: extraction.blocks }
}

/**
 * A `Document.metadata`-ból visszaolvassa a strukturált extraction-blokkokat,
 * ha vannak (a `buildOkfBundle` `blocks` bemenete). Régi dokumentumon `null` —
 * ilyenkor a bundle-építés a legacy `extractedText` heading-splitre esik vissza.
 */
export function readExtractionBlocks(metadata: unknown): ExtractedBlock[] | null {
  if (typeof metadata !== 'object' || metadata === null) return null
  const extraction = (metadata as Record<string, unknown>)[EXTRACTION_METADATA_KEY]
  if (typeof extraction !== 'object' || extraction === null) return null
  const blocks = (extraction as Record<string, unknown>).blocks
  if (!Array.isArray(blocks)) return null

  const out: ExtractedBlock[] = []
  for (const raw of blocks) {
    if (typeof raw !== 'object' || raw === null) continue
    const b = raw as Record<string, unknown>
    if (typeof b.heading !== 'string' || typeof b.text !== 'string') continue
    const sr = (typeof b.sourceRef === 'object' && b.sourceRef !== null ? b.sourceRef : {}) as Record<
      string,
      unknown
    >
    out.push({
      heading: b.heading,
      text: b.text,
      sourceRef: {
        page: typeof sr.page === 'number' ? sr.page : undefined,
        section: typeof sr.section === 'string' ? sr.section : undefined,
        cell: typeof sr.cell === 'string' ? sr.cell : undefined,
      },
    })
  }
  return out.length > 0 ? out : null
}

// ── PDF (oldal-szint) ────────────────────────────────────────────────────────

async function extractPdf(buffer: Buffer): Promise<StructuredExtraction> {
  let PDFParse: typeof import('pdf-parse').PDFParse
  try {
    PDFParse = await loadPdfParse()
  } catch {
    // A binárisadapter hiányában legalább üres, jól formált eredményt adunk.
    return { format: 'pdf', markdown: '', blocks: [] }
  }

  const parser = new PDFParse({ data: buffer })
  let pages: Array<{ num: number; text: string }>
  try {
    // A `pageJoiner` alapértelmezése oldaljelölőt (`-- 1 of 3 --`) fűzne a szövegbe;
    // az oldalhatárt a `pages[].num` hordozza, a jelölő csak szennyezné a blokkokat.
    ;({ pages } = await parser.getText({ pageJoiner: '' }))
  } finally {
    await parser.destroy()
  }

  const blocks: ExtractedBlock[] = []
  for (const { num, text: raw } of pages) {
    const text = normalizeWhitespace(raw)
    if (!text.trim()) continue
    blocks.push({ heading: `Oldal ${num}`, text, sourceRef: { page: num } })
  }

  const markdown = blocks.map((b) => `# ${b.heading}\n\n${b.text}`).join('\n\n')
  return { format: 'pdf', markdown, blocks }
}

// ── DOCX (heading/section-út) ────────────────────────────────────────────────

async function extractDocx(buffer: Buffer): Promise<StructuredExtraction> {
  assertSafeOfficeArchive(buffer)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mammoth: any
  try {
    mammoth = await import('mammoth')
  } catch {
    return { format: 'docx', markdown: '', blocks: [] }
  }

  const result = await mammoth.convertToHtml({ buffer })
  const html = String(result?.value ?? '')
  const blocks = htmlToSections(html)
  const markdown = blocks.map((b) => `## ${b.heading}\n\n${b.text}`).join('\n\n')
  return { format: 'docx', markdown, blocks }
}

// ── HTML (heading-szekciók, markup nélkül) ───────────────────────────────────

/**
 * Önálló HTML-oldal → heading-szekciók. A `<head>`/`<style>`/`<script>`/`<svg>`
 * tartalma nem szöveg: nélkülük a kereső és az agent kontextusa CSS/JS helyett
 * a tényleges tartalmat kapja.
 */
export function extractHtml(html: string): StructuredExtraction {
  const body = html.replace(/<(head|style|script|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
  const blocks = htmlToSections(body)
  const markdown = blocks.map((b) => `## ${b.heading}\n\n${b.text}`).join('\n\n')
  return { format: 'html', markdown, blocks }
}

/**
 * DOCX HTML → heading-szekciók (§4.7 DOCX = section-út). A `<h1..h6>` headingek
 * mentén vág; a heading előtti bevezető törzs „Bevezetés" szekcióba kerül.
 * Tiszta függvény (mammoth nélkül tesztelhető).
 */
export function htmlToSections(html: string): ExtractedBlock[] {
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi
  const sections: Array<{ heading: string; startBody: number; endHeading: number }> = []

  let match: RegExpExecArray | null
  while ((match = headingRe.exec(html)) !== null) {
    sections.push({
      // Inline tag (pl. `<span>1</span>Cím`) szóközzé, hogy a szavak ne tapadjanak.
      heading: htmlToText(match[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || 'Szekció',
      startBody: headingRe.lastIndex,
      endHeading: match.index,
    })
  }

  const blocks: ExtractedBlock[] = []

  // Heading előtti bevezető törzs.
  const preamble = htmlToText(html.slice(0, sections.length > 0 ? sections[0].endHeading : html.length))
  if (preamble.trim()) {
    blocks.push({ heading: 'Bevezetés', text: preamble, sourceRef: { section: 'Bevezetés' } })
  }

  sections.forEach((s, idx) => {
    const bodyEnd = idx + 1 < sections.length ? sections[idx + 1].endHeading : html.length
    const body = htmlToText(html.slice(s.startBody, bodyEnd))
    const text = body.trim() ? body : '(nincs tartalom)'
    blocks.push({ heading: s.heading, text, sourceRef: { section: s.heading } })
  })

  if (blocks.length === 0) {
    const all = htmlToText(html)
    blocks.push({
      heading: 'Dokumentum',
      text: all.trim() || '(üres dokumentum)',
      sourceRef: { section: 'Dokumentum' },
    })
  }

  return blocks
}

/** Durva HTML → plain text: blokkelemek → sortörés, `<li>` → bullet, tag-strip, entity-decode. */
function htmlToText(html: string): string {
  return normalizeLines(
    decodeEntities(
      html
        .replace(/<\s*br\s*\/?\s*>/gi, '\n')
        .replace(/<\s*li[^>]*>/gi, '\n- ')
        .replace(/<\/\s*(p|div|h[1-6]|li|tr|ul|ol|table)\s*>/gi, '\n')
        .replace(/<\/\s*(td|th)\s*>/gi, ' | ')
        .replace(/<[^>]+>/g, ''),
    ),
  )
}

// ── XLSX (cella-tartomány) ───────────────────────────────────────────────────

async function extractXlsx(buffer: Buffer): Promise<StructuredExtraction> {
  assertSafeOfficeArchive(buffer)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any
  try {
    mod = await import('exceljs')
  } catch {
    return { format: 'xlsx', markdown: '', blocks: [] }
  }
  const Workbook = mod.default?.Workbook ?? mod.Workbook
  if (!Workbook) return { format: 'xlsx', markdown: '', blocks: [] }

  const workbook = new Workbook()
  await workbook.xlsx.load(buffer)

  const blocks: ExtractedBlock[] = []
  const worksheets = workbook.worksheets as Array<{
    name: string
    eachRow: (
      opts: { includeEmpty: boolean },
      cb: (row: { values: unknown[] }, rowNumber: number) => void,
    ) => void
  }>

  for (const worksheet of worksheets) {
    const lines: string[] = []
    let maxCols = 0
    let lastRow = 0
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = (row.values as unknown[]).slice(1).map((v) => cellToString(v))
      maxCols = Math.max(maxCols, values.length)
      lastRow = rowNumber
      lines.push(values.join('\t'))
    })
    if (lines.length === 0) continue

    const range = `${worksheet.name}!A1:${columnLetter(Math.max(maxCols, 1))}${lastRow}`
    blocks.push({
      heading: worksheet.name,
      text: lines.join('\n'),
      sourceRef: { cell: range },
    })
  }

  const markdown = blocks.map((b) => `# ${b.heading}\n\n${b.text}`).join('\n\n')
  return { format: 'xlsx', markdown, blocks }
}

function cellToString(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (typeof rec.text === 'string') return rec.text
    if (typeof rec.result === 'string' || typeof rec.result === 'number') return String(rec.result)
    if (rec.richText && Array.isArray(rec.richText)) {
      return (rec.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('')
    }
    return String(value)
  }
  return String(value)
}

/** 1-alapú oszlopindex → Excel oszlopbetű (1→A, 27→AA). */
export function columnLetter(index: number): string {
  let n = Math.max(1, index)
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

// ── Plain text / markdown (section = heading) ────────────────────────────────

function extractPlainText(text: string): StructuredExtraction {
  const body = text.trim()
  const blocks: ExtractedBlock[] = []

  if (!body) {
    return { format: 'text', markdown: '', blocks: [] }
  }

  const lines = body.split('\n')
  let current: { heading: string; body: string } | null = null
  const push = () => {
    if (current) {
      const t = current.body.trim()
      blocks.push({
        heading: current.heading,
        text: t || '(nincs tartalom)',
        sourceRef: { section: current.heading },
      })
    }
  }

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.*)$/)
    if (heading) {
      push()
      current = { heading: heading[1].trim() || 'Szekció', body: '' }
    } else {
      if (!current) current = { heading: 'Dokumentum', body: '' }
      current.body += (current.body ? '\n' : '') + line
    }
  }
  push()

  return { format: 'text', markdown: body, blocks }
}

// ── Közös normalizálók ───────────────────────────────────────────────────────

function normalizeWhitespace(input: string): string {
  return input.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()
}

function normalizeLines(input: string): string {
  return input
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim()
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
}
