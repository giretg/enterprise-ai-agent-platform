import { FileEditorError } from '../workspace-storage'

export type XlsxRow = Record<string, string | number | boolean | null>

export type XlsxCellChange = {
  cell: string
  value: string | number | boolean | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importExceljs(): Promise<any> {
  try {
    return await import('exceljs')
  } catch {
    throw new FileEditorError(
      'BINARY_ADAPTER_UNAVAILABLE',
      'exceljs is not installed. Run: npm install exceljs',
    )
  }
}

export async function xlsxReadSheet(
  buffer: Buffer,
  sheetName?: string,
  maxRows = 500,
): Promise<{ sheet: string; headers: string[]; rows: XlsxRow[] }> {
  const ExcelJS = await importExceljs()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)

  const worksheet = sheetName
    ? workbook.getWorksheet(sheetName)
    : workbook.worksheets[0]

  if (!worksheet) {
    throw new FileEditorError('SHEET_NOT_FOUND', `Sheet "${sheetName ?? 'first'}" not found`)
  }

  const headers: string[] = []
  const rows: XlsxRow[] = []
  let headerRow: unknown[] = []

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values = (row.values as unknown[]).slice(1)
    if (rowNumber === 1) {
      headerRow = values
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

export async function xlsxWriteCells(
  buffer: Buffer,
  changes: XlsxCellChange[],
  sheetName?: string,
): Promise<Buffer> {
  const ExcelJS = await importExceljs()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)

  const worksheet = sheetName
    ? workbook.getWorksheet(sheetName)
    : workbook.worksheets[0]

  if (!worksheet) {
    throw new FileEditorError('SHEET_NOT_FOUND', `Sheet "${sheetName ?? 'first'}" not found`)
  }

  for (const { cell, value } of changes) {
    worksheet.getCell(cell).value = value as ExcelJS.CellValue
  }

  const buf = await workbook.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

export async function xlsxAppendRows(
  buffer: Buffer,
  newRows: XlsxRow[],
  sheetName?: string,
): Promise<Buffer> {
  const ExcelJS = await importExceljs()
  const workbook = new ExcelJS.Workbook()
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
