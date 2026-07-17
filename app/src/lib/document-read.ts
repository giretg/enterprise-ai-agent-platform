/**
 * Chat/ticket csatolmányok célzott olvasása — oldal / keresés alapú.
 *
 * A feltöltéskor kinyert `metadata.extraction.blocks` (PDF oldal, DOCX section, …)
 * a forrás; a teljes dokumentumot NEM kell a promptba vagy egy file_read-be tölteni.
 */
import type { ExtractedBlock } from './kb-v3'
import { readExtractionBlocks } from './kb-extraction'

export const DOCUMENT_READ_DEFAULT_MAX_CHARS = 8_000
export const DOCUMENT_READ_HARD_MAX_CHARS = 40_000
export const DOCUMENT_READ_DEFAULT_MAX_MATCHES = 5
export const DOCUMENT_READ_HARD_MAX_MATCHES = 20
/** Egy hívásban max ennyi oldalt adunk vissza (maxChars mellett). */
export const DOCUMENT_READ_HARD_MAX_PAGES = 15

export type DocumentReadArgs = {
  documentId: string
  /** Oldaltartomány, pl. `"1-3"` vagy `"5"`. */
  pages?: string
  /** Teljes szövegben keresés (case-insensitive). */
  query?: string
  /** Visszaadott szöveg soft-plafonja (karakter). */
  maxChars?: number
  /** Keresésnél max találat-oldal. */
  maxMatches?: number
}

export type DocumentReadPage = {
  page?: number
  heading: string
  text: string
}

export type DocumentReadResult = {
  documentId: string
  filename: string
  totalPages: number
  pages: DocumentReadPage[]
  truncated: boolean
  matchCount?: number
  hint?: string
}

export function clampDocumentReadMaxChars(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DOCUMENT_READ_DEFAULT_MAX_CHARS
  }
  return Math.min(Math.floor(raw), DOCUMENT_READ_HARD_MAX_CHARS)
}

export function clampDocumentReadMaxMatches(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DOCUMENT_READ_DEFAULT_MAX_MATCHES
  }
  return Math.min(Math.floor(raw), DOCUMENT_READ_HARD_MAX_MATCHES)
}

/**
 * `"1-3"` / `"5"` → zárt 1-alapú tartomány. `totalPages` a clamp felső határa.
 */
export function parseDocumentPageRange(
  range: string,
  totalPages: number,
): { start: number; end: number } | { error: string } {
  const trimmed = range.trim()
  if (!trimmed) return { error: 'empty_pages' }
  if (totalPages < 1) return { error: 'document_empty' }

  const single = trimmed.match(/^(\d+)$/)
  if (single) {
    const n = Number(single[1])
    if (n < 1 || n > totalPages) return { error: `page_out_of_range:${n}` }
    return { start: n, end: n }
  }

  const span = trimmed.match(/^(\d+)\s*-\s*(\d+)$/)
  if (!span) return { error: 'invalid_pages' }
  let start = Number(span[1])
  let end = Number(span[2])
  if (start < 1 || end < 1) return { error: 'invalid_pages' }
  if (start > end) [start, end] = [end, start]
  if (start > totalPages) return { error: `page_out_of_range:${start}` }
  end = Math.min(end, totalPages)
  return { start, end }
}

/**
 * Blokkok a Document metadata-ból; ha nincs extraction, a markdown headingek
 * (`# Oldal N`) vagy egyetlen „Dokumentum" blokk.
 */
export function blocksFromDocument(
  metadata: unknown,
  extractedText: string | null,
): ExtractedBlock[] {
  const fromMeta = readExtractionBlocks(metadata)
  if (fromMeta && fromMeta.length > 0) return fromMeta

  const text = extractedText?.trim() ?? ''
  if (!text) return []

  const pageBlocks = splitMarkdownPageHeadings(text)
  if (pageBlocks.length > 0) return pageBlocks

  return [{ heading: 'Dokumentum', text, sourceRef: { section: 'Dokumentum' } }]
}

function splitMarkdownPageHeadings(text: string): ExtractedBlock[] {
  const re = /^#\s+Oldal\s+(\d+)\s*$/gim
  const matches: Array<{ page: number; index: number; headingEnd: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    matches.push({ page: Number(m[1]), index: m.index, headingEnd: re.lastIndex })
  }
  if (matches.length === 0) return []

  const blocks: ExtractedBlock[] = []
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : text.length
    const body = text.slice(cur.headingEnd, bodyEnd).trim()
    if (!body) continue
    blocks.push({
      heading: `Oldal ${cur.page}`,
      text: body,
      sourceRef: { page: cur.page },
    })
  }
  return blocks
}

function blockPageNumber(block: ExtractedBlock, index: number): number {
  if (typeof block.sourceRef.page === 'number' && block.sourceRef.page >= 1) {
    return block.sourceRef.page
  }
  return index + 1
}

