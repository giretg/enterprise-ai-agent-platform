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
  /** Párosítási verseny — volt jelölt, de másik sor vitte el; nem „új beszúrás”. */
  | 'Ellenőrzés szükséges'

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
  ellenorzes: number
  uncertain: number
}

export type ReconcileRecordsResult = {
  rows: ReconcileRow[]
  summary: ReconcileSummary
  uncertain: ReconcileUncertain[]
}

const FRACTION_RE = /^\s*(\d+)\s*\/\s*(\d+)\s*$/

/**
 * Túl nagy bemenet elleni védelem. A párosítás természeténél fogva
 * O(bal × jobb): egy nagyon nagy két lista (pl. tízezer × tízezer) másodpercekre–
 * percekre BEFAGYASZTANÁ a feldolgozó szálat (event loop), amivel MINDEN más
 * párhuzamos agent-forduló is elakadna ugyanazon a példányon. Inkább gyorsan,
 * érthető és actionable hibával állunk le, mint hogy a worker némán megbénuljon.
 */
export const MAX_RECONCILE_ROWS_PER_SIDE = 20_000
export const MAX_RECONCILE_PAIRS = 4_000_000

export function assertReconcileSizeWithinLimit(leftCount: number, rightCount: number): void {
  if (leftCount > MAX_RECONCILE_ROWS_PER_SIDE || rightCount > MAX_RECONCILE_ROWS_PER_SIDE) {
    throw new Error(
      `reconcile_records: túl sok sor (bal ${leftCount}, jobb ${rightCount}; oldalankénti felső határ ${MAX_RECONCILE_ROWS_PER_SIDE}). ` +
        'Szűkítsd előbb a listákat (pl. szűrés kulcsmezőre vagy időszakra), vagy darabold több, kisebb egyeztetésre.',
    )
  }
  if (leftCount * rightCount > MAX_RECONCILE_PAIRS) {
    throw new Error(
      `reconcile_records: az összevetés túl nagy (bal ${leftCount} × jobb ${rightCount} = ${leftCount * rightCount} pár; felső határ ${MAX_RECONCILE_PAIRS}). ` +
        'Adj meg szűkebb kulcsmezőt, vagy darabold a listát egyértelmű csoportokra (pl. kezdőbetű/időszak szerint), és egyeztesd csoportonként.',
    )
  }
}

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

type ReconcileCandidate = { index: number; strength: Exclude<ReconcileMatchStrength, 'none'> }

/** A versenyben elvesztett bal sorhoz a ténylegesen lefoglalt (preferáltan full) jelölt. */
function pickContestedCandidate(
  leftCandidates: ReconcileCandidate[],
  assignment: Map<number, number>,
): ReconcileCandidate | undefined {
  const assignedRights = new Set(assignment.values())
  const taken = leftCandidates.filter((c) => assignedRights.has(c.index))
  // Ha nincs lefoglalt jelölt, ne találgassunk (pl. candidates[0]) — az uncertain
  // pointer a PR fix-spec szerint a ténylegesen lefoglalt jobb sorra kell mutasson.
  if (taken.length === 0) return undefined
  return taken.find((c) => c.strength === 'full') ?? taken[0]
}

/** Két lista uniója státuszokkal. */
export function reconcileRecords(input: ReconcileRecordsInput): ReconcileRecordsResult {
  const keyFields = input.keyFields.map((f) => f.trim()).filter(Boolean)
  const compareFields = input.compareFields ?? []
  assertReconcileSizeWithinLimit(input.left.length, input.right.length)

  // Jelöltek előszámítása egyszer: bal soronként az egyező jobb sorok + erősség.
  const candidates: ReconcileCandidate[][] = input.left.map((left) => {
    const row: ReconcileCandidate[] = []
    for (let ri = 0; ri < input.right.length; ri++) {
      const strength = keyMatchStrength(left, input.right[ri], keyFields, input.normalize)
      if (strength !== 'none') row.push({ index: ri, strength })
    }
    return row
  })

  const usedRight = new Set<number>()
  const assignment = new Map<number, number>()

  // 1. kör — a TELJES (full) egyezés globálisan előbbre való: egy későbbi bal sor
  // pontos párját SOSEM viheti el egy korábbi bal sor részleges (partial) találata.
  // (Enélkül egy valódi, minden kulcson egyező pár némán „Új rekordként" tűnt el.)
  for (let li = 0; li < candidates.length; li++) {
    const full = candidates[li].find((c) => c.strength === 'full' && !usedRight.has(c.index))
    if (full) {
      usedRight.add(full.index)
      assignment.set(li, full.index)
    }
  }
  // 2. kör — a maradék bal sorok a még szabad (részleges vagy full) párt kapják.
  for (let li = 0; li < candidates.length; li++) {
    if (assignment.has(li)) continue
    const pick = candidates[li].find((c) => !usedRight.has(c.index))
    if (pick) {
      usedRight.add(pick.index)
      assignment.set(li, pick.index)
    }
  }

  const rows: ReconcileRow[] = []
  const uncertain: ReconcileUncertain[] = []

  for (let li = 0; li < input.left.length; li++) {
    const left = input.left[li]
    const rightIndex = assignment.get(li)

    if (rightIndex === undefined) {
      // Ha VOLT lehetséges párja, de azt egy másik, hasonló bal sorhoz rendeltük
      // (verseny több hasonló rekordért), ezt NE némán „Új rekord"-ként könyveljük —
      // külön státusz + uncertain, a ténylegesen lefoglalt jobb sorra mutatva.
      const contested = pickContestedCandidate(candidates[li], assignment)
      if (contested) {
        const note =
          'Lehetséges párja már egy másik, hasonló sorhoz lett rendelve — emberi ellenőrzés kell.'
        const right = input.right[contested.index]
        rows.push({
          status: 'Ellenőrzés szükséges',
          matchStrength: contested.strength,
          left,
          right,
          differences: [],
          note,
        })
        uncertain.push({
          leftIndex: li,
          rightIndex: contested.index,
          note,
          left,
          right,
        })
      } else {
        rows.push({
          status: 'Új rekord',
          matchStrength: 'none',
          left,
          right: null,
          differences: [],
          note: 'Csak a bal oldalon szerepel.',
        })
      }
      continue
    }

    const right = input.right[rightIndex]
    const strength = candidates[li].find((c) => c.index === rightIndex)?.strength ?? 'partial'
    const differences = compareFields
      .map((spec) => compareFieldValues(left, right, spec))
      .filter((d): d is string => Boolean(d))

    const notes: string[] = []
    if (strength === 'partial') {
      notes.push(
        'A párosítás részleges kulcson alapul (hiányzó azonosító mező) — emberi ellenőrzés kell.',
      )
      uncertain.push({ leftIndex: li, rightIndex, note: notes[0], left, right })
    }
    if (differences.length > 0) {
      notes.push(`Eltérő mezők: ${differences.join('; ')}`)
    }

    rows.push({
      status: differences.length > 0 ? 'Módosítás szükséges' : 'Rendben',
      matchStrength: strength,
      left,
      right,
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
    ellenorzes: rows.filter((r) => r.status === 'Ellenőrzés szükséges').length,
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
    `Összesítés: ${result.summary.total} sor — Rendben ${result.summary.rendben}, Módosítás ${result.summary.modositas}, Új ${result.summary.ujRekord}, Törlés ${result.summary.torles}, Ellenőrzés ${result.summary.ellenorzes}, Bizonytalan párosítás ${result.summary.uncertain}.`,
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
