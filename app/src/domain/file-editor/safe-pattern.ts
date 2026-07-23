import { FileEditorError } from './workspace-storage'

/**
 * ReDoS-védelem az agent által vezérelt fájl-kereséshez (file_search / file_glob).
 *
 * A `file_search` `pattern`-je NYERS reguláris kifejezésként fut a workspace
 * minden során (`new RegExp(pattern)`), a `file_glob` mintája pedig glob→regex
 * fordításon megy át. Mindkettő az LLM (végső soron részben megbízhatatlan
 * ticket-/dokumentumtartalomból származó) tool-hívásából jön. Egy „katasztrofális
 * visszalépésű" minta (pl. `(a+)+$`) egyetlen elég hosszú soron megakasztja a
 * Node event-loopját — az pedig egyszálú, így az egész worker (és vele a
 * multi-tenant platform más tenantjainak futásai is) befagynak. Ez CWE-1333
 * (Inefficient Regular Expression Complexity) → rendelkezésre-állási kockázat.
 *
 * Kétrétegű, függőség nélküli védelem:
 *  1. A minta hossza korlátozott (`MAX_PATTERN_LENGTH`).
 *  2. Elutasítjuk a beágyazott, nem-korlátos kvantorokat (star height ≥ 2), mert
 *     az exponenciális visszalépés kizárólag ilyenkor lép fel. A korlátos
 *     kvantor (`?`, `{n}`, `{n,m}`) NEM tiltott — így a jogos minták túlnyomó
 *     része átmegy.
 *
 * A hívó ezen felül korlátozza a beolvasott bemenet méretét (sor-hossz, fájlszám),
 * ami a maradék polinomiális visszalépést is behatárolja.
 */

export const MAX_PATTERN_LENGTH = 1000

/** Egy soron ekkora hosszig futtatunk regexet; a többit levágjuk (visszalépés-plafon). */
export const MAX_LINE_SCAN_LENGTH = 20_000

/** file_search: legfeljebb ennyi fájlt olvasunk be egy keresésre. */
export const MAX_SEARCH_FILES = 5_000

/**
 * A közvetlenül a `{` után álló `{...}` kvantor-e, és ha igen, nem-korlátos-e
 * (`{n,}`). A korlátos formák (`{n}`, `{n,m}`, `{,m}`) nem okoznak exponenciális
 * blow-upot, a nem-numerikus `{…}` pedig literál — egyik sem „expanding".
 */
function readBraceQuantifier(source: string, at: number): { length: number; unbounded: boolean } | null {
  const close = source.indexOf('}', at)
  if (close === -1) return null
  const inner = source.slice(at + 1, close)
  if (!/^\d*,?\d*$/.test(inner) || inner === '' || inner === ',') return null
  const unbounded = /^\d+,$/.test(inner) // csak a {n,} nyitott felülről
  return { length: close - at + 1, unbounded }
}

/**
 * Star height ≤ 1 ellenőrzés: `true`, ha a minta tartalmaz egy nem-korlátos
 * kvantort (`*`, `+`, `{n,}`), amely egy olyan csoportra vonatkozik, aminek a
 * TARTALMA maga is tartalmaz nem-korlátos kvantort. Ez a klasszikus,
 * exponenciális ReDoS-aláírás (`(a+)+`, `(a*)*`, `((a)+)+`, `(a{1,}b)+` …).
 */
function hasNestedUnboundedQuantifier(source: string): boolean {
  // Csoport-mélységenként: tartalmaz-e nem-korlátos kvantort a szint tartalma.
  const containsUnbounded: boolean[] = [false]
  // Az előző atom egy most bezárt csoport volt-e, és volt-e benne nem-korlátos kvantor.
  let prevGroupClose = false
  let prevGroupUnbounded = false

  const applyUnboundedQuantifier = (): boolean => {
    // A jelenlegi szinten megjelent egy nem-korlátos kvantor.
    containsUnbounded[containsUnbounded.length - 1] = true
    // Ha épp egy „belül kvantoros" csoportra alkalmazzuk → star height ≥ 2.
    return prevGroupClose && prevGroupUnbounded
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]

    if (ch === '\\') {
      // Escapelt karakter → literál atom, a strukturális jelentés kimarad.
      i++
      prevGroupClose = false
      continue
    }

    if (ch === '[') {
      // Karakterosztály: a `]`-ig minden literál, kvantor nem lehet benne.
      const close = source.indexOf(']', ch === '[' && source[i + 1] === ']' ? i + 2 : i + 1)
      i = close === -1 ? source.length : close
      prevGroupClose = false
      continue
    }

    if (ch === '(') {
      containsUnbounded.push(false)
      prevGroupClose = false
      continue
    }

    if (ch === ')') {
      const closed = containsUnbounded.pop() ?? false
      if (containsUnbounded.length === 0) containsUnbounded.push(false) // védőháló hibás mintára
      // A csoport tartalma felbukik a szülőbe (a szülő tartalma is tartalmazza).
      if (closed) containsUnbounded[containsUnbounded.length - 1] = true
      prevGroupClose = true
      prevGroupUnbounded = closed
      continue
    }

    if (ch === '*' || ch === '+') {
      if (applyUnboundedQuantifier()) return true
      prevGroupClose = false
      continue
    }

    if (ch === '{') {
      const q = readBraceQuantifier(source, i)
      if (q) {
        i += q.length - 1
        if (q.unbounded && applyUnboundedQuantifier()) return true
        // korlátos `{…}`: nem állítja a szint „unbounded" flagjét
        prevGroupClose = false
        continue
      }
      // literál `{`
      prevGroupClose = false
      continue
    }

    if (ch === '?') {
      // Korlátos kvantor / lazy jelölő — nem „expanding".
      prevGroupClose = false
      continue
    }

    // Bármely más atom (literál, `.`, `|`, `^`, `$`) lezárja az „előző csoport" állapotot.
    prevGroupClose = false
  }

  return false
}

/**
 * Ellenőrzi, hogy az agent-vezérelt regex-forrás biztonságosan futtatható-e.
 * Dob `FileEditorError`-t (`PATTERN_TOO_LONG` / `UNSAFE_PATTERN`), amit a Tool
 * Broker felszíni `code: message` alakra normalizál — így az agent cselekvésre
 * okító hibaüzenetet kap a néma befagyás helyett.
 */
export function assertSafeUserRegex(source: string): void {
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new FileEditorError(
      'PATTERN_TOO_LONG',
      `A keresési minta túl hosszú (max ${MAX_PATTERN_LENGTH} karakter).`,
    )
  }
  if (hasNestedUnboundedQuantifier(source)) {
    throw new FileEditorError(
      'UNSAFE_PATTERN',
      'A keresési minta beágyazott, nem-korlátos ismétlést tartalmaz (pl. `(a+)+`), ' +
        'ami befagyaszthatja a keresést. Egyszerűsítsd a mintát.',
    )
  }
}

/**
 * Biztonságos regex-építés az agent mintájából: előbb star-height ellenőrzés,
 * majd fordítás. Az érvénytelen regex nyers `SyntaxError` helyett tipizált
 * `INVALID_PATTERN` FileEditorError-ként bukik.
 */
export function buildUserRegex(source: string, flags = ''): RegExp {
  assertSafeUserRegex(source)
  try {
    return new RegExp(source, flags)
  } catch (e) {
    throw new FileEditorError(
      'INVALID_PATTERN',
      `Érvénytelen keresési minta: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}
