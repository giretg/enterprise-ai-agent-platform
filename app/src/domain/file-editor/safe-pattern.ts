import { FileEditorError } from './workspace-storage'

/**
 * ReDoS-védelem az agent által vezérelt fájl-kereséshez (file_search / file_glob).
 *
 * A `file_search` `pattern`-je NYERS reguláris kifejezésként fut a workspace
 * minden során (`new RegExp(pattern)`), a `file_glob` mintája pedig glob→regex
 * fordításon megy át. Mindkettő az LLM (végső soron részben megbízhatatlan
 * ticket-/dokumentumtartalomból származó) tool-hívásából jön. Egy „katasztrofális
 * visszalépésű" minta megakasztja a Node event-loopját — az pedig egyszálú, így
 * az egész worker (és vele a multi-tenant platform más tenantjainak futásai is)
 * befagynak. Ez CWE-1333 (Inefficient Regular Expression Complexity) →
 * rendelkezésre-állási kockázat.
 *
 * Az EXPONENCIÁLIS visszalépésnek két gyakorlati, könnyen kiváltható családja van;
 * a statikus ellenőrzés MINDKETTŐT elutasítja a regex FUTTATÁSA ELŐTT:
 *  1. Beágyazott, nem-korlátos kvantor (star height ≥ 2), pl. `(a+)+`, `((a)+)+`.
 *  2. Nem-korlátos kvantorral ismételt, alternációt tartalmazó csoport, pl.
 *     `(a|a)+`, `(a|ab)+` — ez star height 1, de átfedő ágakon szintén 2^n.
 *
 * Emellett a bemenet mérete is korlátozott (minta-hossz, sor-hossz, fájlszám),
 * ami a MARADÉK, polinomiális visszalépést is behatárolja.
 *
 * Tudott korlát (szándékos, dokumentált): a `(foo|bar)+` alakú, NEM átfedő
 * alternációt is elutasítjuk (konzervatív, hamis pozitív) — a fájl-keresésnél ez
 * elfogadható ár a biztos védelemért. A magas fokú polinomiális minták (sok
 * egymás utáni `.*…a.*…a`) nincsenek statikusan tiltva; ezek ellen a sor-hossz
 * plafon véd. Teljes körű megoldás (RE2 vagy worker-thread időzár) külön feladat.
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

/** Egy `[...]` karakterosztály végének indexe (az escapelt `\]`-t tiszteletben tartva). */
function endOfCharClass(source: string, openAt: number): number {
  let i = openAt + 1
  if (source[i] === '^') i++
  while (i < source.length && source[i] !== ']') {
    if (source[i] === '\\') i++ // escapelt karakter (pl. `\]`) átugrása
    i++
  }
  return i // a `]`-en áll, vagy a string végén (nem lezárt osztály)
}

type GroupFrame = { containsUnbounded: boolean; hasAlternation: boolean }

/**
 * `true`, ha a minta katasztrofális (exponenciális) visszalépést okozhat:
 *  - nem-korlátos kvantor egy olyan csoporton, aminek a TARTALMA maga is
 *    tartalmaz nem-korlátos kvantort (star height ≥ 2), VAGY
 *  - nem-korlátos kvantor egy olyan csoporton, ami top-level alternációt (`|`)
 *    tartalmaz (átfedő ágak → 2^n).
 */
function hasCatastrophicQuantifier(source: string): boolean {
  const stack: GroupFrame[] = [{ containsUnbounded: false, hasAlternation: false }]
  // Az előző atom egy most bezárt csoport volt-e, és milyen kockázatot hordozott.
  let prevGroupClose = false
  let prevGroupUnbounded = false
  let prevGroupAlternation = false

  const top = () => stack[stack.length - 1]

  const applyUnboundedQuantifier = (): boolean => {
    top().containsUnbounded = true // a jelen szinten megjelent egy nem-korlátos kvantor
    // Ha egy „belül kockázatos" csoportra alkalmazzuk → exponenciális ReDoS.
    return prevGroupClose && (prevGroupUnbounded || prevGroupAlternation)
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]

    if (ch === '\\') {
      i++ // escapelt karakter → literál atom
      prevGroupClose = false
      continue
    }

    if (ch === '[') {
      i = endOfCharClass(source, i) // a `]`-ig minden literál, kvantor nem lehet benne
      prevGroupClose = false
      continue
    }

    if (ch === '(') {
      stack.push({ containsUnbounded: false, hasAlternation: false })
      prevGroupClose = false
      continue
    }

    if (ch === ')') {
      const closed = stack.length > 1 ? stack.pop()! : top() // védőháló hibás mintára
      if (closed.containsUnbounded) top().containsUnbounded = true // felbukik a szülőbe
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
      const q = readBraceQuantifier(source, i)
      if (q) {
        i += q.length - 1
        if (q.unbounded && applyUnboundedQuantifier()) return true
        // korlátos `{…}`: nem állítja a szint „unbounded" flagjét
        prevGroupClose = false
        continue
      }
      prevGroupClose = false // literál `{`
      continue
    }

    // `?` (korlátos/lazy) és minden más atom (literál, `.`, `^`, `$`) lezárja az
    // „előző csoport" állapotot, de nem „expanding".
    prevGroupClose = false
  }

  return false
}

/** A minta hossz-korlátja; tipizált `PATTERN_TOO_LONG` FileEditorError-ral bukik. */
export function assertPatternLength(source: string, label = 'keresési'): void {
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new FileEditorError(
      'PATTERN_TOO_LONG',
      `A ${label} minta túl hosszú (max ${MAX_PATTERN_LENGTH} karakter).`,
    )
  }
}

/**
 * Biztonságos regex-fordítás: a nyers `SyntaxError` helyett tipizált
 * `INVALID_PATTERN` FileEditorError-ként bukik (a Tool Broker `code: message`
 * alakra normalizálja, így az agent cselekvésre okító üzenetet kap).
 */
export function compileRegex(source: string, flags: string, label = 'keresési'): RegExp {
  try {
    return new RegExp(source, flags)
  } catch (e) {
    throw new FileEditorError(
      'INVALID_PATTERN',
      `Érvénytelen ${label} minta: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/**
 * Ellenőrzi, hogy az agent-vezérelt NYERS regex-forrás biztonságosan
 * futtatható-e (hossz + katasztrofális-visszalépés). Dob `FileEditorError`-t
 * (`PATTERN_TOO_LONG` / `UNSAFE_PATTERN`).
 */
export function assertSafeUserRegex(source: string): void {
  assertPatternLength(source)
  if (hasCatastrophicQuantifier(source)) {
    throw new FileEditorError(
      'UNSAFE_PATTERN',
      'A keresési minta olyan ismétlést tartalmaz, ami befagyaszthatja a keresést ' +
        '(pl. beágyazott `(a+)+`, vagy ismételt alternáció `(a|a)+`). Egyszerűsítsd a mintát.',
    )
  }
}

/** Biztonságos regex-építés az agent NYERS mintájából (star-height + fordítás). */
export function buildUserRegex(source: string, flags = ''): RegExp {
  assertSafeUserRegex(source)
  return compileRegex(source, flags)
}
