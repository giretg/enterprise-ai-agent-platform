import { loadPdfParse } from '@/lib/pdf-parse'
import { FileEditorError } from '../workspace-storage'

async function importPdfParse(): Promise<typeof import('pdf-parse').PDFParse> {
  try {
    return await loadPdfParse()
  } catch {
    throw new FileEditorError(
      'BINARY_ADAPTER_UNAVAILABLE',
      'pdf-parse is not installed. Run: npm install pdf-parse',
    )
  }
}

function parsePageRange(pageRange?: string, totalPages?: number): { start: number; end: number } {
  if (!pageRange) return { start: 1, end: totalPages ?? Infinity }
  const [startStr, endStr] = pageRange.split('-')
  const start = Math.max(1, parseInt(startStr ?? '1', 10))
  const end = endStr ? parseInt(endStr, 10) : start
  return { start, end: Math.min(end, totalPages ?? end) }
}

export async function pdfRead(
  buffer: Buffer,
  pageRange?: string,
): Promise<{ text: string; numPages: number; pagesRead: string }> {
  const PDFParse = await importPdfParse()
  const range = pageRange ? parsePageRange(pageRange) : null

  const parser = new PDFParse({ data: buffer })
  let text: string
  let numPages: number
  try {
    // A `pageJoiner` alapértelmezése oldaljelölőt (`-- 1 of 3 --`) fűzne a szövegbe.
    // A `first`+`last` együtt zárt oldal-tartományt jelent; a `total` a dokumentum
    // teljes oldalszáma marad akkor is, ha csak egy részét olvassuk.
    const result = await parser.getText(
      range ? { pageJoiner: '', first: range.start, last: range.end } : { pageJoiner: '' },
    )
    text = result.text.trim()
    numPages = result.total
  } finally {
    await parser.destroy()
  }

  if (!range) return { text, numPages, pagesRead: `1-${numPages}` }

  return { text, numPages, pagesRead: `${range.start}-${Math.min(range.end, numPages)}` }
}

// ── PDF írás (táblázat) ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importPdfLib(): Promise<any> {
  try {
    return await import('pdf-lib')
  } catch {
    throw new FileEditorError(
      'BINARY_ADAPTER_UNAVAILABLE',
      'pdf-lib is not installed. Run: npm install pdf-lib',
    )
  }
}

// A beépített Helvetica WinAnsi kódolású — a magyar kettős ékezet (ő/ű) és pár
// egyéb Unicode karakter nem fér bele. Ezeket a legközelebbi támogatott alakra
// képezzük, a maradék nem-WinAnsi karaktert space-re cseréljük, hogy a
// drawText soha ne dobjon kódolási hibát.
function sanitizeForWinAnsi(input: string): string {
  const map: Record<string, string> = {
    ő: 'ö', Ő: 'Ö', ű: 'ü', Ű: 'Ü',
    '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', ' ': ' ',
  }
  let out = ''
  for (const ch of input.replace(/[őŐűŰ’‘“”– ]/g, (c) => map[c] ?? c)) {
    const code = ch.charCodeAt(0)
    // WinAnsi nagyjából: vezérlőkön kívüli Latin-1 + a 0x80–0x9F tartomány pár jele.
    out += code === 9 || code === 10 || (code >= 32 && code <= 255) ? ch : ' '
  }
  return out
}

type TableCellValue = string | number | boolean | null

/**
 * Egyszerű, lapozható táblázatos PDF generálása (A4 fekvő). Fejléc kiemelt
 * háttérrel + félkövér betűvel, sávozott sorok, cellán belüli sortöréssel,
 * automatikus oldaltöréssel. Az eredmény valódi, letölthető .pdf.
 */
