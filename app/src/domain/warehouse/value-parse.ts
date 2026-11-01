/**
 * Adattárház (#984 R6) — magyar Excel-valóság: tizedesvessző, szóközös ezres
 * tagolás, `2026.10.22.` dátum, Ft/HUF, igen/nem. Tiszta függvények, a profilozó
 * és a betöltő ugyanezt használja, így az előnézet és a betöltés nem térhet el.
 */

export type WarehouseFieldType = 'text' | 'integer' | 'decimal' | 'date' | 'boolean'

export const WAREHOUSE_FIELD_TYPES: readonly WarehouseFieldType[] = ['text', 'integer', 'decimal', 'date', 'boolean']

/** Egy Excel-cella normalizált értéke: a képlet eredménye, rich text szövege stb. */
export type RawCell = string | number | boolean | Date | null

const CURRENCY_TOKENS: Array<[RegExp, string]> = [
  [/\bHUF\b/i, 'HUF'],
  [/\bFt\.?(?=$|\s)/i, 'HUF'],
  [/\bEUR\b|€/i, 'EUR'],
  [/\bUSD\b|\$/i, 'USD'],
]

// Szóköz, nem törhető szóköz, keskeny szóköz, aposztróf (ezres tagolók).
const GROUP_SPACES = /[\s   ']/g

export type ParsedNumber = { value: number; currency: string | null; percent: boolean }

/** Magyar és nemzetközi számalak; `null`, ha nem szám. */
export function parseHuNumber(input: string): ParsedNumber | null {
  let s = input.trim()
  if (!s || s.length > 64) return null
  let currency: string | null = null
  for (const [re, code] of CURRENCY_TOKENS) {
    if (re.test(s)) {
      currency = code
      s = s.replace(re, '')
    }
  }
  let percent = false
  if (s.endsWith('%')) {
    percent = true
    s = s.slice(0, -1)
  }
  s = s.replace(GROUP_SPACES, '')
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  if (s.startsWith('-') || s.startsWith('−')) {
    negative = !negative
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null
  const commas = (s.match(/,/g) ?? []).length
  const dots = (s.match(/\./g) ?? []).length
  let normalized: string
  if (commas > 0 && dots > 0) {
    // Az utolsó elválasztó a tizedesjel, a másik ezres tagoló.
    const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.'
    const group = decimal === ',' ? '.' : ','
    if ((s.match(new RegExp(`\\${decimal}`, 'g')) ?? []).length > 1) return null
    normalized = s.split(group).join('').replace(decimal, '.')
  } else if (commas > 1) {
    if (!/^\d{1,3}(,\d{3})+$/.test(s)) return null
    normalized = s.replace(/,/g, '')
  } else if (dots > 1) {
    if (!/^\d{1,3}(\.\d{3})+$/.test(s)) return null
    normalized = s.replace(/\./g, '')
  } else {
    // Egyetlen vessző: magyar tizedesvessző. Egyetlen pont: tizedespont.
    normalized = s.replace(',', '.')
  }
  if (normalized.startsWith('.') || normalized.endsWith('.')) return null
  const value = Number(normalized)
  if (!Number.isFinite(value)) return null
  return { value: negative ? -value : value, currency, percent }
}

const HU_MONTHS: Record<string, number> = {
  január: 1, jan: 1, február: 2, feb: 2, febr: 2, március: 3, márc: 3, már: 3, április: 4, ápr: 4,
  május: 5, máj: 5, június: 6, jún: 6, július: 7, júl: 7, augusztus: 8, aug: 8, szeptember: 9, szept: 9,
  szep: 9, október: 10, okt: 10, november: 11, nov: 11, december: 12, dec: 12,
}

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return date.toISOString().slice(0, 10)
}

/** `2026.10.22.`, `2026. 10. 22.`, `2026-10-22`, `2026/10/22`, `22.10.2026`, `2026. október 22.` → ISO. */
export function parseHuDate(input: string): string | null {
  const s = input.trim().toLowerCase()
  if (!s || s.length > 40) return null
  let m = /^(\d{4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})\.?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s)
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /^(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{4})\.?$/.exec(s)
  if (m) return isoDate(Number(m[3]), Number(m[2]), Number(m[1]))
  m = /^(\d{4})\.?\s+([a-záéíóöőúüű]+)\.?\s+(\d{1,2})\.?$/.exec(s)
  if (m && HU_MONTHS[m[2]!]) return isoDate(Number(m[1]), HU_MONTHS[m[2]!]!, Number(m[3]))
  return null
}

