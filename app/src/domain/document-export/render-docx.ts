/** #1024: Markdown-blokkok → Word-dokumentum, egységes céges kinézettel. */
import {
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import type { Block, Run } from './markdown-blocks'

const FONT = 'Calibri'
const MONO = 'Consolas'
const ACCENT = '1F3A5F'
const HEADER_FILL = 'E8EEF7'
const CODE_FILL = 'F3F4F6'
const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const

function textRuns(run: Run, extra: { bold?: boolean } = {}): TextRun[] {
  return run.text.split('\n').map(
    (text, i) =>
      new TextRun({
        text,
        ...(i > 0 ? { break: 1 } : {}),
        bold: run.bold || extra.bold,
        italics: run.italic,
        ...(run.code ? { font: MONO } : {}),
        ...(run.link ? { style: 'Hyperlink' } : {}),
      }),
  )
}

function inline(runs: Run[], extra: { bold?: boolean } = {}): Array<TextRun | ExternalHyperlink> {
  return runs.flatMap((run): Array<TextRun | ExternalHyperlink> =>
    run.link && /^(https?:|mailto:)/i.test(run.link)
      ? [new ExternalHyperlink({ link: run.link, children: textRuns(run, extra) })]
      : textRuns(run, extra),
  )
}

function table(block: Extract<Block, { kind: 'table' }>): Table {
  const columns = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1)
  const row = (cells: Run[][], header: boolean) =>
    new TableRow({
      tableHeader: header,
      children: Array.from({ length: columns }, (_, c) =>
        new TableCell({
          children: [new Paragraph({ children: inline(cells[c] ?? [], { bold: header }) })],
          ...(header ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: HEADER_FILL } } : {}),
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
        }),
      ),
    })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [...(block.header.length ? [row(block.header, true)] : []), ...block.rows.map((r) => row(r, false))],
  })
}

function render(block: Block): Array<Paragraph | Table> {
  switch (block.kind) {
    case 'heading':
      return [new Paragraph({ heading: HEADINGS[block.level - 1], children: inline(block.runs) })]
    case 'paragraph':
      return [
        new Paragraph({
          children: inline(block.runs),
          ...(block.quote
            ? { indent: { left: 567 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'B8C4D6', space: 8 } } }
            : {}),
        }),
      ]
    case 'list_item':
      return [
        block.ordered
          ? new Paragraph({
              children: [new TextRun(`${block.number}. `), ...inline(block.runs)],
              indent: { left: 360 * (block.depth + 1), hanging: 360 },
            })
          : new Paragraph({ children: inline(block.runs), bullet: { level: Math.min(block.depth, 8) } }),
      ]
    case 'code':
      return [
        new Paragraph({
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: CODE_FILL },
          children: textRuns({ text: block.text, code: true }),
        }),
      ]
    case 'table':
      return [table(block), new Paragraph({})]
    case 'rule':
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'B8C4D6', space: 1 } } })]
  }
}

export async function renderDocx(blocks: Block[], meta: { title?: string }): Promise<Buffer> {
  const doc = new Document({
    creator: 'Excellence AI',
    ...(meta.title ? { title: meta.title } : {}),
    styles: {
      default: {
        document: { run: { font: FONT, size: 22 }, paragraph: { spacing: { after: 120, line: 276 } } },
        heading1: { run: { font: FONT, size: 32, bold: true, color: ACCENT }, paragraph: { spacing: { before: 240, after: 120 } } },
        heading2: { run: { font: FONT, size: 28, bold: true, color: ACCENT }, paragraph: { spacing: { before: 200, after: 100 } } },
        heading3: { run: { font: FONT, size: 24, bold: true, color: ACCENT }, paragraph: { spacing: { before: 160, after: 80 } } },
      },
    },
    sections: [
      {
        children: [
          ...(meta.title ? [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: meta.title, color: ACCENT })] })] : []),
          ...blocks.flatMap(render),
        ],
      },
    ],
  })
  return Packer.toBuffer(doc)
}