export async function pdfCreateFromTable(opts: {
  title?: string
  headers: string[]
  rows: TableCellValue[][]
}): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await importPdfLib()
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)

  const pageW = 841.89
  const pageH = 595.28
  const margin = 36
  const fontSize = 9
  const headerSize = 9
  const lineGap = 3
  const cellPadX = 4
  const cellPadY = 4
  const contentW = pageW - margin * 2

  const cols = Math.max(opts.headers.length, ...opts.rows.map((r) => r.length), 1)
  const headers = Array.from({ length: cols }, (_, i) => sanitizeForWinAnsi(opts.headers[i] ?? ''))
  const rows = opts.rows.map((r) =>
    Array.from({ length: cols }, (_, i) => sanitizeForWinAnsi(r[i] == null ? '' : String(r[i]))),
  )

  // Oszlopszélességek a tartalom hossza alapján (clamp-elve), normalizálva.
  const weights = headers.map((h, i) => {
    let max = h.length
    for (const r of rows) max = Math.max(max, (r[i] ?? '').length)
    return Math.min(Math.max(max, 4), 40)
  })
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1
  const colWidths = weights.map((w) => (w / weightSum) * contentW)

  const wrap = (text: string, f: typeof font, size: number, maxW: number): string[] => {
    const usable = Math.max(maxW - cellPadX * 2, 8)
    const words = text.split(/\s+/).filter(Boolean)
    if (words.length === 0) return ['']
    const lines: string[] = []
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (f.widthOfTextAtSize(candidate, size) <= usable || !line) {
        // Egyetlen túl hosszú szót karakterenként tördelünk.
        if (!line && f.widthOfTextAtSize(word, size) > usable) {
          let chunk = ''
          for (const c of word) {
            if (f.widthOfTextAtSize(chunk + c, size) > usable && chunk) {
              lines.push(chunk)
              chunk = c
            } else chunk += c
          }
          line = chunk
        } else line = candidate
      } else {
        lines.push(line)
        line = word
      }
    }
    if (line) lines.push(line)
    return lines
  }

  let page = doc.addPage([pageW, pageH])
  let y = pageH - margin

  if (opts.title) {
    const t = sanitizeForWinAnsi(opts.title)
    page.drawText(t, { x: margin, y: y - 14, size: 15, font: fontBold, color: rgb(0.12, 0.16, 0.24) })
    y -= 28
  }

  const drawRow = (cells: string[], isHeader: boolean, stripe: boolean) => {
    const f = isHeader ? fontBold : font
    const size = isHeader ? headerSize : fontSize
    const wrapped = cells.map((c, i) => wrap(c, f, size, colWidths[i]))
    const maxLines = Math.max(1, ...wrapped.map((w) => w.length))
    const rowH = maxLines * (size + lineGap) + cellPadY * 2 - lineGap

    if (y - rowH < margin) {
      page = doc.addPage([pageW, pageH])
      y = pageH - margin
    }

    if (isHeader) {
      page.drawRectangle({ x: margin, y: y - rowH, width: contentW, height: rowH, color: rgb(0.17, 0.31, 0.47) })
    } else if (stripe) {
      page.drawRectangle({ x: margin, y: y - rowH, width: contentW, height: rowH, color: rgb(0.93, 0.95, 0.98) })
    }

    let x = margin
    for (let i = 0; i < cols; i++) {
      const lines = wrapped[i]
      let ty = y - cellPadY - size
      for (const line of lines) {
        page.drawText(line, {
          x: x + cellPadX,
          y: ty,
          size,
          font: f,
          color: isHeader ? rgb(1, 1, 1) : rgb(0.13, 0.13, 0.13),
        })
        ty -= size + lineGap
      }
      // vékony oszlopelválasztó
      page.drawRectangle({ x, y: y - rowH, width: colWidths[i], height: rowH, borderColor: rgb(0.8, 0.83, 0.88), borderWidth: 0.5 })
      x += colWidths[i]
    }
    y -= rowH
  }

  drawRow(headers, true, false)
  rows.forEach((r, i) => drawRow(r, false, i % 2 === 1))

  const bytes = (await doc.save()) as Uint8Array
  return Buffer.from(bytes)
}
