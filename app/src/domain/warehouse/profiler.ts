/**
 * Profilozás (#984 §5/2, kód, AI nélkül): munkalapok, fejléc (több sor is),
 * típusok, hiányok, ismétlődések, lehetséges azonosítók, blokkhatárok,
 * összesítő sorok, szerkezeti ujjlenyomat. Tiszta függvények a rácson.
 */
import { createHash } from 'node:crypto'
import { columnLetter, parseCellRef, type SheetGrid, type WorkbookGrid } from './excel-reader'
import {
  cellText,
  guessCellType,
  isEmptyCell,
  parseHuDate,
  parseHuNumber,
  type RawCell,
  type WarehouseFieldType,
} from './value-parse'

export type SheetLayout = {
  headerStartRow: number
  headerEndRow: number
  columns: string[]
  /** Az első blokk adatsorai (üres sor = blokkhatár), összesítő sorok nélkül. */
  dataRows: Array<{ rowNumber: number; cells: RawCell[] }>
  blocks: Array<{ startRow: number; endRow: number; rows: number }>
  totalRows: number[]
}

export type ColumnProfile = {
  index: number
  letter: string
  header: string
  inferredType: WarehouseFieldType | 'empty' | 'mixed'
  typeCounts: Partial<Record<WarehouseFieldType, number>>
  filled: number
  empty: number
  distinct: number
  duplicateValues: number
  candidateKey: boolean
  formulaCells: number
  hints: string[]
  samples: string[]
}

export type SheetProfile = {
  name: string
  hidden: boolean
  headerRows: { start: number; end: number }
  dataRowCount: number
  blocks: SheetLayout['blocks']
  totalRowsSkipped: number[]
  mergedRanges: number
  errorCells: number
  truncated: boolean
  fingerprint: string
  columns: ColumnProfile[]
  warnings: string[]
}

export type WorkbookProfile = { sheets: SheetProfile[]; warnings: string[] }

const TOTAL_ROW = /^(mind)?összesen\b|^összes\b|^total\b|^sum\b|^végösszeg\b/i
const SAMPLE_COUNT = 5
const SAMPLE_MAX_CHARS = 80

function nonEmptyCount(cells: RawCell[]): number {
  return cells.filter((c) => !isEmptyCell(c)).length
}

function isTextOnly(cells: RawCell[]): boolean {
  const filled = cells.filter((c) => !isEmptyCell(c))
  return filled.length > 0 && filled.every((c) => typeof c === 'string' && guessCellType(c) === 'text')
}

function horizontalMergeRows(grid: SheetGrid): Set<number> {
  const rows = new Set<number>()
  for (const range of grid.merges) {
    const [a, b] = range.split(':')
    const s = a ? parseCellRef(a) : null
    const e = b ? parseCellRef(b) : null
    if (s && e && e.col > s.col) for (let r = s.row; r <= e.row; r++) rows.add(r)
  }
  return rows
}

/** Fejléc-felismerés; `override.headerRow` = az utolsó fejlécsor (1-alapú). */
export function detectLayout(grid: SheetGrid, override?: { headerRow?: number; headerRowCount?: number }): SheetLayout | null {
  const rows = grid.rows.filter((r) => nonEmptyCount(r.cells) > 0)
  if (rows.length === 0) return null
  let startIdx: number
  let endIdx: number
  if (override?.headerRow) {
    endIdx = rows.findIndex((r) => r.rowNumber === override.headerRow)
    if (endIdx < 0) return null
    startIdx = Math.max(0, endIdx - Math.max(1, Math.min(3, override.headerRowCount ?? 1)) + 1)
  } else {
    const probe = rows.slice(0, 50)
    const maxCols = Math.max(...probe.map((r) => nonEmptyCount(r.cells)))
    const threshold = Math.min(2, maxCols) > 1 ? Math.max(2, Math.ceil(maxCols * 0.5)) : 1
    startIdx = probe.findIndex((r, i) => i < 30 && nonEmptyCount(r.cells) >= threshold && isTextOnly(r.cells) && i + 1 < rows.length)
    if (startIdx < 0) startIdx = 0
    endIdx = startIdx
    // Több fejlécsor csak akkor, ha a felső sorban vízszintesen összevont csoportfejléc van.
    const merged = horizontalMergeRows(grid)
    while (
      endIdx - startIdx < 2 &&
      merged.has(rows[endIdx]!.rowNumber) &&
      endIdx + 2 < rows.length &&
      rows[endIdx + 1]!.rowNumber === rows[endIdx]!.rowNumber + 1 &&
      isTextOnly(rows[endIdx + 1]!.cells)
    ) {
      endIdx++
    }
  }
  const headerRows = rows.slice(startIdx, endIdx + 1)
  const width = Math.max(...rows.slice(startIdx, startIdx + 200).map((r) => r.cells.length))
  const seen = new Map<string, number>()
  const columns: string[] = []
  for (let c = 0; c < width; c++) {
    const parts: string[] = []
    for (const row of headerRows) {
      const text = cellText(row.cells[c] ?? null).replace(/\s+/g, ' ')
      if (text && parts[parts.length - 1] !== text) parts.push(text)
    }
    let name = parts.join(' / ').slice(0, 120) || `Oszlop ${columnLetter(c)}`
    const count = seen.get(name.toLowerCase()) ?? 0
    seen.set(name.toLowerCase(), count + 1)
    if (count > 0) name = `${name} (${count + 1})`
    columns.push(name)
  }
  // Blokkok: üres sor (hiányzó sorszám) választja el őket.
  const after = rows.slice(endIdx + 1)
  const blocks: SheetLayout['blocks'] = []
  for (const row of after) {
    const last = blocks[blocks.length - 1]
    if (last && row.rowNumber === last.endRow + 1) {
      last.endRow = row.rowNumber
      last.rows++
    } else {
      blocks.push({ startRow: row.rowNumber, endRow: row.rowNumber, rows: 1 })
    }
  }
  const first = blocks[0]
  const totalRows: number[] = []
  const dataRows: SheetLayout['dataRows'] = []
  if (first) {
    for (const row of after) {
      if (row.rowNumber > first.endRow) break
      const firstText = row.cells.find((c) => !isEmptyCell(c))
      if (typeof firstText === 'string' && TOTAL_ROW.test(firstText.trim())) {
        totalRows.push(row.rowNumber)
        continue
      }
      dataRows.push(row)
    }
  }
  return {
    headerStartRow: headerRows[0]!.rowNumber,
    headerEndRow: headerRows[headerRows.length - 1]!.rowNumber,
    columns,
    dataRows,
    blocks,
    totalRows,
  }
}

