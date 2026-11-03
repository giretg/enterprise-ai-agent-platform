/**
 * #1071: nagy, de hiánytalan kapcsolati válasz (pl. havi × partner × termék riport) — a teljes adat nem
 * vész el a 20 000 karakteres modell-plafonnál. A teljes válasz a kérő user + munkatárs ideiglenes
 * tárolójába kerül (7 nap, más user nem látja), a modell előnézetet és azonosítót kap. A mentett
 * adatból lapozva olvashat (`http_api_saved_read`), és át-gépelés nélkül fájlt készíthet
 * (`document_export` `savedResultId`-vel).
 */

import { loadOwnExport, type DocumentExportStore } from '@/domain/document-export/document-export-store'

/** A mentett válasz `document_exports.format` értéke (a fájl-tároló sorai között, ugyanazzal a hozzáféréssel). */
export const SAVED_RESULT_FORMAT = 'json'
export const SAVED_RESULT_MIME = 'application/json; charset=utf-8'
export const SAVED_RESULT_MAX_BYTES = 10 * 1024 * 1024
/** Mentett válasznál a modell ennyi előnézetet kap — a többit lapozva olvashatja. */
export const SAVED_RESULT_PREVIEW_CHARS = 4_000
export const SAVED_READ_DEFAULT_ROWS = 100
export const SAVED_READ_MAX_ROWS = 1_000
const MAX_FIELDS_LISTED = 50
const MAX_FLATTEN_DEPTH = 6
const MAX_SEARCH_DEPTH = 5
/** Oszlopleírás, nem adatsor — ha van más tömb, nem ez a táblázat. */
const META_ARRAY_KEYS = new Set(['columns', 'headers', 'fields', 'warnings', 'errors', 'links'])

export type SavedHttpResultInfo = {
  savedResultId: string
  totalChars: number
  /** A felismert sorlista hossza; null = nincs sorlista (a mentett adat szövegként olvasható). */
  rowCount: number | null
  /** A sorlista helye a mentett adatban, pl. `body.data.rows`. */
  arrayPath: string | null
  /** A sorok mezői (lapított útvonal), legfeljebb 50 — a `document_export` `columns`-hoz. */
  fields: string[]
  expiresAt: string
}

/** A mentést a hívó (a kérő user + munkatárs) adja; `null` = nem sikerült, a modell csak előnézetet kap. */
export type SaveOversizedHttpResult = (input: {
  data: Buffer
  path: string
  toolName: string
}) => Promise<{ id: string; expiresAt: Date } | null>

export class SavedResultError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'SavedResultError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A modell felé menő hint/csonkolás-jelzés nem része az adatnak. Csonkolt (nem JSON, hosszú szöveg)
 * választ nem mentünk: a teljes törzs már a kliensben elveszett, a mentés hiányos adatot ígérne.
 */
function savableResult(result: unknown): Record<string, unknown> | null {
  if (!isPlainObject(result) || result.ok === false) return null
  const body = result.body
  if (result.truncated === true && (typeof body === 'string' || (isPlainObject(body) && body.truncated === true))) return null
  const { hint: _hint, truncated: _truncated, ...data } = result
  return data
}

function slug(path: string): string {
  return (
    path
      .split('?')[0]!
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'valasz'
  )
}

export function savedResultFileName(path: string, now: Date): string {
  return `${slug(path)}-${now.toISOString().slice(0, 10)}.json`
}

/**
 * Ha a válasz a modell-plafon fölött van, de hiánytalan, elmenti, és leírja a modellnek (sorszám,
 * mezők). Kicsi, hibás vagy már csonkolt válasznál `null` — ilyenkor a régi előnézet marad.
 */
export async function saveOversizedHttpResult(input: {
  result: unknown
  maxChars: number
  path: string
  toolName: string
  save?: SaveOversizedHttpResult
}): Promise<SavedHttpResultInfo | null> {
  if (!input.save) return null
  const data = savableResult(input.result)
  if (!data) return null
  let full: string
  let json: string
  try {
    full = JSON.stringify(input.result) ?? ''
    json = JSON.stringify(data) ?? ''
  } catch {
    return null
  }
  if (full.length <= input.maxChars) return null
  const bytes = Buffer.from(json, 'utf8')
  if (bytes.length > SAVED_RESULT_MAX_BYTES) return null
  let saved: { id: string; expiresAt: Date } | null
  try {
    saved = await input.save({ data: bytes, path: input.path, toolName: input.toolName })
  } catch (error) {
    console.warn('http_api.saved_result.save_failed', { path: input.path, error: error instanceof Error ? error.message : String(error) })
    return null
  }
  if (!saved) return null
  const table = locateRecordTable(data)
  return {
    savedResultId: saved.id,
    totalChars: json.length,
    rowCount: table ? table.rows.length : null,
    arrayPath: table?.arrayPath ?? null,
    fields: table ? tableFields(table.rows).slice(0, MAX_FIELDS_LISTED) : [],
    expiresAt: saved.expiresAt.toISOString(),
  }
}

type LocatedTable = { arrayPath: string; rows: unknown[]; columnMeta: unknown }

function isRecordArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.some((item) => item !== null && typeof item === 'object')
}

/**
 * A sorlista a mentett adatban: `arrayPath` megadásakor az, egyébként a leghosszabb objektum-/tömb-sorokból
 * álló tömb (oszlopleírás-kulcs csak végső esetben). A testvér `columns` tömb adja a fejléc-címkéket.
 */
export function locateRecordTable(value: unknown, arrayPath?: string): LocatedTable | null {
  if (arrayPath?.trim()) {
    let parent: unknown = null
    let node: unknown = value
    for (const key of arrayPath.trim().split('.')) {
      if (!isPlainObject(node)) return null
      parent = node
      node = node[key]
    }
    if (!Array.isArray(node)) return null
    return { arrayPath: arrayPath.trim(), rows: node, columnMeta: isPlainObject(parent) ? parent.columns : undefined }
  }
  const candidates: Array<LocatedTable & { meta: boolean }> = []
  const queue: Array<{ node: Record<string, unknown>; path: string; depth: number }> = isPlainObject(value)
    ? [{ node: value, path: '', depth: 0 }]
    : []
  if (Array.isArray(value)) return { arrayPath: '', rows: value, columnMeta: undefined }
  while (queue.length > 0) {
    const { node, path, depth } = queue.shift()!
    for (const [key, child] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key
      if (isRecordArray(child)) {
        candidates.push({ arrayPath: childPath, rows: child, columnMeta: node.columns, meta: META_ARRAY_KEYS.has(key) })
      } else if (isPlainObject(child) && depth < MAX_SEARCH_DEPTH) {
        queue.push({ node: child, path: childPath, depth: depth + 1 })
      }
    }
  }
  const data = candidates.filter((c) => !c.meta)
  const pool = data.length > 0 ? data : candidates
  const best = pool.reduce<(typeof pool)[number] | null>((acc, c) => (!acc || c.rows.length > acc.rows.length ? c : acc), null)
  return best ? { arrayPath: best.arrayPath, rows: best.rows, columnMeta: best.columnMeta } : null
}

function flatten(value: unknown, prefix: string, out: Map<string, unknown>, depth: number): void {
  if (isPlainObject(value) && depth < MAX_FLATTEN_DEPTH && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out, depth + 1)
    return
  }
  out.set(prefix || 'value', value)
}

function flattenRow(row: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  flatten(row, '', out, 0)
  return out
}

/** A sorok mezői első előfordulás szerinti sorrendben (lapított útvonal, pl. `dimensions.partner.name`). */
function tableFields(rows: readonly unknown[]): string[] {
  const seen = new Set<string>()
  for (const row of rows) {
    if (Array.isArray(row)) continue
    for (const key of flattenRow(row).keys()) seen.add(key)
  }
  return [...seen]
}

/** A riport saját oszlopleírása (`columns: [{ key, label }]` vagy szövegek) → kulcs → címke. */
function columnLabels(meta: unknown): Map<string, string> {
  const labels = new Map<string, string>()
  if (!Array.isArray(meta)) return labels
  for (const item of meta) {
    if (typeof item === 'string') {
      labels.set(item, item)
      continue
    }
    if (!isPlainObject(item)) continue
    const key = [item.key, item.id, item.name, item.field].find((v): v is string => typeof v === 'string' && v.length > 0)
    if (!key) continue
    const label = [item.label, item.title, item.name].find((v): v is string => typeof v === 'string' && v.length > 0)
    labels.set(key, label ?? key)
  }
  return labels
}

/**
 * Fejléc a lapított útvonalhoz: a riport címkéje, ha az útvonal (vagy a vége) egy oszlopkulcs. Ha ugyanaz a
 * címke több csoportban is előfordul (pl. `current.netValue` és `previous.netValue`), a csoport zárójelben.
 */
function headersFor(paths: readonly string[], labels: Map<string, string>): string[] {
  const resolved = paths.map((path) => {
    if (labels.has(path)) return { label: labels.get(path)!, group: '' }
    for (let i = path.indexOf('.'); i !== -1; i = path.indexOf('.', i + 1)) {
      const tail = path.slice(i + 1)
      if (labels.has(tail)) return { label: labels.get(tail)!, group: path.slice(0, i) }
    }
    return { label: path, group: '' }
  })
  const counts = new Map<string, number>()
  for (const r of resolved) counts.set(r.label, (counts.get(r.label) ?? 0) + 1)
  return resolved.map((r) => ((counts.get(r.label) ?? 0) > 1 && r.group ? `${r.label} (${r.group})` : r.label))
}

export type SavedColumnChoice = { path: string; header?: string }

