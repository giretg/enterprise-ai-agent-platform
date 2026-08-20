/**
 * Magyar szöveg-normalizálás known-value illesztéshez (spec §8/2, APG-16).
 *
 * Kisbetűsítés, ékezet-tűrés, elválasztójel-normalizálás — csak illesztésre,
 * a kimeneti szöveg eredeti alakja megmarad.
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

/** Egy karakter normalizált alakja illesztéshez. */
export function foldHungarianChar(ch: string): string {
  const lower = ch.toLocaleLowerCase('hu-HU')
  return ACCENT_FOLD_MAP[lower] ?? lower
}

/** Illesztéshez: kisbetű + ékezet-tűrés + elválasztójel → szóköz. */
export function normalizeHungarianForMatching(text: string): string {
  let out = ''
  for (const ch of text) {
    if (/[\s\-–—_/.,;:]/.test(ch)) {
      out += ' '
      continue
    }
    out += foldHungarianChar(ch)
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
