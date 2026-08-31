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
  dataValidations?: XlsxDataValidation[]
}

/**
 * Legördülő (választólista) egy A1-tartományra.
 *
 * Tartomány-szintű szerkezeti tulajdonság — ezért az `XlsxLayout`-ban van, nem a
 * `CellStyle`-ban: különben ugyanazt a listát cellánként kellene ismételni.
 */
export type XlsxDataValidation = {
  /** A1-tartomány, pl. "K2:K500". */
  range: string
  /** A választható értékek. Vessző nem lehet bennük (ld. `dataValidationFormula`). */
  values: string[]
  /** Engedett-e az üres cella (alap: igen — a kitöltetlen sor nem hibás). */
  allowBlank?: boolean
  /** Hibaüzenet fejléce érvénytelen bevitelnél. */
  errorTitle?: string
  /** Hibaüzenet szövege érvénytelen bevitelnél. */
  error?: string
}

/**
 * Az Excel inline választólistája `"a,b,c"` alakú, EGYETLEN stringbe zárva.
 * Ebből két kemény korlát következik, amit némán elrontott fájl helyett inkább
 * hibával jelzünk:
 *
 *  - vesszőt tartalmazó érték kettészakadna két külön opcióra,
 *  - a teljes formula legfeljebb 255 karakter lehet (Excel-korlát).
 *
 * Hosszabb vagy vesszős lista esetén segédmunkalapra kell tenni az értékeket és
 * tartomány-hivatkozással megadni — azt ez a szint ma nem építi fel.
 */
export const XLSX_DATA_VALIDATION_MAX_FORMULA = 255

