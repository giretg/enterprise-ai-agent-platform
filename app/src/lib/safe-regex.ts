/**
 * Közös ReDoS-védelem konfigurációból származó reguláris kifejezésekhez.
 *
 * A JavaScript-regex a Node eseményhurkán fut. Egy katasztrofálisan visszalépő
 * minta ezért nem csak a kérését, hanem ugyanazon worker minden tenantjának
 * munkáját feltarthatja (CWE-1333).
 */

export const MAX_SAFE_REGEX_LENGTH = 1000

export type SafeRegexErrorCode = 'PATTERN_TOO_LONG' | 'UNSAFE_PATTERN' | 'INVALID_PATTERN'

export class SafeRegexError extends Error {
  constructor(
    readonly code: SafeRegexErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SafeRegexError'
  }
}

function readBraceQuantifier(source: string, at: number): { length: number; unbounded: boolean } | null {
  const close = source.indexOf('}', at)
  if (close === -1) return null
  const inner = source.slice(at + 1, close)
  if (!/^\d*,?\d*$/.test(inner) || inner === '' || inner === ',') return null
  return { length: close - at + 1, unbounded: /^\d+,$/.test(inner) }
}

function endOfCharClass(source: string, openAt: number): number {
  let i = openAt + 1
  if (source[i] === '^') i++
  while (i < source.length && source[i] !== ']') {
    if (source[i] === '\\') i++
    i++
  }
  return i
}

type GroupFrame = { containsUnbounded: boolean; hasAlternation: boolean }

/**
 * Két gyakori exponenciális visszalépési családot zár ki futtatás előtt:
 * beágyazott nyitott kvantort és nyitott kvantorral ismételt alternációt.
 */
function hasCatastrophicQuantifier(source: string): boolean {
  const stack: GroupFrame[] = [{ containsUnbounded: false, hasAlternation: false }]
  let prevGroupClose = false
  let prevGroupUnbounded = false
  let prevGroupAlternation = false
  const top = () => stack[stack.length - 1]!

  const applyUnboundedQuantifier = (): boolean => {
    top().containsUnbounded = true
    return prevGroupClose && (prevGroupUnbounded || prevGroupAlternation)
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') {
      i++
      prevGroupClose = false
      continue
    }
    if (ch === '[') {
      i = endOfCharClass(source, i)
      prevGroupClose = false
      continue
    }
    if (ch === '(') {
      stack.push({ containsUnbounded: false, hasAlternation: false })
      prevGroupClose = false
      continue
    }
    if (ch === ')') {
      const closed = stack.length > 1 ? stack.pop()! : top()
      if (closed.containsUnbounded) top().containsUnbounded = true
      prevGroupClose = true
      prevGroupUnbounded = closed.containsUnbounded
      prevGroupAlternation = closed.hasAlternation
      continue
    }
    if (ch === '|') {
      top().hasAlternation = true
      prevGroupClose = false
      continue
    }
    if (ch === '*' || ch === '+') {
      if (applyUnboundedQuantifier()) return true
      prevGroupClose = false
      continue
    }
    if (ch === '{') {
      const quantifier = readBraceQuantifier(source, i)
      if (quantifier) {
        i += quantifier.length - 1
        if (quantifier.unbounded && applyUnboundedQuantifier()) return true
        prevGroupClose = false
        continue
      }
    }
    prevGroupClose = false
  }
  return false
}

/** Ellenőrzi a minta méretét és a katasztrofális visszalépés ismert családjait. */
export function assertSafeRegex(source: string, label = 'szabályos kifejezés'): void {
  if (source.length > MAX_SAFE_REGEX_LENGTH) {
    throw new SafeRegexError(
      'PATTERN_TOO_LONG',
      `A ${label} túl hosszú (max ${MAX_SAFE_REGEX_LENGTH} karakter).`,
    )
  }
  if (hasCatastrophicQuantifier(source)) {
    throw new SafeRegexError(
      'UNSAFE_PATTERN',
      `A ${label} olyan ismétlést tartalmaz, ami befagyaszthatja a feldolgozást ` +
        '(pl. beágyazott `(a+)+`, vagy ismételt alternáció `(a|a)+`).',
    )
  }
}

/** Biztonsági ellenőrzés után fordítja le a mintát, egységes hibával. */
export function compileSafeRegex(source: string, flags = '', label = 'szabályos kifejezés'): RegExp {
  assertSafeRegex(source, label)
  try {
    return new RegExp(source, flags)
  } catch (error) {
    throw new SafeRegexError(
      'INVALID_PATTERN',
      `Érvénytelen ${label}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
