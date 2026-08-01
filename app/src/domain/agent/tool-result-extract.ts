/**
 * Nagy tool-eredmény mező-kivonatolása a kontextus megkerülésével (issue #179).
 *
 * A modell egy archívumból mezőlistát kér, a szerver a kivonatot fájlba írja, és
 * a modellnek csak a sorok számát + néhány mintasort adja vissza. Így egy
 * 250 KB-os API-válasz feldolgozható anélkül, hogy a teljes tartalom a
 * promptba kerülne.
 */
import { unwrapExternalDataEnvelope } from '@/domain/tool-broker/tool-result-envelope'

export const TOOL_RESULT_EXTRACT_TOOL_NAME = 'tool_result_extract'

const SAMPLE_ROW_LIMIT = 3

export type ExtractToolResultInput = {
  fields: string[]
  /** Pontos útvonal a JSON-ban a rekordtömbhöz (pl. `data.customers`). */
  arrayPath?: string
}

export type ExtractToolResultSuccess = {
  ok: true
  rows: Record<string, unknown>[]
  rowCount: number
}

export type ExtractToolResultFailure = {
  ok: false
  error: string
}

export type ExtractToolResultOutcome = ExtractToolResultSuccess | ExtractToolResultFailure

/**
 * Envelope / prose burkolat levétele, majd JSON parse (tömb VAGY objektum).
 * Az `extractJsonObject` csak `{…}`-et keres — az API-válaszok gyakran `[…]`.
 */
