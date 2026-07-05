/**
 * A KB-keresés (`kb_search`) egyetlen, előre-lefutó lekérdezésének
 * „desztillálása".
 *
 * Egy feladat-ticket effektív promptja gyakran hosszú, zajos utasítás-blokk,
 * amelybe bemásolt javaslatok vagy korábbi hibaüzenetek is beékelődnek
 * (kaszkád). A tudásbázis kulcsszó/stem alapú retrievalja ilyenkor felhígul —
 * a sok generikus stem miatt a keresett KONKRÉT dokumentum kieshet a top-k-ból.
 * Chatben ezt a felhasználó implicit módon megoldja: rövid, célzott kérdést ír.
 * Task-ágon nincs ilyen ember, ezért itt gépiesen emeljük ki a legerősebb
 * jeleket a pre-fetch query-jébe:
 *   1. explicit fájlnév-említések (pl. `... Policy v1.1.docx`),
 *   2. a beágyazott hosszú idézetek (bemásolt szövegblokkok) eldobása,
 *   3. a maradék instrukció fókuszált eleje (hossz-vágás).
 *
 * Fontos: ez CSAK a keresési query-t szűkíti — a modellnek adott feladat-prompt
 * továbbra is a teljes, eredeti szöveg marad.
 */

const MAX_QUERY_CHARS = 320

/** Beágyazott idézet, amely ennél hosszabb, bemásolt blokknak számít és kiesik. */
const EMBEDDED_QUOTE_MIN_LEN = 100

/**
 * Gyakori dokumentum-kiterjesztések fájlnév-említés felismeréséhez. A név
 * tartalmazhat szóközt, verziót és zárójelet is (pl. `Policy v1.1 (final).docx`).
 */
const FILENAME_RE = /([\p{L}\p{N}][\p{L}\p{N}\-. _()]*\.(?:docx?|pdf|xlsx?|csv|pptx?|txt|md|json))/giu

/**
 * A szóközt is tartalmazó (cím-szerű) fájlnevek felismerése mohó: a kiterjesztés
 * elé eső töltelék-szavakat is felszedheti (pl. „including the specific General …
 * .docx"). A valódi dokumentumnevek jellemzően nagy kezdőbetűs vagy verzió-jelölt
 * szóval kezdődnek, ezért a vezető, kisbetűs funkciószavakat levágjuk.
 */
function trimLeadingFiller(name: string): string {
  const words = name.split(' ')
  while (
    words.length > 1 &&
    /^\p{Ll}/u.test(words[0]) && // kisbetűvel kezdődik
    words[0].length <= 12 &&
    !/[\d.]/.test(words[0]) // nem verzió/kiterjesztés-token
  ) {
    words.shift()
  }
  return words.join(' ')
}

/** A szövegben említett dokumentum-fájlnevek (deduplikálva, megjelenési sorrendben). */
export function extractDocumentMentions(text: string): string[] {
  return [
    ...new Set([...text.matchAll(FILENAME_RE)].map((m) => trimLeadingFiller(m[1].trim()))),
  ].filter(Boolean)
}

/**
 * Egy nyers feladat-utasításból fókuszált KB-keresési query-t állít elő.
 * Rövid, tiszta bemenetnél gyakorlatilag változatlanul visszaadja a szöveget.
 */
export function distillKbSearchQuery(raw: string): string {
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''

  const filenames = extractDocumentMentions(normalized)

  // A bemásolt hosszú idézetek (javaslat/korábbi hiba-szöveg) eldobása — ezek
  // adják a legtöbb zajos stemet.
  const deQuoted = normalized
    .replace(new RegExp(`["“”'\`]([^"“”'\`]{${EMBEDDED_QUOTE_MIN_LEN},})["“”'\`]`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const lead = deQuoted.slice(0, MAX_QUERY_CHARS)

  // A fájlneveket előre tesszük, hogy a hossz-vágás után is biztosan bennmaradjanak
  // (és a fájlnév-stemek nagyobb súlyt kapjanak a scoringban).
  const distilled = [...filenames, lead].join(' ').replace(/\s+/g, ' ').trim()

  return distilled || normalized.slice(0, MAX_QUERY_CHARS)
}