function truncateToBudget(
  pages: DocumentReadPage[],
  maxChars: number,
): { pages: DocumentReadPage[]; truncated: boolean } {
  const out: DocumentReadPage[] = []
  let used = 0
  let truncated = false

  for (const page of pages) {
    const overhead = page.heading.length + 8
    const remaining = maxChars - used - overhead
    if (remaining <= 0) {
      truncated = true
      break
    }
    if (page.text.length <= remaining) {
      out.push(page)
      used += overhead + page.text.length
    } else {
      out.push({ ...page, text: page.text.slice(0, remaining) })
      truncated = true
      break
    }
  }

  return { pages: out, truncated }
}

/**
 * Célzott oldal-/keresés-olvasás. Legalább `pages` vagy `query` kell;
 * mindkettő nélkül az első oldal(ak) jönnek soft-cappel + hint.
 */
export function readDocumentPages(input: {
  documentId: string
  filename: string
  blocks: ExtractedBlock[]
  pages?: string
  query?: string
  maxChars?: number
  maxMatches?: number
}): DocumentReadResult {
  const maxChars = clampDocumentReadMaxChars(input.maxChars)
  const maxMatches = clampDocumentReadMaxMatches(input.maxMatches)
  const totalPages = input.blocks.length

  if (totalPages === 0) {
    return {
      documentId: input.documentId,
      filename: input.filename,
      totalPages: 0,
      pages: [],
      truncated: false,
      hint: 'A dokumentumból nincs kinyert szöveg.',
    }
  }

  const indexed = input.blocks.map((block, i) => ({
    block,
    page: blockPageNumber(block, i),
  }))

  let selected = indexed
  let matchCount: number | undefined
  let hint: string | undefined

  if (input.query?.trim()) {
    const q = input.query.trim().toLowerCase()
    const hits = indexed.filter(
      ({ block }) =>
        block.text.toLowerCase().includes(q) || block.heading.toLowerCase().includes(q),
    )
    matchCount = hits.length
    selected = hits.slice(0, maxMatches)
    if (hits.length === 0) {
      hint = `Nincs találat a keresésre: "${input.query.trim()}". Próbálj más kulcsszót, vagy pages:"1-2"-vel nézd az elejét.`
    } else if (hits.length > maxMatches) {
      hint = `${hits.length} találat, ebből ${maxMatches} oldal. Szűkítsd a query-t vagy emeld a maxMatches-t.`
    }
  }

  if (input.pages?.trim()) {
    const range = parseDocumentPageRange(input.pages, totalPages)
    if ('error' in range) {
      return {
        documentId: input.documentId,
        filename: input.filename,
        totalPages,
        pages: [],
        truncated: false,
        hint: `Érvénytelen pages: ${range.error}. Példa: "1-3" vagy "5" (összesen ${totalPages} oldal).`,
      }
    }
    const inRange = new Set(
      indexed.filter((x) => x.page >= range.start && x.page <= range.end).map((x) => x.page),
    )
    if (input.query?.trim()) {
      selected = selected.filter((x) => inRange.has(x.page))
    } else {
      selected = indexed.filter((x) => x.page >= range.start && x.page <= range.end)
    }
  } else if (!input.query?.trim()) {
    // Sem pages, sem query → első oldal(ak), maxChars keretben.
    selected = indexed.slice(0, DOCUMENT_READ_HARD_MAX_PAGES)
    hint =
      hint ??
      `Nem adtál meg pages/query-t — az elejét adom vissza (max ${maxChars} kar). Célzottan: pages:"1-3" vagy query:"kulcsszó".`
  }

  if (selected.length > DOCUMENT_READ_HARD_MAX_PAGES) {
    selected = selected.slice(0, DOCUMENT_READ_HARD_MAX_PAGES)
    hint =
      (hint ? `${hint} ` : '') +
      `Egyszerre legfeljebb ${DOCUMENT_READ_HARD_MAX_PAGES} oldal; szűkítsd a tartományt.`
  }

  const mapped: DocumentReadPage[] = selected.map(({ block, page }) => ({
    page,
    heading: block.heading,
    text: block.text,
  }))

  const { pages, truncated } = truncateToBudget(mapped, maxChars)
  if (truncated && !hint) {
    hint = `Szöveg csonkítva (${maxChars} kar plafon). Kérj kisebb oldaltartományt vagy query-t.`
  }

  return {
    documentId: input.documentId,
    filename: input.filename,
    totalPages,
    pages,
    truncated,
    ...(matchCount !== undefined ? { matchCount } : {}),
    ...(hint ? { hint } : {}),
  }
}

export function attachmentPageCount(metadata: unknown, extractedText: string | null): number {
  return blocksFromDocument(metadata, extractedText).length
}
