/**
 * Candidate extraction a user-input entity resolverhez (APG-17, spec §9).
 *
 * ML-NER nélkül: idézőjeles szöveg + nagy kezdőbetűs token-sorozatok.
 * A ragozott alak normalizálása a resolve-hívás előtt történik (APG-16 toldalék-lista).
 */
import { HUNGARIAN_CASE_SUFFIXES } from '@/domain/privacy/hungarian-suffix-morphs'
import {
  hasWordBoundaries,
  normalizeHungarianForMatching,
} from '@/domain/privacy/hungarian-text-normalize'

export type EntityCandidateSpan = {
  start: number
  end: number
  /** Eredeti szövegrészlet — ezt cseréljük surrogate-re. */
  matchedText: string
  /** A connector felé küldött resolve-szöveg (tő / idézett forma). */
  resolveText: string
}

const QUOTED_RE = /["'„«]([^"'»]{2,120})["'»]/g
const PROPER_NOUN_RE =
  /\b([A-ZÁÉÍÓÖŐÚÜŰ][A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű0-9]+(?:[\s\-–—][A-ZÁÉÍÓÖŐÚÜŰ][A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű0-9]+)*)\b/g

const SKIP_TOKENS = new Set([
  'a',
  'az',
  'egy',
  'és',
  'vagy',
  'hogy',
  'nem',
  'igen',
  'kér',
  'kérlek',
  'kérem',
  'készíts',
  'készits',
  'mutasd',
  'listázd',
  'listazd',
  'add',
  'meg',
  'idei',
  'tavalyi',
  'forgalom',
  'forgalmáról',
  'forgalmárol',
  'kimutatást',
  'kimutatast',
  'adatokat',
  'adatait',
])

/** User-szövegből jelöltek — hosszabb, nem átfedő spanok balról jobbra. */
export function extractEntityCandidates(text: string): EntityCandidateSpan[] {
  if (!text?.trim()) return []

  const raw: EntityCandidateSpan[] = []

  QUOTED_RE.lastIndex = 0
  for (const match of text.matchAll(QUOTED_RE)) {
    const inner = match[1]?.trim()
    if (!inner || inner.length < 2) continue
    const start = (match.index ?? 0) + match[0].indexOf(inner)
    pushCandidate(raw, text, start, start + inner.length, inner)
  }

  PROPER_NOUN_RE.lastIndex = 0
  for (const match of text.matchAll(PROPER_NOUN_RE)) {
    const token = match[1]?.trim()
    if (!token || token.length < 2) continue
    const firstWord = token.split(/\s+/)[0]?.toLowerCase() ?? ''
    if (SKIP_TOKENS.has(firstWord)) continue
    const start = match.index ?? 0
    pushCandidate(raw, text, start, start + token.length, token)
  }

  raw.sort((a, b) => {
    if (b.end - b.start !== a.end - a.start) return b.end - b.start - (a.end - a.start)
    return a.start - b.start
  })

  const chosen: EntityCandidateSpan[] = []
  for (const span of raw) {
    if (!hasWordBoundaries(text, span.start, span.end)) continue
    if (chosen.some((c) => span.start < c.end && span.end > c.start)) continue
    chosen.push(span)
  }

  return chosen.sort((a, b) => a.start - b.start)
}

function pushCandidate(
  out: EntityCandidateSpan[],
  text: string,
  start: number,
  end: number,
  matchedText: string,
): void {
  if (!hasWordBoundaries(text, start, end)) return
  const resolveText = stemForResolve(matchedText)
  if (resolveText.length < 2) return
  out.push({ start, end, matchedText, resolveText })
}


/** Rag levágása resolve-hívás előtt (pl. Sparnak → SPAR). */
export function stemForResolve(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''

  const hyphenIdx = trimmed.search(/[\-–—]/)
  if (hyphenIdx > 0) {
    const head = trimmed.slice(0, hyphenIdx).trim()
    const tail = trimmed.slice(hyphenIdx + 1).trim().toLowerCase()
    if (HUNGARIAN_CASE_SUFFIXES.includes(tail) && head.length >= 2) return head
  }

  const lower = trimmed.toLowerCase()
  for (const suffix of HUNGARIAN_CASE_SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length + 1) {
      return trimmed.slice(0, trimmed.length - suffix.length)
    }
  }

  return trimmed
}

/** Normalizált összehasonlítás duplikált resolve-hívások elkerülésére. */
export function normalizeResolveQuery(text: string): string {
  return normalizeHungarianForMatching(text)
}
