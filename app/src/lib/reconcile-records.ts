/**
 * Általános rekord-egyeztetés (issue #179 WP-2).
 *
 * Két lista uniója kulcsmezők + összehasonlítási szabályok alapján. A párosítás
 * determinisztikus: a modell dolga a bizonytalan találatok eldöntése és a
 * szöveges összefoglaló — a gépi rész itt fut.
 */

export type ReconcileNormalize = 'trim' | 'lower' | 'hu-name' | 'year'

export type ReconcileCompareField = {
  field: string
  mode?: 'exact' | 'number' | 'fraction'
  /** Abszolút tűrés `number` módnál. Alap: 0. */
  epsilon?: number
}

export type ReconcileStatus =
  | 'Rendben'
  | 'Módosítás szükséges'
  | 'Új rekord'
  | 'Törlés szükséges'

export type ReconcileMatchStrength = 'full' | 'partial' | 'none'

export type ReconcileRecordsInput = {
  left: Record<string, unknown>[]
  right: Record<string, unknown>[]
  /** Azonosító mezők. Ha mindkét oldalon megvan és eltér → nem pár. */
  keyFields: string[]
  /** Mezőnkénti normalizálás a kulcs-összehasonlításhoz. */
  normalize?: Record<string, ReconcileNormalize>
  /** Párosítás után összevetendő mezők (eltérés → „Módosítás szükséges"). */
  compareFields?: ReconcileCompareField[]
}

export type ReconcileRow = {
  status: ReconcileStatus
  matchStrength: ReconcileMatchStrength
  left: Record<string, unknown> | null
  right: Record<string, unknown> | null
  differences: string[]
  note: string
}

export type ReconcileUncertain = {
  leftIndex: number
  rightIndex: number
  note: string
  left: Record<string, unknown>
  right: Record<string, unknown>
}

export type ReconcileSummary = {
  total: number
  rendben: number
  modositas: number
  ujRekord: number
  torles: number
  uncertain: number
}

export type ReconcileRecordsResult = {
  rows: ReconcileRow[]
  summary: ReconcileSummary
  uncertain: ReconcileUncertain[]
}

const FRACTION_RE = /^\s*(\d+)\s*\/\s*(\d+)\s*$/

export function normalizeReconcileValue(
  value: unknown,
  mode: ReconcileNormalize = 'trim',
): string | null {
  if (value == null) return null
  const text = String(value).trim()
  if (!text) return null
  switch (mode) {
    case 'lower':
      return text.toLowerCase()
    case 'hu-name':
      return text.toLocaleLowerCase('hu-HU').replace(/\s+/g, ' ').trim()
    case 'year': {
      const match = /(\d{4})/.exec(text)
      return match ? match[1] : null
    }
    case 'trim':
    default:
      return text
  }
}