export function parseToolResultJson(content: string): unknown {
  const unwrapped = unwrapExternalDataEnvelope(content).trim()
  if (!unwrapped) return null

  try {
    return JSON.parse(unwrapped)
  } catch {
    // burkolt / fence-elt / prózás tartalom: az első JSON érték egyensúlyozóval
  }

  const fenced = unwrapped.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : unwrapped).trim()
  const startObj = candidate.indexOf('{')
  const startArr = candidate.indexOf('[')
  let start = -1
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) start = startObj
  else if (startArr >= 0) start = startArr
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function valueAtPath(root: unknown, path: string): unknown {
  if (!path) return root
  let cur: unknown = root
  for (const part of path.split('.').filter(Boolean)) {
    if (cur == null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function pickFields(row: unknown, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (row == null || typeof row !== 'object' || Array.isArray(row)) {
    for (const field of fields) out[field] = null
    return out
  }
  const record = row as Record<string, unknown>
  for (const field of fields) {
    out[field] = field.includes('.') ? valueAtPath(record, field) : record[field] ?? null
  }
  return out
}

function findRecordArray(root: unknown, arrayPath?: string): unknown[] | null {
  if (arrayPath) {
    const at = valueAtPath(root, arrayPath)
    return Array.isArray(at) ? at : null
  }
  if (Array.isArray(root)) return root
  if (root && typeof root === 'object') {
    // Gyakori burkolók — arrayPath nélkül is megtaláljuk a rekordtömböt.
    for (const key of ['data', 'items', 'results', 'records', 'rows', 'ownerships']) {
      const value = (root as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value
    }
    // Egyetlen tömb-érték az objektumban
    const arrays = Object.values(root as Record<string, unknown>).filter(Array.isArray)
    if (arrays.length === 1) return arrays[0] as unknown[]
  }
  return null
}

/** Hibaszöveghez: top-level kulcsok + melyik tömbök találhatók. */
export function describeJsonShapeHints(parsed: unknown): string {
  if (Array.isArray(parsed)) return 'a gyökér tömb (arrayPath nem kell)'
  if (!parsed || typeof parsed !== 'object') return 'nem objektum/tömb'
  const entries = Object.entries(parsed as Record<string, unknown>)
  const keys = entries.map(([k]) => k).slice(0, 12)
  const arrayKeys = entries
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => `${k}[${(v as unknown[]).length}]`)
    .slice(0, 8)
  const parts = [`top-level kulcsok: ${keys.join(', ') || '(üres)'}`]
  if (arrayKeys.length > 0) {
    parts.push(`tömbök: ${arrayKeys.join(', ')} — arrayPath-nak ezek egyikét add meg`)
  } else {
    parts.push('nincs top-level tömb; nestelt tömbhöz add meg a pontos arrayPath-ot (pl. data.items)')
  }
  return parts.join('; ')
}

/** Mezőlista szerinti kivonat — tiszta függvény, I/O nélkül. */
export function extractToolResultRows(
  content: string,
  input: ExtractToolResultInput,
): ExtractToolResultOutcome {
  const fields = input.fields.map((f) => f.trim()).filter(Boolean)
  if (fields.length === 0) {
    return { ok: false, error: 'legalább egy mező kell a fields listában' }
  }

  const parsed = parseToolResultJson(content)
  if (parsed == null) {
    return { ok: false, error: 'a forrás tartalma nem érvényes JSON' }
  }

  const array = findRecordArray(parsed, input.arrayPath)
  if (!array) {
    const hints = describeJsonShapeHints(parsed)
    return {
      ok: false,
      error: input.arrayPath
        ? `nem található tömb a(z) "${input.arrayPath}" útvonalon (${hints})`
        : `nem található rekordtömb a JSON-ban — add meg az arrayPath-ot (${hints})`,
    }
  }

  const rows = array.map((row) => pickFields(row, fields))
  return { ok: true, rows, rowCount: rows.length }
}

/** A modellnek visszatérő rövid összefoglaló — acceptance: < 2000 karakter. */
export function buildExtractSummary(input: {
  outputPath: string
  fields: string[]
  rowCount: number
  sampleRows: Record<string, unknown>[]
  bytes: number
}): string {
  const samples = input.sampleRows.slice(0, SAMPLE_ROW_LIMIT)
  return [
    `Kivonat kész: ${input.rowCount} sor → ${input.outputPath} (${input.bytes} bájt).`,
    `Mezők: ${input.fields.join(', ')}.`,
    `Mintasorok (${samples.length}/${input.rowCount}):`,
    JSON.stringify(samples, null, 2),
    'A teljes kivonat a munkaterületen van — NE olvasd vissza az eredeti forrást chunkolt file_read-del.',
    'Tovább: reconcile_records / tulajdoni_lap_egyeztetes / xlsx_append_rows a kimeneti fájlból.',
  ].join('\n')
}

/**
 * Nagy tool-eredmény előnézete: a teljes tartalom a munkaterületen van, a
 * továbbdolgozás fájl-alapú (extract / file_write), NEM visszaolvasás.
 */
export function formatLargeToolResultPreview(input: {
  archivePath: string
  workspacePath: string
  chars: number
  bytes: number
  previewText: string
}): string {
  // Az első „elmentve:" útvonal a rendszer-archívum — a tömörítés pointere erre épül.
  // A hétköznapi workspacePath a modellnek szóló elsődleges feldolgozási cél.
  const shapeHint = arrayPathHintFromPreview(input.previewText)
  return [
    `[Nagy tool-eredmény] A teljes eredmény elmentve: ${input.archivePath}`,
    `Munkaterületi másolat (ezt használd tovább): ${input.workspacePath}`,
    `Méret: ${input.chars} karakter, ${input.bytes} bájt. Az alábbi csak előnézet.`,
    `NE olvasd vissza a teljes tartalmat a kontextusba (ne file_read chunkolás). A további feldolgozáshoz:`,
    `0) ha ez ownerships/névsor és http_api_get (NEM get_all) volt: ELŐBB http_api_get_all ugyanezzel a path-dal — egyetlen oldal (pl. 50 sor) extractje csonka egyeztetést ad;`,
    `1) tulajdoni_lap_egyeztetes / reconcile_records: ha a forrás http_api_get_all archívum, add át közvetlenül nyilvantartasPath/leftPath-ként (extract nem kell);`,
    `2) tool_result_extract — path="${input.archivePath}" VAGY path="${input.workspacePath}", fields=[…], outputPath="…" — csak ha más a mezőalak;`,
    shapeHint
      ? `   arrayPath tipp: ${shapeHint}`
      : '   ha a gyökér nem tömb: add meg az arrayPath-ot (pl. data / items / body.data)',
    `3) két lista egyeztetéséhez: reconcile_records (vagy tulajdoni_lap_egyeztetes) — NE párosíts a modellben;`,
    'A teljes lista / pontos számítás a munkaterületi fájlból készüljön, ne a promptból.',
    '--- előnézet ---',
    input.previewText,
    '--- előnézet vége ---',
  ].join('\n')
}

/** Preview JSON-ból rövid arrayPath tipp (extract elsőre sikerüljön). */
function arrayPathHintFromPreview(previewText: string): string | null {
  const parsed = tryParsePreviewJson(previewText)
  if (parsed !== undefined) return firstArrayPath(parsed)

  // Csonka előnézet (TOOL_RESULT_PREVIEW_CHARS): parse nélkül, gyakori `"key":[` minták.
  const preferred = ['data', 'items', 'results', 'records', 'rows', 'ownerships']
  const bodyIdx = previewText.indexOf('"body"')
  for (const key of preferred) {
    const keyIdx = previewText.indexOf(`"${key}":[`)
    if (keyIdx < 0) continue
    if (bodyIdx >= 0 && keyIdx > bodyIdx) return `body.${key}`
    return key
  }
  if (previewText.includes('"body":[')) return 'body'
  return null
}

function tryParsePreviewJson(previewText: string): unknown | undefined {
  try {
    return JSON.parse(previewText) as unknown
  } catch {
    return undefined
  }
}

/** Struktúra-járás — nem a humán hint-string regexelése. */
function firstArrayPath(value: unknown, prefix = ''): string | null {
  if (Array.isArray(value)) return prefix || '(gyökér tömb — arrayPath nem kell)'
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const preferred = ['data', 'items', 'results', 'records', 'rows', 'ownerships', 'body']
  for (const key of preferred) {
    if (!(key in obj)) continue
    const path = prefix ? `${prefix}.${key}` : key
    const found = firstArrayPath(obj[key], path)
    if (found) return found
  }
  for (const [key, child] of Object.entries(obj)) {
    if (preferred.includes(key)) continue
    if (Array.isArray(child)) return prefix ? `${prefix}.${key}` : key
  }
  return null
}

/** Hétköznapi (látható) másolat útvonala az archívum basename-jéből. */
export function workspaceCopyPathForArchive(archivePath: string): string {
  const base = archivePath.split('/').pop() || 'tool-result.json'
  return `tool-outputs/${base}`
}
