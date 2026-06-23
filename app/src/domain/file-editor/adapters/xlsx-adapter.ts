import type { CellValue } from 'exceljs'
import { FileEditorError } from '../workspace-storage'

export type XlsxRow = Record<string, string | number | boolean | null>

export type BorderStyle = 'thin' | 'medium' | 'thick'

export type CellStyle = {
  font?: {
    bold?: boolean
    italic?: boolean
    size?: number
    color?: string // ARGB hex (pl. "FF1F4E78") vagy RGB hex (pl. "1F4E78")
    name?: string
  }
  fill?: {
    color?: string // solid fgColor, ARGB vagy RGB hex
  }
  alignment?: {
    horizontal?: 'left' | 'center' | 'right'
    vertical?: 'top' | 'middle' | 'bottom'
    wrapText?: boolean
  }
  border?: {
    top?: BorderStyle
    bottom?: BorderStyle
    left?: BorderStyle
    right?: BorderStyle
  }
  numFmt?: string
}

export type XlsxCellChange = {
  cell: string
  value?: string | number | boolean | null
  formula?: string
  style?: CellStyle
  numFmt?: string
}

export type XlsxLayout = {
  mergeCells?: string[]
  columnWidths?: Array<{ column: string; width: number }>
  rowHeights?: Array<{ row: number; height: number }>
  freeze?: { rows?: number; columns?: number }
  autoFilter?: string
}

export type XlsxSheetSpec = {
  name: string
  rows?: Array<Array<string | number | boolean | null>>
}

/** Az exceljs ARGB hexet vár (8 jegy). 6 jegyű RGB-t "FF"-fel prefixelünk. */
function normalizeColor(color: string): string {
  const cleaned = color.trim().replace(/^#/, '').toUpperCase()
  return cleaned.length === 6 ? `FF${cleaned}` : cleaned
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyStyle(cell: any, style: CellStyle): void {
  if (style.font) {
    const font: Record<string, unknown> = { ...(cell.font ?? {}) }
    if (style.font.bold !== undefined) font.bold = style.font.bold
    if (style.font.italic !== undefined) font.italic = style.font.italic
    if (style.font.size !== undefined) font.size = style.font.size
    if (style.font.name !== undefined) font.name = style.font.name
    if (style.font.color !== undefined) font.color = { argb: normalizeColor(style.font.color) }
    cell.font = font
  }

  if (style.fill?.color !== undefined) {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: normalizeColor(style.fill.color) },
    }
  }

  if (style.alignment) {
    cell.alignment = { ...(cell.alignment ?? {}), ...style.alignment }
  }

  if (style.border) {
    const border: Record<string, unknown> = { ...(cell.border ?? {}) }
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const value = style.border[side]
      if (value !== undefined) border[side] = { style: value }
    }
    cell.border = border
  }

  if (style.numFmt !== undefined) cell.numFmt = style.numFmt
}

function columnLettersToNumber(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64)
  }
  return n
}

function parseA1Cell(a1: string): { col: number; row: number } {
  const match = /^([A-Za-z]+)(\d+)$/.exec(a1.trim())
  if (!match) {
    throw new FileEditorError('INVALID_RANGE', `Invalid A1 cell reference: ${a1}`)
  }
  return { col: columnLettersToNumber(match[1]), row: Number(match[2]) }
}

function parseA1Range(range: string): { c1: number; r1: number; c2: number; r2: number } {
  const [from, to] = range.split(':')
  if (!from || !to) {
    throw new FileEditorError('INVALID_RANGE', `Invalid A1 range: ${range}`)
  }
  const start = parseA1Cell(from)
  const end = parseA1Cell(to)
  return {
    c1: Math.min(start.col, end.col),
    r1: Math.min(start.row, end.row),
    c2: Math.max(start.col, end.col),
    r2: Math.max(start.row, end.row),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadWorkbook(): Promise<any> {
  let mod: typeof import('exceljs')
  try {
    mod = await import('exceljs')
  } catch {
    throw new FileEditorError(
      'BINARY_ADAPTER_UNAVAILABLE',
      'exceljs is not installed. Run: npm install exceljs',
    )
  }
  const moduleExports = mod as unknown as {
    default?: { Workbook?: new () => unknown }
    Workbook?: new () => unknown
  }
  const Workbook = moduleExports.default?.Workbook ?? moduleExports.Workbook
  if (!Workbook) {
    throw new FileEditorError('BINARY_ADAPTER_UNAVAILABLE', 'exceljs Workbook export missing')
  }
  return new Workbook()
}

export async function xlsxReadSheet(
  buffer: Buffer,
  sheetName?: string,
  maxRows = 500,
): Promise<{ sheet: string; headers: string[]; rows: XlsxRow[] }> {
  const workbook = await loadWorkbook()
  await workbook.xlsx.load(buffer)

  const worksheet = sheetName
    ? workbook.getWorksheet(sheetName)
    : workbook.worksheets[0]

  if (!worksheet) {
    throw new FileEditorError('SHEET_NOT_FOUND', `Sheet "${sheetName ?? 'first'}" not found`)
  }

  const headers: string[] = []
  const rows: XlsxRow[] = []

  worksheet.eachRow({ includeEmpty: false }, (row: { values: unknown[] }, rowNumber: number) => {
    const values = (row.values as unknown[]).slice(1)
    if (rowNumber === 1) {
      headers.push(...values.map((v) => String(v ?? '')))
    } else if (rows.length < maxRows) {
      const obj: XlsxRow = {}
      headers.forEach((h, i) => {
        const cell = values[i]
        obj[h] =
          cell === null || cell === undefined
            ? null
            : typeof cell === 'object'
              ? String(cell)
              : (cell as string | number | boolean)
      })
      rows.push(obj)
    }
  })

  return { sheet: worksheet.name, headers, rows }
}

/**
 * A teljes munkafüzet szöveges kivonata a tudásbázis-indexeléshez: minden
 * munkalapot bejár, és a `kb_search` chunkolójához igazodó formátumot ad
 * (munkalaponként blokk, üres sorral elválasztva). A fejléc külön sorban,
 * a sorok tab-tagolt értékekkel szerepelnek.
 */
export async function xlsxExtractText(buffer: Buffer, maxRowsPerSheet = 1000): Promise<string> {
  const workbook = await loadWorkbook()
  await workbook.xlsx.load(buffer)

  const blocks: string[] = []
  const worksheets = workbook.worksheets as Array<{
    name: string
    eachRow: (
      opts: { includeEmpty: boolean },
      cb: (row: { values: unknown[] }, rowNumber: number) => void,
    ) => void
  }>

  for (const worksheet of worksheets) {
    const headers: string[] = []
    const dataRows: string[] = []
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = (row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v)))
      if (rowNumber === 1) {
        headers.push(...values)
      } else if (dataRows.length < maxRowsPerSheet) {
        dataRows.push(values.join('\t'))
      }
    })
    if (headers.length === 0 && dataRows.length === 0) continue
    blocks.push([`# ${worksheet.name}`, headers.join('\t'), ...dataRows].join('\n'))
  }

  return blocks.join('\n\n')
}

