/**
 * XLSX → semleges cella-rács (#984 §5/1–2). A zip-bomba / túlméret kapu a
 * kitömörítés ELŐTT fut (AC12, #405 residual); a képlet helyett az eredménye,
 * a rich text / hiperlink helyett a szövege kerül a rácsba.
 */
import { assertSafeOfficeArchive, OfficeArchiveError } from '@/lib/office-archive-guard'
import type { RawCell } from './value-parse'

export const WAREHOUSE_MAX_FILE_BYTES = 10 * 1024 * 1024
export const WAREHOUSE_MAX_SHEETS = 50
export const WAREHOUSE_MAX_COLUMNS = 200
export const WAREHOUSE_MAX_ROWS = 100_000
/**
 * Felső korlát az összevont tartományok által szintetizált cellák számára
 * EGÉSZ munkafüzetre (nem laponként) — a `<mergeCell>` amplifikáció elleni
 * memória-plafon. A nyers adatcellákat a fájlméret maga korlátozza; a merge-
 * direktívák viszont kompaktak, ezért külön, megosztott költségvetés kell.
 */
export const WAREHOUSE_MAX_MERGE_FILL_CELLS = WAREHOUSE_MAX_ROWS * WAREHOUSE_MAX_COLUMNS

export type SheetGrid = {
  name: string
  /** `visible` | `hidden` | `veryHidden` */
  state: string
  /** 1-alapú sorszám → cellák (index 0 = A oszlop). Csak a nem üres sorok. */
  rows: Array<{ rowNumber: number; cells: RawCell[] }>
  /** `A1:C1` alakú összevont tartományok. */
  merges: string[]
  /** Oszloponként (0-alapú) a képletes cellák száma. */
  formulaCells: Record<number, number>
  errorCells: number
  truncatedRows: boolean
  truncatedColumns: boolean
}

export type WorkbookGrid = { sheets: SheetGrid[]; truncatedSheets: boolean }

export class WarehouseFileError extends Error {
  constructor(readonly code: 'file_too_large' | 'unsafe_archive' | 'unreadable_file' | 'unsupported_format') {
    super(code)
    this.name = 'WarehouseFileError'
  }
}

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

export function assertWarehouseUpload(buffer: Buffer, fileName: string): void {
  if (buffer.byteLength > WAREHOUSE_MAX_FILE_BYTES) throw new WarehouseFileError('file_too_large')
  if (!/\.xlsx$/i.test(fileName) || !buffer.subarray(0, 4).equals(XLSX_MAGIC)) {
    throw new WarehouseFileError('unsupported_format')
  }
  try {
    assertSafeOfficeArchive(buffer)
  } catch (error) {
    if (error instanceof OfficeArchiveError) throw new WarehouseFileError('unsafe_archive')
    throw error
  }
}

type ExcelCellValue = unknown

function normalizeCellValue(value: ExcelCellValue): { cell: RawCell; formula: boolean; error: boolean } {
  if (value === null || value === undefined) return { cell: null, formula: false, error: false }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { cell: value, formula: false, error: false }
  }
  if (value instanceof Date) return { cell: value, formula: false, error: false }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>
    if ('formula' in v || 'sharedFormula' in v) {
      const inner = normalizeCellValue(v.result as ExcelCellValue)
      return { cell: inner.cell, formula: true, error: inner.error }
    }
    if (Array.isArray(v.richText)) {
      return {
        cell: (v.richText as Array<{ text?: unknown }>).map((part) => String(part.text ?? '')).join(''),
        formula: false,
        error: false,
      }
    }
    if ('error' in v) return { cell: null, formula: false, error: true }
    if (typeof v.text === 'string') return { cell: v.text, formula: false, error: false }
  }
  return { cell: null, formula: false, error: false }
}

export function columnLetter(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

export function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/.exec(ref.trim().toUpperCase())
  if (!m) return null
  let col = 0
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(m[2]), col: col - 1 }
}

