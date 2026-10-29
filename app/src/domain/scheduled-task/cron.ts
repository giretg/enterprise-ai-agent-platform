/**
 * #640 D9: az ütemezett feladat 5 mezős cronját mindig a szerver értelmezi, a feladat
 * időzónájában. A harness órája nem számít — a slotot (`run_start`) is innen számoljuk.
 *
 * Napi léptetés a helyi naptárban: csak az illeszkedő napokon kell időzóna-átváltás,
 * így a „következő / előző időpont” évekre előre is olcsó (pl. február 29.).
 */

export type CronSpec = {
  minutes: number[]
  hours: number[]
  doms: number[]
  months: number[]
  dows: number[]
  domRestricted: boolean
  dowRestricted: boolean
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const SEARCH_DAYS = 366 * 5
const MINUTE = 60_000

function parseValue(raw: string, names: string[] | null, offset: number): number | null {
  if (/^\d{1,2}$/.test(raw)) return Number(raw)
  const index = names?.indexOf(raw.toUpperCase()) ?? -1
  return index >= 0 ? index + offset : null
}

function parseField(field: string, min: number, max: number, names: string[] | null = null, nameOffset = 0): number[] | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const match = /^([^/]+)(?:\/(\d{1,2}))?$/.exec(part)
    if (!match) return null
    const step = match[2] === undefined ? 1 : Number(match[2])
    if (step < 1) return null
    let from: number
    let to: number
    if (match[1] === '*') {
      from = min
      to = max
    } else {
      const [startRaw, endRaw, ...rest] = match[1].split('-')
      if (rest.length) return null
      const start = parseValue(startRaw, names, nameOffset)
      const end = endRaw === undefined ? (match[2] === undefined ? start : max) : parseValue(endRaw, names, nameOffset)
      if (start === null || end === null || start > end) return null
      from = start
      to = end
    }
    if (from < min || to > max) return null
    for (let value = from; value <= to; value += step) values.add(value)
  }
  return [...values].sort((a, b) => a - b)
}

export function parseCron(expr: string): CronSpec | null {
  if (typeof expr !== 'string' || expr.length > 200) return null
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minutes = parseField(fields[0], 0, 59)
  const hours = parseField(fields[1], 0, 23)
  const doms = parseField(fields[2], 1, 31)
  const months = parseField(fields[3], 1, 12, MONTH_NAMES, 1)
  const rawDows = parseField(fields[4], 0, 7, DOW_NAMES, 0)
  if (!minutes || !hours || !doms || !months || !rawDows) return null
  const dows = [...new Set(rawDows.map((day) => day % 7))].sort((a, b) => a - b)
  return {
    minutes,
    hours,
    doms,
    months,
    dows,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  }
}

export function normalizeCron(expr: string): string {
  return expr.trim().split(/\s+/).join(' ')
}

export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || !/^[A-Za-z]/.test(timezone) || timezone.length > 100) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timezone: string) {
  let found = formatters.get(timezone)
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    })
    formatters.set(timezone, found)
  }
  return found
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number }

function localParts(ms: number, timezone: string): LocalParts {
  const parts: Record<string, number> = {}
  for (const part of formatter(timezone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute }
}

function offsetMs(ms: number, timezone: string): number {
  const p = localParts(ms, timezone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / MINUTE) * MINUTE
}

/** Helyi falióra-idő → UTC. A nyári időszámítás miatt nem létező időpontra `null`. */
function localToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number | null {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  let utc = wall - offsetMs(wall, timezone)
  const second = wall - offsetMs(utc, timezone)
  if (second !== utc) utc = second
  const check = localParts(utc, timezone)
  return check.hour === hour && check.minute === minute && check.day === day ? utc : null
}

function dayMatches(spec: CronSpec, month: number, day: number, dow: number): boolean {
  if (!spec.months.includes(month)) return false
  const domOk = spec.doms.includes(day)
  const dowOk = spec.dows.includes(dow)
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk
  if (spec.domRestricted) return domOk
  if (spec.dowRestricted) return dowOk
  return true
}

function search(spec: CronSpec, timezone: string, fromMs: number, direction: 1 | -1, accept: (t: number) => boolean): number | null {
  const start = localParts(fromMs, timezone)
  const times = spec.hours.flatMap((hour) => spec.minutes.map((minute) => [hour, minute] as const))
  if (direction === -1) times.reverse()
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i * direction))
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    if (!dayMatches(spec, month, day, date.getUTCDay())) continue
    for (const [hour, minute] of times) {
      const t = localToUtc(year, month, day, hour, minute, timezone)
      if (t !== null && accept(t)) return t
    }
  }
  return null
}

