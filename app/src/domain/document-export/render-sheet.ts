/**
 * #1024: táblázat → XLSX (alap formázással, az Xlsx-Formatting spec szerint) vagy CSV.
 * XLSX: kiemelt, rögzített fejléc, szűrő, oszlopszélesség a tartalomhoz, szám- és dátumformátum.
 * A szöveg sosem képlet: a „=…” kezdetű érték adatként marad (CSV-ben aposztróf-előtaggal).
 */
import ExcelJS from 'exceljs'

export type SheetCell = string | number | boolean | null
export type SheetInput = {
  name: string
  headers: string[]
  rows: SheetCell[][]
  /** Fejléc → Excel számformátum, pl. `#,##0 "Ft"`, `0.0%`, `yyyy.mm.dd.` */
  numberFormats: Record<string, string>
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/
const DATE_FORMAT = 'yyyy.mm.dd.'
const DATE_TIME_FORMAT = 'yyyy.mm.dd. hh:mm'
const HEADER_FILL = 'FFE8EEF7'
const MIN_WIDTH = 8
const MAX_WIDTH = 60

/**
 * ISO dátum → Date; egyébként null. Az Excelnek nincs időzónája: a falióra-időt UTC-ként tároljuk,
 * hogy ugyanazt a napot és órát mutassa (időzónás értéknél az UTC-időt).
 */
export function isoDate(value: string): { date: Date; withTime: boolean } | null {
  const m = ISO_DATE.exec(value.trim())
  if (!m) return null
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1, 7).map((part) => (part === undefined ? undefined : Number(part))) as number[]
  const date = m[7] ? new Date(value.trim()) : new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  if (Number.isNaN(date.getTime()) || (!m[7] && (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d))) return null
  return { date, withTime: m[4] !== undefined }
}

function displayLength(value: SheetCell): number {
  if (value === null) return 0
  if (typeof value === 'number') return value.toLocaleString('hu-HU').length + 1
  return String(value)
    .split('\n')
    .reduce((max, line) => Math.max(max, line.length), 0)
}

export async function renderXlsx(sheets: SheetInput[], meta: { title?: string }): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Excellence AI'
  if (meta.title) workbook.title = meta.title
  const usedNames = new Set<string>()
  for (const [index, input] of sheets.entries()) {
    const sheet = workbook.addWorksheet(uniqueSheetName(input.name || `Munkalap ${index + 1}`, usedNames), {
      views: input.headers.length ? [{ state: 'frozen', ySplit: 1 }] : [],
    })
    const width = Math.max(input.headers.length, ...input.rows.map((r) => r.length), 0)
    if (input.headers.length) {
      const header = sheet.addRow(input.headers)
      header.font = { bold: true }
      header.alignment = { vertical: 'middle', wrapText: true }
      header.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
        cell.border = { bottom: { style: 'thin' } }
      })
    }
    const lengths = Array.from({ length: width }, (_, c) => displayLength(input.headers[c] ?? null))
    for (const row of input.rows) {
      const excelRow = sheet.addRow(row.map((value) => (typeof value === 'string' ? (isoDate(value)?.date ?? value) : value)))
      row.forEach((value, c) => {
        lengths[c] = Math.max(lengths[c] ?? 0, displayLength(value))
        const cell = excelRow.getCell(c + 1)
        const explicit = input.numberFormats[input.headers[c] ?? '']
        if (explicit && (typeof value === 'number' || cell.value instanceof Date)) cell.numFmt = explicit
        else if (cell.value instanceof Date) cell.numFmt = isoDate(value as string)?.withTime ? DATE_TIME_FORMAT : DATE_FORMAT
        else if (typeof value === 'number') cell.numFmt = Number.isInteger(value) ? '#,##0' : '#,##0.00'
        if (typeof value === 'string' && value.includes('\n')) cell.alignment = { wrapText: true, vertical: 'top' }
      })
    }
    lengths.forEach((length, c) => {
      sheet.getColumn(c + 1).width = Math.min(Math.max(length + 2, MIN_WIDTH), MAX_WIDTH)
    })
    if (input.headers.length && input.rows.length) {
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: input.headers.length } }
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

/** Excel munkalapnév: max. 31 karakter, `[]:*?/\` nélkül, egyedi. */
function uniqueSheetName(raw: string, used: Set<string>): string {
  const base = raw.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Munkalap'
  let name = base
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`
  used.add(name.toLowerCase())
  return name
}

/** CSV-injekció ellen: képletként értelmezhető szöveg elé aposztróf. */
function csvCell(value: SheetCell): string {
  if (value === null) return ''
  let text = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** RFC 4180, UTF-8 BOM-mal (az Excel így ismeri fel az ékezeteket). */
export function renderCsv(sheet: SheetInput): Buffer {
  const lines = [...(sheet.headers.length ? [sheet.headers] : []), ...sheet.rows].map((row) => row.map(csvCell).join(','))
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8')
}