/** exceljs-sel olvas; a hívó előtte `assertWarehouseUpload`-ot futtat. */
export async function readWorkbookGrid(buffer: Buffer): Promise<WorkbookGrid> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('exceljs')
  const Workbook = mod.default?.Workbook ?? mod.Workbook
  const workbook = new Workbook()
  try {
    await workbook.xlsx.load(buffer)
  } catch {
    throw new WarehouseFileError('unreadable_file')
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const worksheets = workbook.worksheets as any[]
  const sheets: SheetGrid[] = []
  const mergeFillBudget = { cells: WAREHOUSE_MAX_MERGE_FILL_CELLS }
  for (const ws of worksheets.slice(0, WAREHOUSE_MAX_SHEETS)) {
    const grid: SheetGrid = {
      name: String(ws.name ?? ''),
      state: String(ws.state ?? 'visible'),
      rows: [],
      merges: Array.isArray(ws.model?.merges) ? (ws.model.merges as string[]).slice(0, 5_000) : [],
      formulaCells: {},
      errorCells: 0,
      truncatedRows: false,
      truncatedColumns: false,
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ws.eachRow({ includeEmpty: false }, (row: any, rowNumber: number) => {
      if (grid.rows.length >= WAREHOUSE_MAX_ROWS + 50) {
        grid.truncatedRows = true
        return
      }
      const cells: RawCell[] = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row.eachCell({ includeEmpty: false }, (cell: any, colNumber: number) => {
        if (colNumber > WAREHOUSE_MAX_COLUMNS) {
          grid.truncatedColumns = true
          return
        }
        if (cell.isMerged && cell.master && cell.master !== cell) return
        const { cell: value, formula, error } = normalizeCellValue(cell.value)
        if (formula) grid.formulaCells[colNumber - 1] = (grid.formulaCells[colNumber - 1] ?? 0) + 1
        if (error) grid.errorCells++
        while (cells.length < colNumber - 1) cells.push(null)
        cells[colNumber - 1] = value
      })
      grid.rows.push({ rowNumber, cells })
    })
    // A merge-kitöltés költségvetése MEGOSZTOTT az összes lapon: 50 lap sem
    // szintetizálhat együttvéve a plafonnál több cellát (lapokon átívelő OOM).
    sheets.push(applyMerges(grid, mergeFillBudget))
  }
  return { sheets, truncatedSheets: worksheets.length > WAREHOUSE_MAX_SHEETS }
}

/**
 * Az összevont tartomány minden cellája a bal felső (master) értéket kapja.
 *
 * A kitöltés nem kerülheti meg a sor-/cella-plafont: a `<mergeCell>` listát a
 * csomagolt XLSX kompaktan tárolja, így pár ezer bejegyzés (a `merges` 5000-es
 * felső korlátja) milliárdnyi cellát szintetizálna — ami a közös, több-bérlős
 * processzben heap-OOM-ot okozna. Két korlát véd:
 *  1) a merge a `WAREHOUSE_MAX_ROWS` plafonon túl NEM hoz létre új sort (a nyers
 *     sorokat a `readWorkbookGrid` külön, +50-es ráhagyással már korlátozza, így
 *     a végeredmény e ráhagyáson felül nem nő);
 *  2) a kitöltött cellák száma a `budget`-be ütközik, ami EGÉSZ munkafüzetre
 *     megosztott (a hívó adja át lapról lapra), különben 50 lap külön-külön
 *     kimeríthetné a plafont.
 * Mindkét levágást a `truncatedRows` jelzi (a profiler a `truncated*` jelzőket
 * egyetlen figyelmeztetéssé vonja össze).
 */
export function applyMerges(grid: SheetGrid, budget: { cells: number } = { cells: WAREHOUSE_MAX_MERGE_FILL_CELLS }): SheetGrid {
  if (grid.merges.length === 0) return grid
  const byRow = new Map(grid.rows.map((row) => [row.rowNumber, row]))
  fill: for (const range of grid.merges) {
    const [a, b] = range.split(':')
    const start = a ? parseCellRef(a) : null
    const end = b ? parseCellRef(b) : start
    if (!start || !end) continue
    const masterRow = byRow.get(start.row)
    const master = masterRow?.cells[start.col] ?? null
    if (master === null) continue
    const maxRow = Math.min(end.row, start.row + 1_000)
    const maxCol = Math.min(end.col, WAREHOUSE_MAX_COLUMNS - 1)
    for (let r = start.row; r <= maxRow; r++) {
      let row = byRow.get(r)
      if (!row) {
        // A meglévő (nyers) sorok a plafonig kitölthetők, de új sort a merge
        // nem fabrikálhat a korláton túl — különben a sorkorlát megkerülhető.
        if (byRow.size >= WAREHOUSE_MAX_ROWS) {
          grid.truncatedRows = true
          continue
        }
        row = { rowNumber: r, cells: [] }
        byRow.set(r, row)
      }
      for (let c = start.col; c <= maxCol; c++) {
        if (budget.cells <= 0) {
          grid.truncatedRows = true
          break fill
        }
        budget.cells--
        while (row.cells.length <= c) row.cells.push(null)
        if (row.cells[c] === null || row.cells[c] === undefined) row.cells[c] = master
      }
    }
  }
  grid.rows = [...byRow.values()].sort((x, y) => x.rowNumber - y.rowNumber)
  return grid
}