/** Az első időpont, ami szigorúan `after` után van. */
export function nextSlot(spec: CronSpec, timezone: string, after: Date): Date | null {
  const t = search(spec, timezone, after.getTime(), 1, (candidate) => candidate > after.getTime())
  return t === null ? null : new Date(t)
}

/** Az utolsó időpont, ami legfeljebb `atOrBefore`. */
export function prevSlot(spec: CronSpec, timezone: string, atOrBefore: Date): Date | null {
  const t = search(spec, timezone, atOrBefore.getTime(), -1, (candidate) => candidate <= atOrBefore.getTime())
  return t === null ? null : new Date(t)
}

/** A legkisebb két futás közti távolság percben (K6 minimum-periódus, becsült napi futásszám). */
export function minimumGapMinutes(spec: CronSpec, timezone: string, from: Date, samples = 60): number | null {
  let previous = nextSlot(spec, timezone, from)
  if (!previous) return null
  let smallest = Infinity
  for (let i = 0; i < samples; i++) {
    const next = nextSlot(spec, timezone, previous)
    if (!next) break
    smallest = Math.min(smallest, (next.getTime() - previous.getTime()) / MINUTE)
    previous = next
  }
  return Number.isFinite(smallest) ? smallest : null
}

const HU_DAYS = ['vasárnap', 'hétfőn', 'kedden', 'szerdán', 'csütörtökön', 'pénteken', 'szombaton']
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Hétköznapi leírás („hétköznap 8:00-kor”); amit nem tud szépen mondani, cronként mutatja. */
export function describeCron(expr: string, language: 'hu' | 'en' = 'hu'): string {
  const spec = parseCron(expr)
  const raw = normalizeCron(expr)
  const fallback = language === 'en' ? `custom schedule (cron: ${raw})` : `egyedi ütemezés (cron: ${raw})`
  if (!spec) return fallback
  const fields = raw.split(' ')
  if (fields[2] !== '*' || fields[3] !== '*') return fallback
  let days: string
  if (!spec.dowRestricted || spec.dows.length === 7) days = language === 'en' ? 'every day' : 'naponta'
  else if (spec.dows.join(',') === '1,2,3,4,5') days = language === 'en' ? 'on weekdays' : 'hétköznap'
  else if (spec.dows.join(',') === '0,6') days = language === 'en' ? 'on weekends' : 'hétvégén'
  else days = spec.dows.map((day) => (language === 'en' ? EN_DAYS : HU_DAYS)[day]).join(', ')
  if (fields[0].startsWith('*/') && fields[1] === '*') {
    return language === 'en' ? `${days}, every ${fields[0].slice(2)} minutes` : `${days} ${fields[0].slice(2)} percenként`
  }
  if (fields[0].includes('*') || fields[1].includes('*') || spec.hours.length * spec.minutes.length > 4) return fallback
  const times = spec.hours.flatMap((hour) => spec.minutes.map((minute) => `${hour}:${String(minute).padStart(2, '0')}`))
  return language === 'en' ? `${days} at ${times.join(', ')}` : `${days} ${times.join(', ')}-kor`
}