export function dataValidationFormula(values: string[]): string {
  if (values.length === 0) {
    throw new FileEditorError('INVALID_RANGE', 'A választólista nem lehet üres.')
  }
  const offender = values.find((v) => v.includes(','))
  if (offender) {
    throw new FileEditorError(
      'INVALID_RANGE',
      `A választólista értéke nem tartalmazhat vesszőt: "${offender}". ` +
        'Az Excel inline listája vessző mentén bontja az opciókat.',
    )
  }
  if (values.some((v) => v.includes('"'))) {
    throw new FileEditorError('INVALID_RANGE', 'A választólista értéke nem tartalmazhat idézőjelet.')
  }
  const formula = `"${values.join(',')}"`
  if (formula.length > XLSX_DATA_VALIDATION_MAX_FORMULA) {
    throw new FileEditorError(
      'INVALID_RANGE',
      `A választólista túl hosszú (${formula.length} karakter, max ${XLSX_DATA_VALIDATION_MAX_FORMULA}). ` +
        'Rövidítsd az értékeket, vagy tedd őket segédmunkalapra.',
    )
  }
  return formula
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

/** Excel munkalap-korlátok: legnagyobb oszlop (XFD) és legnagyobb sorszám. */
export const XLSX_MAX_COLUMN = 16384
export const XLSX_MAX_ROW = 1_048_576

/**
 * Egyetlen formázó / elrendezés-művelet által érintett cellák felső korlátja.
 *
 * A `xlsxFormatRange` és a `xlsxApplyLayout` dataValidation-ága egy A1-tartomány
 * MINDEN celláját bejárja (`for r … for c`, cellánként `getCell`). Terület-plafon
 * nélkül egyetlen agent-hívás (pl. `"A1:XFD1048576"` = 16384×1048576 ≈ 17 milliárd
 * cella) végtelenbe nyúló ciklust + tömeges cella-allokációt indítana, ami a
 * MEGOSZTOTT, több-tenantos Node-futásidőt lefagyasztja vagy OOM-mal megöli — így
 * egyetlen munkaterület hívása az összes tenant szolgáltatását megbénítaná (DoS).
 *
 * A plafon bőven a valós táblák felett van (az olvasás alapból max ~500 sor),
 * de a fenti berobbanást kizárja. Oszlop-szintű beállítást (szélesség, rögzítés)
 * nem cellánként, hanem az `xlsxApplyLayout` dedikált mezőivel kell megadni.
 */
export const XLSX_MAX_RANGE_CELLS = 250_000

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

/** Egyetlen cella ("A1") vagy tartomány ("A1:E1") — a single-cell Excel UX miatt. */
export function parseA1Range(range: string): { c1: number; r1: number; c2: number; r2: number } {
  const trimmed = range.trim()
  const [from, to] = trimmed.split(':')
  if (!from) {
    throw new FileEditorError('INVALID_RANGE', `Invalid A1 range: ${range}`)
  }
  const start = parseA1Cell(from)
  const end = to ? parseA1Cell(to) : start
  const c1 = Math.min(start.col, end.col)
  const r1 = Math.min(start.row, end.row)
  const c2 = Math.max(start.col, end.col)
  const r2 = Math.max(start.row, end.row)

  // Terület-plafon: a tartományt a hívók cellánként bejárják — plafon nélkül egy
  // teljes-lap tartomány (pl. "A1:XFD1048576") a megosztott futásidőt megbénítaná.
  // (Excel-korláton túli hivatkozás is ide fut be, mielőtt bármit módosítanánk.)
  if (c2 > XLSX_MAX_COLUMN || r2 > XLSX_MAX_ROW) {
    throw new FileEditorError(
      'INVALID_RANGE',
      `A tartomány túllépi az Excel korlátait (max oszlop XFD, max sor ${XLSX_MAX_ROW}): ${range}`,
    )
  }
  const cellCount = (c2 - c1 + 1) * (r2 - r1 + 1)
  if (cellCount > XLSX_MAX_RANGE_CELLS) {
    throw new FileEditorError(
      'INVALID_RANGE',
      `A tartomány túl nagy: ${cellCount} cella (max ${XLSX_MAX_RANGE_CELLS}). ` +
        'Szűkítsd a tartományt (pl. csak a fejlécsort vagy a ténylegesen kitöltött sorokat formázd); ' +
        'oszlopszélesség/rögzítés beállításához az xlsx_layout dedikált mezőit használd, ne cellánkénti formázást.',
    )
  }

  return { c1, r1, c2, r2 }
}

function sheetNotFoundError(sheetName: string | undefined, workbook: { worksheets: Array<{ name: string }> }) {
  const available = workbook.worksheets.map((ws) => ws.name)
  const availableLabel = available.length > 0 ? available.join(', ') : '(nincs lap)'
  return new FileEditorError(
    'SHEET_NOT_FOUND',
    `Sheet "${sheetName ?? 'first'}" not found. Available sheets: ${availableLabel}`,
  )
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
    throw sheetNotFoundError(sheetName, workbook)
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
    throw sheetNotFoundError(sheetName, workbook)
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
    throw sheetNotFoundError(sheetName, workbook)
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
    throw sheetNotFoundError(sheetName, workbook)
  }

  for (const merge of layout.mergeCells ?? []) {
    // A merge-tartományt a `mergeCells` ELŐTT a közös terület-kapun engedjük át:
    // az exceljs a merge teljes területét cellánként bejárja, ezért plafon nélkül
    // egy `"A1:XFD1048576"` merge ugyanazt a több-tenantos DoS-t okozná, mint a
    // formázás — ez az ág korábban NEM ment át a parseA1Range ellenőrzésen.
    parseA1Range(merge)
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
  for (const dv of layout.dataValidations ?? []) {
    // A formulát a tartomány bejárása ELŐTT állítjuk elő: ha érvénytelen a lista,
    // a hiba a munkafüzet módosítása előtt jöjjön (ne maradjon félig felírt lap).
    const formula = dataValidationFormula(dv.values)
    const { c1, r1, c2, r2 } = parseA1Range(dv.range)
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        worksheet.getCell(r, c).dataValidation = {
          type: 'list',
          allowBlank: dv.allowBlank ?? true,
          formulae: [formula],
          showErrorMessage: true,
          ...(dv.errorTitle ? { errorTitle: dv.errorTitle } : {}),
          ...(dv.error ? { error: dv.error } : {}),
        }
      }
    }
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
    throw sheetNotFoundError(sheetName, workbook)
  }

  for (const row of newRows) {
    worksheet.addRow(Object.values(row))
  }

  const buf = await workbook.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}
