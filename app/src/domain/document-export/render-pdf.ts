/**
 * #1024: Markdown-blokkok → PDF (A4), ugyanazzal a kinézettel, mint a Word-változat:
 * címsorok, bekezdések, listák, táblázat (oldaltöréskor ismételt fejléccel), oldalszám.
 */
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { NOTO_SANS_BOLD_BASE64, NOTO_SANS_REGULAR_BASE64 } from './fonts'
import type { Block, Run } from './markdown-blocks'

const PAGE = { width: 595.28, height: 841.89 }
const MARGIN = 56
const CONTENT_WIDTH = PAGE.width - 2 * MARGIN
const BODY_SIZE = 10.5
const LINE = 1.4
const HEADING_SIZES = [18, 15, 13, 12, 11, 11]
const ACCENT = rgb(0x1f / 255, 0x3a / 255, 0x5f / 255)
const INK = rgb(0.13, 0.13, 0.15)
const MUTED = rgb(0.45, 0.47, 0.5)
const LINK = rgb(0.1, 0.33, 0.67)
const RULE = rgb(0.72, 0.77, 0.84)
const HEADER_FILL = rgb(0.91, 0.93, 0.97)
const CODE_FILL = rgb(0.95, 0.96, 0.96)
const CELL_PAD = 4

/**
 * A beágyazott font csak a latin (ő, ű…) és a tipográfiai jeleket ismeri; a többit (emoji, más írás)
 * kérdőjellel pótoljuk, a tabulátort szóközzel.
 */
const SUPPORTED = /[ -~ -ſ‐-‧‰′″€™←-↓−•●✓]/u
export function pdfSafe(text: string): string {
  let out = ''
  for (const ch of text.replace(/\t/g, '    ')) {
    if (ch === '\n' || SUPPORTED.test(ch)) out += ch
    else if (!/\p{Extended_Pictographic}|\uFE0F|\u200D/u.test(ch)) out += '?'
  }
  return out
}

type Fonts = { regular: PDFFont; bold: PDFFont }
type Word = { text: string; font: PDFFont; color: ReturnType<typeof rgb>; space: boolean }
type Line = { words: Word[]; width: number }

class Layout {
  page!: PDFPage
  y = 0
  constructor(
    readonly doc: PDFDocument,
    readonly fonts: Fonts,
  ) {
    this.newPage()
  }

  newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height])
    this.y = PAGE.height - MARGIN
  }

  ensure(height: number) {
    if (this.y - height < MARGIN) this.newPage()
  }

  /** Futó szöveg szavakra bontva; a túl hosszú szót karakterenként törjük. */
  wrap(runs: Run[], size: number, width: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}): Line[] {
    const lines: Line[] = [{ words: [], width: 0 }]
    let pendingSpace = false
    for (const run of runs) {
      const font = run.bold || opts.bold ? this.fonts.bold : this.fonts.regular
      const color = run.link ? LINK : run.code ? MUTED : (opts.color ?? INK)
      for (const token of pdfSafe(run.text).split(/(\n| +)/)) {
        if (token === '') continue
        if (token === '\n') {
          lines.push({ words: [], width: 0 })
          pendingSpace = false
          continue
        }
        if (token.startsWith(' ')) {
          pendingSpace = true
          continue
        }
        let rest = token
        while (rest) {
          const line = lines[lines.length - 1]
          const lead = pendingSpace && line.words.length > 0 ? font.widthOfTextAtSize(' ', size) : 0
          const w = font.widthOfTextAtSize(rest, size)
          if (line.width + lead + w <= width) {
            line.words.push({ text: rest, font, color, space: lead > 0 })
            line.width += lead + w
            rest = ''
          } else if (line.words.length > 0) {
            lines.push({ words: [], width: 0 })
          } else {
            // A hosszú szót egyszer járjuk be, a teljes előtag ismételt mérése nélkül.
            let chunk = ''
            let chunkWidth = 0
            for (const ch of rest) {
              const charWidth = font.widthOfTextAtSize(ch, size)
              if (chunk && chunkWidth + charWidth > width) {
                lines[lines.length - 1] = { words: [{ text: chunk, font, color, space: false }], width: chunkWidth }
                lines.push({ words: [], width: 0 })
                chunk = ''
                chunkWidth = 0
              }
              chunk += ch
              chunkWidth += charWidth
            }
            lines[lines.length - 1] = { words: [{ text: chunk, font, color, space: false }], width: chunkWidth }
            rest = ''
          }
        }
        pendingSpace = false
      }
    }
    return lines.length > 1 && lines[lines.length - 1].words.length === 0 ? lines.slice(0, -1) : lines
  }

  drawLine(line: Line, x: number, baseline: number, size: number) {
    let cursor = x
    for (const word of line.words) {
      if (word.space) cursor += word.font.widthOfTextAtSize(' ', size)
      this.page.drawText(word.text, { x: cursor, y: baseline, size, font: word.font, color: word.color })
      cursor += word.font.widthOfTextAtSize(word.text, size)
    }
  }

  paragraph(runs: Run[], opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; after?: number; prefix?: string } = {}) {
    const size = opts.size ?? BODY_SIZE
    const indent = opts.indent ?? 0
    const lineHeight = size * LINE
    const lines = this.wrap(runs, size, CONTENT_WIDTH - indent, opts)
    lines.forEach((line, i) => {
      this.ensure(lineHeight)
      this.y -= lineHeight
      const baseline = this.y + (lineHeight - size) / 2 + size * 0.2
      if (i === 0 && opts.prefix) {
        const prefix = pdfSafe(opts.prefix)
        this.page.drawText(prefix, { x: MARGIN + indent - this.fonts.regular.widthOfTextAtSize(`${prefix} `, size), y: baseline, size, font: this.fonts.regular, color: INK })
      }
      this.drawLine(line, MARGIN + indent, baseline, size)
    })
    this.y -= opts.after ?? size * 0.6
  }

  code(text: string) {
    const size = BODY_SIZE - 1
    const lineHeight = size * LINE
    const lines = this.wrap([{ text, code: true }], size, CONTENT_WIDTH - 2 * CELL_PAD)
    for (const line of lines) {
      this.ensure(lineHeight)
      this.page.drawRectangle({ x: MARGIN, y: this.y - lineHeight, width: CONTENT_WIDTH, height: lineHeight, color: CODE_FILL })
      this.y -= lineHeight
      this.drawLine(line, MARGIN + CELL_PAD, this.y + (lineHeight - size) / 2 + size * 0.2, size)
    }
    this.y -= BODY_SIZE * 0.6
  }

  rule() {
    this.ensure(BODY_SIZE)
    this.y -= BODY_SIZE / 2
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE.width - MARGIN, y: this.y }, thickness: 0.75, color: RULE })
    this.y -= BODY_SIZE / 2
  }

  table(block: Extract<Block, { kind: 'table' }>) {
    const size = BODY_SIZE - 1
    const lineHeight = size * LINE
    const columns = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1)
    // Oszlopszélesség a tartalom hosszával arányosan, de minden oszlop kap egy minimumot.
    const weight = Array.from({ length: columns }, (_, c) =>
      Math.min(40, Math.max(4, ...[block.header, ...block.rows].map((row) => (row[c] ?? []).reduce((n, r) => n + r.text.length, 0)))),
    )
    const total = weight.reduce((a, b) => a + b, 0)
    const widths = weight.map((w) => (w / total) * CONTENT_WIDTH)
    const layoutRow = (cells: Run[][], header: boolean) => {
      const wrapped = widths.map((w, c) => this.wrap(cells[c] ?? [], size, w - 2 * CELL_PAD, { bold: header }))
      return { wrapped, height: Math.max(...wrapped.map((l) => l.length), 1) * lineHeight + 2 * CELL_PAD }
    }
    const drawRow = (row: ReturnType<typeof layoutRow>, header: boolean) => {
      const top = this.y
      let x = MARGIN
      row.wrapped.forEach((lines, c) => {
        if (header) this.page.drawRectangle({ x, y: top - row.height, width: widths[c], height: row.height, color: HEADER_FILL })
        this.page.drawRectangle({ x, y: top - row.height, width: widths[c], height: row.height, borderColor: RULE, borderWidth: 0.5 })
        lines.forEach((line, i) => {
          const baseline = top - CELL_PAD - (i + 1) * lineHeight + (lineHeight - size) / 2 + size * 0.2
          this.drawLine(line, x + CELL_PAD, baseline, size)
        })
        x += widths[c]
      })
      this.y -= row.height
    }
    this.y -= 4
    const header = block.header.length ? layoutRow(block.header, true) : null
    // Az oldalnál magasabb fejlécet is tördeljük, de nem ismételjük minden oldalon.
    const repeatHeader = header && header.height < (PAGE.height - 2 * MARGIN) / 2 ? header : null
    const drawPaginated = (row: ReturnType<typeof layoutRow>, isHeader: boolean) => {
      const count = Math.max(...row.wrapped.map((lines) => lines.length), 1)
      let offset = 0
      while (offset < count) {
        if (this.y - 2 * CELL_PAD - lineHeight < MARGIN) {
          this.newPage()
          if (!isHeader && repeatHeader) drawRow(repeatHeader, true)
        }
        const available = Math.floor((this.y - MARGIN - 2 * CELL_PAD) / lineHeight)
        const take = Math.min(count - offset, available)
        drawRow({ wrapped: row.wrapped.map((lines) => lines.slice(offset, offset + take)), height: take * lineHeight + 2 * CELL_PAD }, isHeader)
        offset += take
      }
    }
    if (header) {
      this.ensure(Math.min(header.height + lineHeight * 2, PAGE.height - 2 * MARGIN))
      drawPaginated(header, true)
    }
    for (const cells of block.rows) {
      const row = layoutRow(cells, false)
      if (this.y - row.height < MARGIN && this.y < PAGE.height - MARGIN - (repeatHeader?.height ?? 0)) {
        this.newPage()
        if (repeatHeader) drawRow(repeatHeader, true)
      }
      drawPaginated(row, false)
    }
    this.y -= BODY_SIZE
  }
}