export async function xlsxWriteCells(
  buffer: Buffer,
  changes: XlsxCellChange[],
  sheetName?: string,
): Promise<Buffer> {
  const workbook = await loadWorkbook()
  await workbook.xlsx.load(buffer)

  const worksheet = sheetName
    ? workbook.getWorksheet(sheetName)
    : workbook.worksheets[0]

  if (!worksheet) {
    throw new FileEditorError('SHEET_NOT_FOUND', `Sheet "${sheetName ?? 'first'}" not found`)
  }

  for (const change of changes) {
    const c = worksheet.getCell(change.cell)
    if (change.formula !== undefined) {
      c.value = { formula: change.formula }
    } else if (change.value !== undefined) {
      c.value = change.value as CellValue
    }
    if (change.style) applyStyle(c, change.style)
    if (change.numFmt) c.numFmt = change.numFmt
  }

  const buf = await workbook.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

/** Köteg-stílus egy A1-tartomány (pl. "A1:E1") minden cellájára. */
export async function xlsxFormatRange(
  buffer: Buffer,
  range: string,
  style: CellStyle,
  sheetName?: string,
): Promise<Buffer> {
  const workbook = await loadWorkbook()
  await workbook.xlsx.load(buffer)

  const worksheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0]
  if (!worksheet) {
    throw new FileEditorError('SHEET_NOT_FOUND', `Sheet "${sheetName ?? 'first'}" not found`)
  }

  const { c1, r1, c2, r2 } = parseA1Range(range)
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      applyStyle(worksheet.getCell(r, c), style)
    }
  }

  const buf = await workbook.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

/** Strukturális műveletek köteg: merge, oszlopszélesség, sormagasság, freeze, autofilter. */
export async function xlsxApplyLayout(
  buffer: Buffer,
  layout: XlsxLayout,
  sheetName?: string,
): Promise<Buffer> {
  const workbook = await loadWorkbook()
  await workbook.xlsx.load(buffer)

  const worksheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0]
  if (!worksheet) {
    throw new FileEditorError('SHEET_NOT_FOUND', `Sheet "${sheetName ?? 'first'}" not found`)
  }

  for (const merge of layout.mergeCells ?? []) {
    worksheet.mergeCells(merge)
  }
  for (const { column, width } of layout.columnWidths ?? []) {
    worksheet.getColumn(column).width = width
  }
  for (const { row, height } of layout.rowHeights ?? []) {
    worksheet.getRow(row).height = height
  }
  if (layout.freeze && (layout.freeze.rows || layout.freeze.columns)) {
    worksheet.views = [
      {
        state: 'frozen',
        xSplit: layout.freeze.columns ?? 0,
        ySplit: layout.freeze.rows ?? 0,
      },
    ]
  }
  if (layout.autoFilter) {
    worksheet.autoFilter = layout.autoFilter
  }

  const buf = await workbook.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

/** Üres munkafüzet megnevezett munkalap(ok)kal és opcionális 2D adatblokkal. */
export async function xlsxCreate(sheets: XlsxSheetSpec[]): Promise<Buffer> {
  const workbook = await loadWorkbook()

  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name)
    for (const row of sheet.rows ?? []) {
      worksheet.addRow(row)
    }
  }

  const buf = await workbook.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

export async function xlsxAppendRows(
  buffer: Buffer,
  newRows: XlsxRow[],
  sheetName?: string,
): Promise<Buffer> {
  const workbook = await loadWorkbook()
  await workbook.xlsx.load(buffer)

  const worksheet = sheetName
    ? workbook.getWorksheet(sheetName)
    : workbook.worksheets[0]

  if (!worksheet) {
    throw new FileEditorError('SHEET_NOT_FOUND', `Sheet "${sheetName ?? 'first'}" not found`)
  }

  for (const row of newRows) {
    worksheet.addRow(Object.values(row))
  }

  const buf = await workbook.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}
