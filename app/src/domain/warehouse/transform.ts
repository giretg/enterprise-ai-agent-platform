/**
 * Transzformáció + egyszerű egyezés (#984 §5/5, R1). Kód, AI nélkül: a terv
 * szerint típusos sorokat épít, az üzleti kulcsot képzi, a fájlon belüli
 * ismétlődést kezeli, és a kapcsolatokat pontos azonosító / normalizált név
 * alapján köti. Bizonytalan egyezés SOSEM lesz kapcsolat, csak kivétel (AC2).
 */
import type { SheetGrid } from './excel-reader'
import type { ImportPlan, PlanLink } from './plan'
import { resolveSourceColumn } from './plan'
import { detectLayout, profileSheet } from './profiler'
import { cellText, convertCell, nameWithoutLegalForm, normalizeName } from './value-parse'

export type RowValue = string | number | boolean | null

export type PreparedRow = {
  sourceRow: number
  values: Record<string, RowValue>
  /** Üzleti kulcs (JSON); hozzáfűző módban null. */
  bk: string | null
}

export type RowIssue = {
  sourceRow: number
  kind: 'invalid_value' | 'missing_required' | 'missing_key' | 'duplicate_key'
  field: string | null
  value: string | null
  detail?: string
}

export type PreparedImport = { rows: PreparedRow[]; issues: RowIssue[]; sourceRows: number }

export function prepareRows(grid: SheetGrid, plan: ImportPlan): PreparedImport | null {
  const layout = detectLayout(grid, plan.headerRow ? { headerRow: plan.headerRow, headerRowCount: plan.headerRowCount } : undefined)
  const profile = profileSheet(grid)
  if (!layout || !profile) return null
  const sheetColumns = { columns: layout.columns.map((header, index) => ({ header, index, letter: profile.columns[index]?.letter ?? '' })) }
  const mapping = plan.fields.map((field) => ({ field, col: resolveSourceColumn(sheetColumns, field.source) }))
  const issues: RowIssue[] = []
  const byKey = new Map<string, number>()
  const rows: PreparedRow[] = []
  for (const source of layout.dataRows) {
    const values: Record<string, RowValue> = {}
    let invalid = false
    for (const { field, col } of mapping) {
      const raw = col === null ? null : (source.cells[col] ?? null)
      const converted = convertCell(raw, field.type)
      if (!converted.ok) {
        invalid = true
        issues.push({ sourceRow: source.rowNumber, kind: 'invalid_value', field: field.target, value: cellText(raw).slice(0, 200), detail: converted.reason })
        continue
      }
      values[field.target] = converted.value
      const isKey = plan.businessKey.includes(field.target)
      if (converted.value === null && (field.required || isKey)) {
        invalid = true
        issues.push({ sourceRow: source.rowNumber, kind: isKey ? 'missing_key' : 'missing_required', field: field.target, value: null })
      }
    }
    if (invalid) continue
    const bk = plan.mode === 'upsert' ? JSON.stringify(plan.businessKey.map((k) => normalizeKeyPart(values[k] ?? null))) : null
    const row: PreparedRow = { sourceRow: source.rowNumber, values, bk }
    if (bk !== null) {
      const previous = byKey.get(bk)
      if (previous !== undefined) {
        issues.push({ sourceRow: source.rowNumber, kind: 'duplicate_key', field: plan.businessKey.join(','), value: bk.slice(0, 200), detail: `first at row ${rows[previous]!.sourceRow}` })
        if (plan.duplicates === 'last_wins') {
          rows[previous] = row
        }
        continue
      }
      byKey.set(bk, rows.length)
    }
    rows.push(row)
  }
  return { rows, issues, sourceRows: layout.dataRows.length }
}

function normalizeKeyPart(value: RowValue): RowValue {
  return typeof value === 'string' ? value.trim() : value
}

// ── Egyezés (R1: pontos azonosító / normalizált név + függő kivétel) ───────────

export type LinkTarget = { id: string; value: string }

export type LinkIndex = {
  exact: Map<string, string[]>
  loose: Map<string, string[]>
}

export function buildLinkIndex(targets: LinkTarget[], by: PlanLink['by']): LinkIndex {
  const exact = new Map<string, string[]>()
  const loose = new Map<string, string[]>()
  const push = (map: Map<string, string[]>, key: string, id: string) => {
    if (!key) return
    const list = map.get(key)
    if (list) list.push(id)
    else map.set(key, [id])
  }
  for (const target of targets) {
    if (by === 'key') push(exact, target.value.trim(), target.id)
    else {
      push(exact, normalizeName(target.value), target.id)
      push(loose, nameWithoutLegalForm(target.value), target.id)
    }
  }
  return { exact, loose }
}

export type LinkMatch =
  | { status: 'matched'; id: string; method: 'business_key' | 'normalized_name' }
  | { status: 'suggested' | 'ambiguous'; candidates: string[] }
  | { status: 'unmatched' }
  | { status: 'empty' }

export function matchLink(value: RowValue, index: LinkIndex, by: PlanLink['by']): LinkMatch {
  if (value === null || String(value).trim() === '') return { status: 'empty' }
  const text = String(value)
  const exactKey = by === 'key' ? text.trim() : normalizeName(text)
  const exact = index.exact.get(exactKey) ?? []
  if (exact.length === 1) return { status: 'matched', id: exact[0]!, method: by === 'key' ? 'business_key' : 'normalized_name' }
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact.slice(0, 10) }
  if (by === 'name') {
    // „Kovács Borház” ↔ „Kovács Borház Kft.”: csak javaslat, megerősítésig nincs kapcsolat.
    const loose = index.loose.get(nameWithoutLegalForm(text)) ?? []
    if (loose.length === 1) return { status: 'suggested', candidates: loose }
    if (loose.length > 1) return { status: 'ambiguous', candidates: loose.slice(0, 10) }
  }
  return { status: 'unmatched' }
}
