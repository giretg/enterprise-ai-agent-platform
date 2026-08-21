/**
 * Magyar szöveg-normalizálás known-value illesztéshez (spec §8/2, APG-16).
 *
 * Kisbetűsítés, ékezet-tűrés, elválasztójel-normalizálás — csak illesztésre,
 * a kimeneti szöveg eredeti alakja megmarad.
 *
 * Az elválasztó-készlet és a szóhatár-szabály EGY helyen él: a matcher, a
 * jelölt-kivonat és a resolve-kulcs ugyanezt hívja. Ha ezek szétcsúsznak, a
 * normalizált és az eredeti szöveg indexei elmozdulnak egymáshoz képest —
 * a csere rossz helyre kerül, és maszkolatlan cégnév megy ki a modellnek.
 */

const ACCENT_FOLD_MAP: Record<string, string> = {
  á: 'a',
  é: 'e',
  í: 'i',
  ó: 'o',
  ö: 'o',
  ő: 'o',
  ú: 'u',
  ü: 'u',
  ű: 'u',
}

/** Illesztéskor szóhatárnak számító karakterek (közös az összes privacy-réteggel). */
const SEPARATOR_RE = /[\s\-–—_/.,;:]/

export function isMatchingSeparator(ch: string): boolean {
  return SEPARATOR_RE.test(ch)
}

/** Egy karakter normalizált alakja illesztéshez. */
export function foldHungarianChar(ch: string): string {
  const lower = ch.toLocaleLowerCase('hu-HU')
  return ACCENT_FOLD_MAP[lower] ?? lower
}

/** Illesztéshez: kisbetű + ékezet-tűrés + elválasztójel → szóköz. */
export function normalizeHungarianForMatching(text: string): string {
  let out = ''
  for (const ch of text) {
    out += isMatchingSeparator(ch) ? ' ' : foldHungarianChar(ch)
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** Szóhatár: magyar betűk + számok (cégnév-rész). */
const WORD_CHAR_RE = /[\p{L}\p{N}]/u

export function isWordBoundaryBefore(text: string, index: number): boolean {
  if (index <= 0) return true
  return !WORD_CHAR_RE.test(text[index - 1] ?? '')
}

export function isWordBoundaryAfter(text: string, index: number): boolean {
  if (index >= text.length) return true
  return !WORD_CHAR_RE.test(text[index] ?? '')
}

export function hasWordBoundaries(text: string, start: number, end: number): boolean {
  return isWordBoundaryBefore(text, start) && isWordBoundaryAfter(text, end)
}
