import { FileEditorError } from '../workspace-storage'
import { assertSafeOfficeArchive, OfficeArchiveError } from '@/lib/office-archive-guard'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importMammoth(): Promise<any> {
  try {
    return await import('mammoth')
  } catch {
    throw new FileEditorError(
      'BINARY_ADAPTER_UNAVAILABLE',
      'mammoth is not installed. Run: npm install mammoth',
    )
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importDocx(): Promise<any> {
  try {
    return await import('docx')
  } catch {
    throw new FileEditorError(
      'BINARY_ADAPTER_UNAVAILABLE',
      'docx is not installed. Run: npm install docx',
    )
  }
}

export async function docxRead(buffer: Buffer): Promise<{ text: string; messages: string[] }> {
  try {
    assertSafeOfficeArchive(buffer)
  } catch (error) {
    if (error instanceof OfficeArchiveError) throw new FileEditorError('INVALID_ARGS', error.message)
    throw error
  }
  const mammoth = await importMammoth()
  const result = await mammoth.extractRawText({ buffer })
  return {
    text: result.value as string,
    messages: ((result.messages ?? []) as Array<{ message: string }>).map((m) => m.message),
  }
}

type CellValue = string | number | boolean | null

export type DocxBlockSpec = {
  /** Tartalomblokk típusa. Elhagyható — ha van `rows` → táblázat, ha van `bullets` → felsorolás, egyébként bekezdés/cím. */
  type?: 'heading' | 'paragraph' | 'bullets' | 'table'
  /** Címsor szint (heading típusnál). Alap: 1. */
  level?: 1 | 2 | 3
  /** Egyszerű szöveg (heading / paragraph). */
  text?: string
  /** Felsorolás pontjai (bullets típus). */
  bullets?: string[]
  /** Táblázat fejlécsor (table típus). */
  headers?: string[]
  /** Táblázat adatsorok (table típus). */
  rows?: CellValue[][]
}

export type DocxCreateSpec = {
  title?: string
  author?: string
  subject?: string
  blocks: DocxBlockSpec[]
}

const HEADING_BY_LEVEL = {
  1: 'HEADING_1',
  2: 'HEADING_2',
  3: 'HEADING_3',
} as const

function resolveBlockType(block: DocxBlockSpec): NonNullable<DocxBlockSpec['type']> {
  if (block.type) return block.type
  if (block.rows && block.rows.length > 0) return 'table'
  if (block.bullets && block.bullets.length > 0) return 'bullets'
  if (block.text && block.level) return 'heading'
  return 'paragraph'
}

function cellText(value: CellValue): string {
  return value == null ? '' : String(value)
}

/**
 * Word (.docx) dokumentum generálása tartalomblokkokból. Az eredmény valódi,
 * letölthető .docx — címsor, bekezdés, felsorolás és táblázat támogatással.
 */
export async function docxCreate(spec: DocxCreateSpec): Promise<Buffer> {
  const blocks = spec.blocks

  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
  } = await importDocx()

  const children: unknown[] = []

  for (const block of blocks) {
    const type = resolveBlockType(block)

    if (type === 'heading') {
      const level = block.level ?? 1
      const headingKey = HEADING_BY_LEVEL[level] ?? 'HEADING_1'
      children.push(
        new Paragraph({
          text: block.text ?? '',
          heading: HeadingLevel[headingKey],
        }),
      )
      continue
    }

    if (type === 'paragraph') {
      children.push(
        new Paragraph({
          children: [new TextRun(block.text ?? '')],
        }),
      )
      continue
    }

    if (type === 'bullets') {
      const items = block.bullets ?? []
      if (items.length === 0) {
        throw new FileEditorError('INVALID_ARGS', 'bullets block requires at least one item')
      }
      for (const item of items) {
        children.push(
          new Paragraph({
            text: item,
            bullet: { level: 0 },
          }),
        )
      }
      continue
    }

    if (type === 'table') {
      const headers = block.headers ?? []
      const dataRows = block.rows ?? []
      if (headers.length === 0 && dataRows.length === 0) {
        throw new FileEditorError('INVALID_ARGS', 'table block requires headers or rows')
      }

      const tableRows: unknown[] = []

      if (headers.length > 0) {
        tableRows.push(
          new TableRow({
            children: headers.map(
              (h) =>
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [new TextRun({ text: String(h ?? ''), bold: true })],
                    }),
                  ],
                }),
            ),
          }),
        )
      }

      for (const row of dataRows) {
        tableRows.push(
          new TableRow({
            children: row.map(
              (cell) =>
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun(cellText(cell))] })],
                }),
            ),
          }),
        )
      }

      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: tableRows,
        }),
      )
      continue
    }
  }

  const doc = new Document({
    title: spec.title,
    creator: spec.author,
    subject: spec.subject,
    sections: [{ children }],
  })

  const data = (await Packer.toBuffer(doc)) as Buffer | ArrayBuffer | Uint8Array
  if (Buffer.isBuffer(data)) return data
  return Buffer.from(data as ArrayBuffer)
}