export async function renderPdf(blocks: Block[], meta: { title?: string }): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  doc.setCreator('Excellence AI')
  doc.setProducer('Excellence AI')
  if (meta.title) doc.setTitle(pdfSafe(meta.title))
  const fonts = {
    regular: await doc.embedFont(Buffer.from(NOTO_SANS_REGULAR_BASE64, 'base64'), { subset: true }),
    bold: await doc.embedFont(Buffer.from(NOTO_SANS_BOLD_BASE64, 'base64'), { subset: true }),
  }
  const layout = new Layout(doc, fonts)
  if (meta.title) layout.paragraph([{ text: meta.title }], { size: 22, bold: true, color: ACCENT, after: 14 })
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const size = HEADING_SIZES[block.level - 1]
        layout.ensure(size * LINE * 3) // a címsor ne maradjon egyedül az oldal alján
        layout.y -= size * 0.4
        layout.paragraph(block.runs, { size, bold: true, color: ACCENT, after: size * 0.35 })
        break
      }
      case 'paragraph':
        layout.paragraph(block.runs, block.quote ? { indent: 18, color: MUTED } : {})
        break
      case 'list_item':
        layout.paragraph(block.runs, { indent: 18 * (block.depth + 1), prefix: block.ordered ? `${block.number}.` : '•', after: 2 })
        break
      case 'code':
        layout.code(block.text)
        break
      case 'table':
        layout.table(block)
        break
      case 'rule':
        layout.rule()
        break
    }
  }
  const pages = doc.getPages()
  pages.forEach((page, i) => {
    const label = `${i + 1} / ${pages.length}`
    page.drawText(label, {
      x: PAGE.width - MARGIN - fonts.regular.widthOfTextAtSize(label, 8),
      y: MARGIN / 2,
      size: 8,
      font: fonts.regular,
      color: MUTED,
    })
  })
  return Buffer.from(await doc.save())
}