/** Szerkezeti ujjlenyomat: normalizált fejlécnevek sorrendben — a fájlnév nem számít (§5/3). */
export function structureFingerprint(columns: string[]): string {
  const normalized = columns.map((c) => c.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim())
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 32)
}

function profileColumn(layout: SheetLayout, grid: SheetGrid, index: number): ColumnProfile {
  const typeCounts: Partial<Record<WarehouseFieldType, number>> = {}
  const counts = new Map<string, number>()
  const samples: string[] = []
  const hints = new Set<string>()
  let filled = 0
  for (const row of layout.dataRows) {
    const value = row.cells[index] ?? null
    if (isEmptyCell(value)) continue
    filled++
    const type = guessCellType(value)
    typeCounts[type] = (typeCounts[type] ?? 0) + 1
    const text = cellText(value)
    counts.set(text, (counts.get(text) ?? 0) + 1)
    if (samples.length < SAMPLE_COUNT && !samples.includes(text.slice(0, SAMPLE_MAX_CHARS))) {
      samples.push(text.slice(0, SAMPLE_MAX_CHARS))
    }
    if (typeof value === 'string') {
      const number = parseHuNumber(value)
      if (number) {
        if (/\d,\d/.test(value)) hints.add('decimal_comma')
        if (/\d[\s  ]\d{3}/.test(value)) hints.add('space_thousands')
        if (number.currency) hints.add(`currency_${number.currency}`)
        if (number.percent) hints.add('percent')
      }
      if (/^\d{4}\.\s?\d{1,2}\.\s?\d{1,2}\.?$/.test(value.trim()) && parseHuDate(value)) hints.add('hu_date')
    }
  }
  const kinds = Object.keys(typeCounts) as WarehouseFieldType[]
  let inferredType: ColumnProfile['inferredType'] = 'empty'
  if (kinds.length === 1) inferredType = kinds[0]!
  else if (kinds.length === 2 && typeCounts.integer && typeCounts.decimal) inferredType = 'decimal'
  else if (kinds.length > 1) {
    // ≥95% egy típus → az a típus; a maradék az előnézetben hibás érték lesz.
    const [top, topCount] = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]!
    inferredType = topCount / filled >= 0.95 ? (top as WarehouseFieldType) : 'mixed'
  }
  const duplicateValues = [...counts.values()].filter((n) => n > 1).length
  const rows = layout.dataRows.length
  return {
    index,
    letter: columnLetter(index),
    header: layout.columns[index] ?? columnLetter(index),
    inferredType,
    typeCounts,
    filled,
    empty: rows - filled,
    distinct: counts.size,
    duplicateValues,
    candidateKey: rows > 0 && filled === rows && counts.size === filled,
    formulaCells: grid.formulaCells[index] ?? 0,
    hints: [...hints],
    samples,
  }
}

export function profileSheet(grid: SheetGrid): SheetProfile | null {
  const layout = detectLayout(grid)
  if (!layout) return null
  const columns = layout.columns.map((_, i) => profileColumn(layout, grid, i))
  const warnings: string[] = []
  if (grid.state !== 'visible') warnings.push('hidden_sheet')
  if (layout.blocks.length > 1) warnings.push('multiple_blocks')
  if (layout.totalRows.length) warnings.push('total_rows_skipped')
  if (grid.truncatedRows || grid.truncatedColumns) warnings.push('truncated')
  if (grid.errorCells) warnings.push('error_cells')
  if (columns.some((c) => c.formulaCells > 0)) warnings.push('formula_results_used')
  if (layout.headerEndRow > layout.headerStartRow) warnings.push('multi_row_header')
  return {
    name: grid.name,
    hidden: grid.state !== 'visible',
    headerRows: { start: layout.headerStartRow, end: layout.headerEndRow },
    dataRowCount: layout.dataRows.length,
    blocks: layout.blocks.slice(0, 20),
    totalRowsSkipped: layout.totalRows.slice(0, 20),
    mergedRanges: grid.merges.length,
    errorCells: grid.errorCells,
    truncated: grid.truncatedRows || grid.truncatedColumns,
    fingerprint: structureFingerprint(layout.columns),
    columns,
    warnings,
  }
}

export function profileWorkbook(workbook: WorkbookGrid): WorkbookProfile {
  const sheets = workbook.sheets.map(profileSheet).filter((s): s is SheetProfile => s !== null)
  const warnings: string[] = []
  if (workbook.truncatedSheets) warnings.push('too_many_sheets')
  if (sheets.length === 0) warnings.push('no_data')
  return { sheets, warnings }
}
