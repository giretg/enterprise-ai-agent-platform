import { FileEditorError } from './workspace-storage'
import {
  assertSafeRegex,
  compileSafeRegex,
  MAX_SAFE_REGEX_LENGTH,
  SafeRegexError,
} from '@/lib/safe-regex'

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

export const MAX_PATTERN_LENGTH = MAX_SAFE_REGEX_LENGTH

/** Egy soron ekkora hosszig futtatunk regexet; a többit levágjuk (visszalépés-plafon). */
export const MAX_LINE_SCAN_LENGTH = 20_000

/** file_search: legfeljebb ennyi fájlt olvasunk be egy keresésre. */
export const MAX_SEARCH_FILES = 5_000

/**
 * A közvetlenül a `{` után álló `{...}` kvantor-e, és ha igen, nem-korlátos-e
 * (`{n,}`). A korlátos formák (`{n}`, `{n,m}`, `{,m}`) nem okoznak exponenciális
 * blow-upot, a nem-numerikus `{…}` pedig literál — egyik sem „expanding".
 */
function toFileEditorError(error: unknown, label: string): never {
  if (error instanceof SafeRegexError) {
    throw new FileEditorError(error.code, error.message.replace('szabályos kifejezés', label))
  }
  throw error
}

/** A minta hossz-korlátja; tipizált `PATTERN_TOO_LONG` FileEditorError-ral bukik. */
export function assertPatternLength(source: string, label = 'keresési'): void {
  try {
    assertSafeRegex(source, `${label} minta`)
  } catch (error) {
    if (error instanceof SafeRegexError && error.code === 'PATTERN_TOO_LONG') {
      toFileEditorError(error, label)
    }
  }
}

/**
 * Biztonságos regex-fordítás: a nyers `SyntaxError` helyett tipizált
 * `INVALID_PATTERN` FileEditorError-ként bukik (a Tool Broker `code: message`
 * alakra normalizálja, így az agent cselekvésre okító üzenetet kap).
 */
export function compileRegex(source: string, flags: string, label = 'keresési'): RegExp {
  try {
    return compileSafeRegex(source, flags, `${label} minta`)
  } catch (error) {
    return toFileEditorError(error, label)
  }
}

/**
 * Ellenőrzi, hogy az agent-vezérelt NYERS regex-forrás biztonságosan
 * futtatható-e (hossz + katasztrofális-visszalépés). Dob `FileEditorError`-t
 * (`PATTERN_TOO_LONG` / `UNSAFE_PATTERN`).
 */
export function assertSafeUserRegex(source: string): void {
  try {
    assertSafeRegex(source, 'keresési minta')
  } catch (error) {
    toFileEditorError(error, 'keresési')
  }
}

/** Biztonságos regex-építés az agent NYERS mintájából (star-height + fordítás). */
export function buildUserRegex(source: string, flags = ''): RegExp {
  assertSafeUserRegex(source)
  return compileRegex(source, flags)
}