function parseFraction(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const match = FRACTION_RE.exec(String(value))
  if (!match) return null
  const den = Number(match[2])
  if (!den) return null
  return Number(match[1]) / den
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value == null) return null
  const n = Number(String(value).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function fieldNormalize(
  field: string,
  normalize: Record<string, ReconcileNormalize> | undefined,
): ReconcileNormalize {
  return normalize?.[field] ?? 'trim'
}

/**
 * Kulcs-egyezés erőssége (a tulajdoni-lap párosítás általánosítása):
 * - none  — nincs közös, egyező kulcs; VAGY van konfliktus (mindkét oldalon megvan, de eltér)
 * - full  — minden kulcsmező mindkét oldalon megvan és egyezik
 * - partial — van legalább egy egyező kulcs, nincs konfliktus, de valamelyik kulcs hiányzik
 */
export function keyMatchStrength(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  keyFields: string[],
  normalize?: Record<string, ReconcileNormalize>,
): ReconcileMatchStrength {
  if (keyFields.length === 0) return 'none'

  let compared = 0
  let matched = 0
  for (const field of keyFields) {
    const mode = fieldNormalize(field, normalize)
    const lv = normalizeReconcileValue(left[field], mode)
    const rv = normalizeReconcileValue(right[field], mode)
    if (lv && rv) {
      compared += 1
      if (lv !== rv) return 'none'
      matched += 1
    }
  }
  if (matched === 0) return 'none'
  if (compared === keyFields.length && matched === keyFields.length) return 'full'
  return 'partial'
}

function compareFieldValues(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  spec: ReconcileCompareField,
): string | null {
  const mode = spec.mode ?? 'exact'
  const field = spec.field
  const lv = left[field]
  const rv = right[field]
  if (lv == null || lv === '' || rv == null || rv === '') return null

  if (mode === 'fraction') {
    const la = parseFraction(lv)
    const ra = parseFraction(rv)
    if (la == null || ra == null) {
      if (String(lv).trim() !== String(rv).trim()) return `${field}: ${String(lv)} ≠ ${String(rv)}`
      return null
    }
    const eps = spec.epsilon ?? 1e-9
    if (Math.abs(la - ra) > eps) return `${field}: ${String(lv)} ≠ ${String(rv)}`
    return null
  }

  if (mode === 'number') {
    const ln = parseNumber(lv)
    const rn = parseNumber(rv)
    if (ln == null || rn == null) {
      if (String(lv).trim() !== String(rv).trim()) return `${field}: ${String(lv)} ≠ ${String(rv)}`
      return null
    }
    const eps = spec.epsilon ?? 0
    if (Math.abs(ln - rn) > eps) return `${field}: ${String(lv)} ≠ ${String(rv)}`
    return null
  }

  if (String(lv).trim() !== String(rv).trim()) return `${field}: ${String(lv)} ≠ ${String(rv)}`
  return null
}

/** Két lista uniója státuszokkal. */
export function reconcileRecords(input: ReconcileRecordsInput): ReconcileRecordsResult {
  const keyFields = input.keyFields.map((f) => f.trim()).filter(Boolean)
  const compareFields = input.compareFields ?? []
  const usedRight = new Set<number>()
  const rows: ReconcileRow[] = []
  const uncertain: ReconcileUncertain[] = []

  for (let li = 0; li < input.left.length; li++) {
    const left = input.left[li]
    const candidates = input.right
      .map((right, index) => ({
        right,
        index,
        strength: keyMatchStrength(left, right, keyFields, input.normalize),
      }))
      .filter((c) => c.strength !== 'none' && !usedRight.has(c.index))

    const full = candidates.find((c) => c.strength === 'full')
    const pick = full ?? candidates[0]

    if (!pick) {
      rows.push({
        status: 'Új rekord',
        matchStrength: 'none',
        left,
        right: null,
        differences: [],
        note: 'Csak a bal oldalon szerepel.',
      })
      continue
    }

    usedRight.add(pick.index)
    const differences = compareFields
      .map((spec) => compareFieldValues(left, pick.right, spec))
      .filter((d): d is string => Boolean(d))

    const notes: string[] = []
    if (pick.strength === 'partial') {
      notes.push(
        'A párosítás részleges kulcson alapul (hiányzó azonosító mező) — emberi ellenőrzés kell.',
      )
      uncertain.push({
        leftIndex: li,
        rightIndex: pick.index,
        note: notes[0],
        left,
        right: pick.right,
      })
    }
    if (differences.length > 0) {
      notes.push(`Eltérő mezők: ${differences.join('; ')}`)
    }

    rows.push({
      status: differences.length > 0 ? 'Módosítás szükséges' : 'Rendben',
      matchStrength: pick.strength,
      left,
      right: pick.right,
      differences,
      note: notes.join(' '),
    })
  }

  for (let ri = 0; ri < input.right.length; ri++) {
    if (usedRight.has(ri)) continue
    rows.push({
      status: 'Törlés szükséges',
      matchStrength: 'none',
      left: null,
      right: input.right[ri],
      differences: [],
      note: 'Csak a jobb oldalon szerepel.',
    })
  }

  const summary: ReconcileSummary = {
    total: rows.length,
    rendben: rows.filter((r) => r.status === 'Rendben').length,
    modositas: rows.filter((r) => r.status === 'Módosítás szükséges').length,
    ujRekord: rows.filter((r) => r.status === 'Új rekord').length,
    torles: rows.filter((r) => r.status === 'Törlés szükséges').length,
    uncertain: uncertain.length,
  }

  return { rows, summary, uncertain }
}

/** A modellnek visszatérő tömör összefoglaló — a teljes lista a fájlban van. */
export function buildReconcileSummaryForModel(
  result: ReconcileRecordsResult,
  opts: { outputPath: string; maxUncertain?: number; identityFields?: string[] },
): string {
  const maxU = opts.maxUncertain ?? 8
  const idFields = opts.identityFields

  const pickIdentity = (row: Record<string, unknown> | null) => {
    if (!row) return null
    if (!idFields || idFields.length === 0) {
      // Legfeljebb 4 mező — ne hízlalja a promptot.
      return Object.fromEntries(Object.entries(row).slice(0, 4))
    }
    const out: Record<string, unknown> = {}
    for (const field of idFields) {
      if (field in row) out[field] = row[field]
    }
    return out
  }

  const uncertainSample = result.uncertain.slice(0, maxU).map((u) => ({
    note: u.note,
    left: pickIdentity(u.left),
    right: pickIdentity(u.right),
  }))
  const differing = result.rows
    .filter((r) => r.status !== 'Rendben')
    .slice(0, 12)
    .map((r) => ({
      status: r.status,
      differences: r.differences,
      left: pickIdentity(r.left),
      right: pickIdentity(r.right),
    }))

  return [
    `Egyeztetés kész → ${opts.outputPath}`,
    `Összesítés: ${result.summary.total} sor — Rendben ${result.summary.rendben}, Módosítás ${result.summary.modositas}, Új ${result.summary.ujRekord}, Törlés ${result.summary.torles}, Bizonytalan párosítás ${result.summary.uncertain}.`,
    'A teljes egyesített lista a munkaterületen van; NE olvasd vissza egészben a kontextusba.',
    result.summary.uncertain > 0
      ? `Bizonytalan párok (első ${uncertainSample.length}/${result.summary.uncertain}) — ezeket emberi döntésre jelezd:\n${JSON.stringify(uncertainSample)}`
      : 'Nincs bizonytalan párosítás.',
    differing.length > 0
      ? `Eltérő / egyoldali minták (max 12):\n${JSON.stringify(differing)}`
      : 'Nincs eltérő sor.',
  ].join('\n')
}

/** Workspace JSON: tömb, vagy { rows|sorok|items|data|records: [...] }. */
export function parseReconcileRecordList(parsed: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(parsed)) {
    return parsed.filter((row): row is Record<string, unknown> =>
      Boolean(row) && typeof row === 'object' && !Array.isArray(row),
    )
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  for (const key of ['rows', 'sorok', 'items', 'data', 'records']) {
    const value = obj[key]
    if (Array.isArray(value)) {
      return value.filter((row): row is Record<string, unknown> =>
        Boolean(row) && typeof row === 'object' && !Array.isArray(row),
      )
    }
  }
  return null
}
