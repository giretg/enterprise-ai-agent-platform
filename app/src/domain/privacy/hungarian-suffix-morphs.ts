/**
 * Magyar ragmorféma-lista known-value toldalék-tűréshez (spec §8/2, APG-16).
 *
 * v1: gyakori esetragok + kötőjeles toldalékolás. A pontos terjedelme nyitott
 * (spec §21), de a DoD-hoz szükséges ragozott cégnév-minták lefedettek.
 */
import { normalizeHungarianForMatching } from '@/domain/privacy/hungarian-text-normalize'

/** Ragok közvetlen toldalékolással (Sparnál) és kötőjeles formában (SPAR-nál). */
export const HUNGARIAN_CASE_SUFFIXES: readonly string[] = [
  'nak',
  'nek',
  'ban',
  'ben',
  'nál',
  'nél',
  'hoz',
  'hez',
  'höz',
  'ból',
  'ből',
  'tól',
  'től',
  'val',
  'vel',
  'ral',
  'rel',
  'ért',
  'ra',
  're',
  'ba',
  'be',
  'on',
  'en',
  'ön',
  't',
  'ot',
  'et',
  'öt',
  'at',
]

/** Egy szótőhöz generált illesztő minták (normalizált forma). */
export function expandStemWithSuffixes(stem: string): string[] {
  const base = stem.trim()
  if (!base) return []
  const patterns = new Set<string>([base])
  for (const suffix of HUNGARIAN_CASE_SUFFIXES) {
    patterns.add(`${base}${suffix}`)
    patterns.add(`${base}-${suffix}`)
  }
  return [...patterns]
}

/** Jogi forma utótagok — ezek után nem várunk ragot a tőn. */
const LEGAL_FORM_RE =
  /\b(kft\.?|zrt\.?|bt\.?|nyrt\.?|ev\.?|e\.v\.?|kkt\.?|rt\.?)\s*$/i

/** Jogi forma rövidítések normalizált alakja — csak ezek után nyeljük le a mondatvégi pontot. */
export const HUNGARIAN_LEGAL_FORM_TOKENS: ReadonlySet<string> = new Set([
  'kft',
  'zrt',
  'bt',
  'nyrt',
  'kkt',
  'rt',
  'ev',
])

/**
 * Köznévvel egybeeső névkezdetek. Ezek NEM lehetnek önálló illesztő tövek:
 * „Nagy Péter” → `nagy` minden „nagy” melléknevet személynévre cserélne, a
 * felhasználó pedig értelmezhetetlen, kilyukasztott szöveget kapna vissza.
 * A teljes név természetesen továbbra is illeszkedik.
 * (Normalizált — kisbetűs, ékezet nélküli — alakban tároljuk.)
 */
const COMMON_WORD_STEMS: ReadonlySet<string> = new Set([
  // melléknevek / színek
  'nagy', 'kis', 'kicsi', 'feher', 'fekete', 'zold', 'barna', 'sarga', 'piros',
  'voros', 'szurke', 'kek', 'uj', 'jo', 'szep', 'hosszu', 'rovid', 'elso',
  // nép- és nyelvnevek
  'magyar', 'nemet', 'francia', 'angol', 'olasz', 'orosz', 'lengyel', 'cseh',
  'szerb', 'horvat', 'torok', 'gorog', 'roman', 'szlovak',
  // foglalkozásnevek, amelyek gyakori köznevek is
  'kovacs', 'szabo', 'molnar', 'varga', 'takacs', 'halasz', 'juhasz', 'pasztor',
  'meszaros', 'biro', 'deak', 'pap', 'papp', 'fazekas', 'asztalos', 'lakatos',
  'kertesz', 'vadasz', 'kiraly', 'herceg', 'ur',
  // gyakori földrajzi/általános köznevek
  'haz', 'kert', 'viz', 'to', 'hegy', 'erdo', 'mezo', 'part', 'var', 'malom',
  'utca', 'ter', 'ut', 'kozpont', 'iroda', 'raktar', 'bolt',
])

/**
 * Ismert értékből illesztő szótő(k): teljes név + első jelentős token
 * (pl. „SPAR Magyarország Kft.” → „spar magyarorszag kft”, „spar”).
 *
 * Az első token csak akkor lesz ÖNÁLLÓ tő, ha nem esik egybe gyakori köznévvel
 * — különben a szótár a hétköznapi szavakat is entitásnak látná (l. `COMMON_WORD_STEMS`).
 */
export function extractMatchingStems(needle: string): string[] {
  const normalized = needle
    .split(/\s+/)
    .map((part) =>
      part
        .split(/[\-–—]/)
        .map((p) => p.trim())
        .filter(Boolean)
        .join(' '),
    )
    .join(' ')
    .trim()
  if (!normalized) return []

  const stems = new Set<string>()
  const folded = normalizeHungarianForMatching(normalized)
  stems.add(folded)

  const withoutLegal = normalized.replace(LEGAL_FORM_RE, '').trim()
  const base = withoutLegal && withoutLegal !== normalized
    ? normalizeHungarianForMatching(withoutLegal)
    : folded
  if (base !== folded) stems.add(base)

  const first = base.split(/\s+/)[0]
  if (first && first.length >= 2 && !COMMON_WORD_STEMS.has(first)) stems.add(first)

  return [...stems].filter((s) => s.length >= 2)
}
