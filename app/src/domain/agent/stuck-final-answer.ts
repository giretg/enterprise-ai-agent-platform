/**
 * „Stuck thinking" detektor: a modell tool-hívás nélkül hosszú, ismétlődő
 * belső töprengést ad vissza válaszként (tipikusan maxTokens-ig).
 *
 * A tool loop ezt NEM fogadja el felhasználói válasznak — egyszer újrapróbál,
 * másodjára őszinte kudarcüzenetet ad.
 *
 * A téves találat DRÁGA: egy jó választ dobnánk el, és a felhasználó a
 * „nem sikerült" üzenetet kapná helyette. Ezért a meta-ág két FÜGGETLEN jelet
 * követel — eszköznevek ÉS hangos töprengés —, a kódrészleteket pedig kihagyjuk
 * a vizsgálatból: egy kódot magyarázó válasz jogosan írja le, hogy
 * `http_api_get`, `base64` vagy `tool_result_read`.
 */

export const STUCK_THINKING_FALLBACK_MESSAGE =
  'Sajnos nem sikerült megbízható választ összeállítanom — a források lekérése közben elakadtam (nagy/csonkolt vagy nehezen olvasható tool-eredmény). ' +
  'Próbáld meg konkrétabb kérdéssel, vagy tedd a releváns dokumentumot a tudásbázisba.'

export const STUCK_THINKING_RETRY_NOTICE =
  '[STUCK-GUARD] Az előző kimeneted belső gondolkodás / ismétlés volt, nem a felhasználónak szóló válasz. ' +
  'VAGY hívj eszközt a hiányzó adatért, VAGY adj RÖVID, őszinte magyar választ: mit tudtál meg, és mi hiányzik. ' +
  'NE ismételd a tool-korlátok feletti töprengést, és NE írj hosszú monológot.'

/** Eszköz/formátum-nevek, amiken a modell tipikusan „megakad". */
const META_MARKERS: RegExp[] = [
  /\btool_result_read\b/i,
  /\btool_result_extract\b/i,
  /\bfile_read\b/i,
  /\bbase64\b/i,
  /tree-paths/i,
  /\.tool-results\//i,
  /http_api_get/i,
  /nyers JSON/i,
]

/**
 * Hangos töprengés: a modell magának beszél, nem a felhasználónak. Ez az a jel,
 * ami egy kódot MAGYARÁZÓ válaszban nem fordul elő.
 */
const DELIBERATION_MARKERS: RegExp[] = [
  /\bnem tudom\b/i,
  /\bnem tudok\b/i,
  /\bnem praktikus\b/i,
  /\bnem sikerül(t)?\b/i,
  /\bde nincs\b/i,
  /\bnincs \w+ eszköz/i,
  /\bpróbáljuk\b/i,
  /\bpróbálom\b/i,
  /\bnézzük\b/i,
  /\bkeressük\b/i,
  /\blássuk\b/i,
  /\binkább\b/i,
  /\btalán\b/i,
  /\bvárj\b/i,
]

export type StuckFinalAnswerVerdict =
  | { stuck: false }
  | { stuck: true; reason: 'repetitive_paragraphs' | 'tool_meta_rumination' | 'very_long_meta' }

/** Kódblokkok és inline kód nélküli szöveg — a jeleket csak a PRÓZÁBAN számoljuk. */
function proseOnly(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
}

/** Van-e érdemi kódblokk: aki kódot mutat, az válaszol, nem töpreng. */
function hasSubstantialCodeBlock(text: string): boolean {
  for (const block of text.match(/```[\s\S]*?```/g) ?? []) {
    if (block.length >= 200) return true
  }
  return false
}

function paragraphFingerprints(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter((p) => p.length >= 40)
    .map((p) => p.slice(0, 96))
}

function countMatches(text: string, patterns: RegExp[]): number {
  let hits = 0
  for (const re of patterns) {
    if (re.test(text)) hits++
  }
  return hits
}

/**
 * Tool-hívás nélküli modellkimenetre: stuck-e (gondolkodási loop / meta-töprengés).
 * Rövid, normális válaszokra false.
 */
export function detectStuckFinalAnswer(text: string): StuckFinalAnswerVerdict {
  const trimmed = text.trim()
  if (trimmed.length < 1_200) return { stuck: false }

  const prose = proseOnly(trimmed)

  // Ugyanaz a bekezdés újra és újra: ez önmagában romlott kimenet, jel nem kell hozzá.
  const fps = paragraphFingerprints(prose)
  if (fps.length >= 5) {
    const unique = new Set(fps).size
    if (unique / fps.length <= 0.5) {
      return { stuck: true, reason: 'repetitive_paragraphs' }
    }
  }

  if (hasSubstantialCodeBlock(trimmed)) return { stuck: false }

  const metaHits = countMatches(prose, META_MARKERS)
  const deliberationHits = countMatches(prose, DELIBERATION_MARKERS)
  if (deliberationHits < 2) return { stuck: false }

  if (prose.length >= 2_500 && metaHits >= 3) {
    return { stuck: true, reason: 'tool_meta_rumination' }
  }
  if (prose.length >= 6_000 && metaHits >= 2) {
    return { stuck: true, reason: 'very_long_meta' }
  }

  return { stuck: false }
}