/** A `document_export` `columns` mezője: JSON-szöveg, `[{"path", "header"}]` vagy útvonalak tömbje. */
export function parseColumnChoices(raw: string | undefined): SavedColumnChoice[] | undefined {
  if (!raw?.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new SavedResultError('columns: nem érvényes JSON')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new SavedResultError('columns: nem üres tömb kell')
  return parsed.map((item, i) => {
    if (typeof item === 'string' && item.trim()) return { path: item.trim() }
    if (isPlainObject(item) && typeof item.path === 'string' && item.path.trim()) {
      return { path: item.path.trim(), ...(typeof item.header === 'string' && item.header.trim() ? { header: item.header.trim() } : {}) }
    }
    throw new SavedResultError(`columns[${i}]: {"path": "…", "header": "…"} kell`)
  })
}

export type SavedSheet = { name: string; headers: string[]; rows: unknown[][] }

/**
 * A mentett válasz sorlistája munkalapként: a sorok lapítva, a fejléc a riport címkéiből. `columns`
 * megadásakor csak azok az oszlopok, abban a sorrendben.
 */
export function savedResultToSheet(
  data: Buffer,
  options: { name: string; arrayPath?: string; columns?: SavedColumnChoice[] },
): SavedSheet {
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString('utf8'))
  } catch {
    throw new SavedResultError('a mentett válasz nem olvasható')
  }
  const table = locateRecordTable(parsed, options.arrayPath)
  if (!table) {
    throw new SavedResultError(
      options.arrayPath
        ? `arrayPath: a(z) "${options.arrayPath}" nem sorlista`
        : 'a mentett válaszban nincs sorlista — add meg az arrayPath-ot (a sorok helye, pl. body.data.rows)',
    )
  }
  const labels = columnLabels(table.columnMeta)
  if (table.rows.every(Array.isArray)) {
    const width = Math.max(0, ...table.rows.map((r) => (r as unknown[]).length))
    const metaHeaders = [...labels.values()]
    const headers = metaHeaders.length === width ? metaHeaders : Array.from({ length: width }, (_, i) => `${i + 1}. oszlop`)
    return { name: options.name, headers, rows: table.rows as unknown[][] }
  }
  const flat = table.rows.map(flattenRow)
  const paths = options.columns?.map((c) => c.path) ?? tableFields(table.rows)
  const autoHeaders = headersFor(paths, labels)
  const headers = options.columns ? options.columns.map((c, i) => c.header ?? autoHeaders[i]!) : autoHeaders
  return { name: options.name, headers, rows: flat.map((row) => paths.map((p) => row.get(p) ?? null)) }
}

export type SavedReadPage =
  | {
      arrayPath: string
      totalRows: number
      offset: number
      returnedRows: number
      rows: unknown[]
      /** Egyetlen, a plafonnál nagyobb sor eleje (ritka) — a `rows` ilyenkor üres. */
      oversizedRow?: string
      nextOffset: number | null
    }
  | { totalChars: number; offset: number; text: string; nextOffset: number | null }

/**
 * Lapozott olvasás: sorlistánál `offset`/`limit` sor (a válasz `maxChars` alatt marad — ha nem fér, kevesebb
 * sor jön, a `nextOffset` mutatja a folytatást); sorlista nélkül karakter-szelet.
 */
export function readSavedResult(
  data: Buffer,
  options: { offset?: number; limit?: number; arrayPath?: string; maxChars: number },
): SavedReadPage {
  const text = data.toString('utf8')
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const table = parsed === undefined ? null : locateRecordTable(parsed, options.arrayPath)
  if (options.arrayPath && !table) throw new SavedResultError(`arrayPath: a(z) "${options.arrayPath}" nem sorlista`)
  if (!table) {
    const slice = text.slice(offset, offset + options.maxChars)
    const end = offset + slice.length
    return { totalChars: text.length, offset, text: slice, nextOffset: end < text.length ? end : null }
  }
  const limit = Math.min(SAVED_READ_MAX_ROWS, Math.max(1, Math.floor(options.limit ?? SAVED_READ_DEFAULT_ROWS)))
  let rows = table.rows.slice(offset, offset + limit)
  // A boríték (~200 karakter) is a plafon alatt maradjon.
  const budget = Math.max(1, options.maxChars - 300)
  while (rows.length > 1 && JSON.stringify(rows).length > budget) rows = rows.slice(0, Math.ceil(rows.length / 2))
  const single = rows.length === 1 ? JSON.stringify(rows[0]) : ''
  const oversizedRow = single.length > budget ? single.slice(0, budget) : undefined
  const end = offset + rows.length
  return {
    arrayPath: table.arrayPath,
    totalRows: table.rows.length,
    offset,
    returnedRows: oversizedRow ? 0 : rows.length,
    rows: oversizedRow ? [] : rows,
    ...(oversizedRow ? { oversizedRow } : {}),
    nextOffset: end < table.rows.length ? end : null,
  }
}

/**
 * A mentett válasz visszaolvasása: csak a kérő user saját, ugyanannál a munkatársnál mentett, még élő
 * válasza. Más user, másik munkatárs (más connector-jogok!) vagy egy kész fájl azonosítója: `null`.
 */
export async function loadOwnSavedResult(
  store: DocumentExportStore,
  input: { tenantId: string; userId: string; agentId: string; id: string; now: Date },
): Promise<{ fileName: string; data: Buffer } | null> {
  const found = await loadOwnExport(store, { tenantId: input.tenantId, userId: input.userId, exportId: input.id, now: input.now })
  if (!found || found.agentId !== input.agentId || found.format !== SAVED_RESULT_FORMAT) return null
  return { fileName: found.fileName, data: found.data }
}