export function dateToIso(date: Date): string | null {
  if (Number.isNaN(date.getTime())) return null
  // Az exceljs a cellás dátumot UTC-éjfélként adja.
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

const TRUE_WORDS = new Set(['igen', 'i', 'true', 'yes', 'y', 'x', 'van', 'aktív', 'igaz'])
const FALSE_WORDS = new Set(['nem', 'n', 'false', 'no', 'nincs', 'inaktív', 'hamis'])

export function parseHuBoolean(input: string): boolean | null {
  const s = input.trim().toLowerCase()
  if (TRUE_WORDS.has(s)) return true
  if (FALSE_WORDS.has(s)) return false
  return null
}

export function isEmptyCell(value: RawCell): boolean {
  return value === null || (typeof value === 'string' && value.trim() === '')
}

export function cellText(value: RawCell): string {
  if (value === null) return ''
  if (value instanceof Date) return dateToIso(value) ?? ''
  return String(value).trim()
}

export type ConvertResult = { ok: true; value: string | number | boolean | null } | { ok: false; reason: string }

/** Egy cella átalakítása a terv szerinti céltípusra (betöltéskor és előnézetkor). */
export function convertCell(value: RawCell, type: WarehouseFieldType): ConvertResult {
  if (isEmptyCell(value)) return { ok: true, value: null }
  switch (type) {
    case 'text':
      return { ok: true, value: cellText(value) }
    case 'integer':
    case 'decimal': {
      let n: number | null = null
      if (typeof value === 'number') n = value
      else if (typeof value === 'string') n = parseHuNumber(value)?.value ?? null
      if (n === null || !Number.isFinite(n)) return { ok: false, reason: 'not_a_number' }
      if (type === 'integer') {
        if (!Number.isInteger(n)) return { ok: false, reason: 'not_an_integer' }
        if (!Number.isSafeInteger(n)) return { ok: false, reason: 'number_too_large' }
      }
      return { ok: true, value: n }
    }
    case 'date': {
      let iso: string | null = null
      if (value instanceof Date) iso = dateToIso(value)
      else if (typeof value === 'string') iso = parseHuDate(value)
      return iso ? { ok: true, value: iso } : { ok: false, reason: 'not_a_date' }
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value }
      if (typeof value === 'number' && (value === 0 || value === 1)) return { ok: true, value: value === 1 }
      const b = typeof value === 'string' ? parseHuBoolean(value) : null
      return b === null ? { ok: false, reason: 'not_a_boolean' } : { ok: true, value: b }
    }
  }
}

/** A profilozó típus-tippje egy nem üres cellára. */
export function guessCellType(value: RawCell): WarehouseFieldType {
  if (typeof value === 'boolean') return 'boolean'
  if (value instanceof Date) return 'date'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'decimal'
  const s = String(value)
  if (parseHuDate(s)) return 'date'
  const n = parseHuNumber(s)
  if (n) {
    // Vezető nulla (irányítószám, cikkszám) szöveg marad.
    if (/^\s*0\d/.test(s)) return 'text'
    return Number.isInteger(n.value) ? 'integer' : 'decimal'
  }
  if (parseHuBoolean(s) !== null && s.trim().length > 1) return 'boolean'
  return 'text'
}

/** Név-normalizálás az egyszerű egyezéshez (R1): kis-/nagybetű, szóközök. */
export function normalizeName(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '')
}

const LEGAL_FORMS =
  /\b(kft|bt|zrt|nyrt|rt|kkt|kht|ev|e\.v|egyéni vállalkozó|nonprofit|ltd|gmbh|llc|inc|kg|ag|sro|s\.r\.o)\b\.?/g

/** Cégforma és írásjelek nélkül — csak *javaslathoz*, sosem automatikus kapcsolathoz. */
export function nameWithoutLegalForm(input: string): string {
  return normalizeName(input)
    .replace(/[.,;:()"'„”]/g, ' ')
    .replace(LEGAL_FORMS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
