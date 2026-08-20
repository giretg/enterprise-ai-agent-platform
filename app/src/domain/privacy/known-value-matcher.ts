/**
 * Known-value szótár-illesztés Aho–Corasick automatával (spec §8/2, APG-16).
 *
 * Determinisztikus, ML-NER nélkül; szóhatár-ellenőrzéssel a hamis pozitívok ellen.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AhoCorasick = require('aho-corasick') as new () => {
  add: (word: string, data: unknown) => void
  build_fail: () => void
  search: (
    text: string,
    callback: (matchedWord: string, data: unknown[], offset: number) => void,
  ) => void
}

import type { KnownValueReplacement } from '@/domain/privacy/known-value-substitution'
import { expandStemWithSuffixes, extractMatchingStems } from '@/domain/privacy/hungarian-suffix-morphs'
import {
  foldHungarianChar,
  isWordBoundaryAfter,
  isWordBoundaryBefore,
  normalizeHungarianForMatching,
} from '@/domain/privacy/hungarian-text-normalize'

export type KnownValueMatch = {
  start: number
  end: number
  surrogate: string
  matchedText: string
}

type PatternMeta = {
  surrogate: string
  slotIndex: number
}

type CharMapEntry = {
  /** Eredeti szöveg indexe; szóköz-normalizálásnál -1 = kihagyott. */
  origIndex: number
}

/** Normalizált szöveg + index-visszakeresés az eredeti pozícióhoz. */
export function buildMatchingIndexMap(text: string): { normalized: string; map: CharMapEntry[] } {
  const map: CharMapEntry[] = []
  let normalized = ''
  let lastWasSpace = true

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? ''
    if (/[\s\-–—_/.,;:]/.test(ch)) {
      if (!lastWasSpace && normalized.length > 0) {
        normalized += ' '
        map.push({ origIndex: i })
        lastWasSpace = true
      }
      continue
    }
    const folded = ch
      .split('')
      .map((c) => foldHungarianChar(c))
      .join('')
    normalized += folded
    map.push({ origIndex: i })
    lastWasSpace = false
  }

  return { normalized, map }
}

function trimIndexMap(normalized: string, map: CharMapEntry[]): { normalized: string; map: CharMapEntry[] } {
  let start = 0
  while (start < normalized.length && normalized[start] === ' ') start += 1
  let end = normalized.length
  while (end > start && normalized[end - 1] === ' ') end -= 1
  return {
    normalized: normalized.slice(start, end),
    map: map.slice(start, end),
  }
}

function origSpanFromNormSpan(
  text: string,
  normalized: string,
  map: CharMapEntry[],
  normStart: number,
  normEnd: number,
): { start: number; end: number } | null {
  let ns = normStart
  let ne = normEnd
  while (ns < ne && normalized[ns] === ' ') ns += 1
  while (ne > ns && normalized[ne - 1] === ' ') ne -= 1
  if (ns >= ne || ne > map.length) return null

  const startEntry = map[ns]
  const endEntry = map[ne - 1]
  if (!startEntry || !endEntry || startEntry.origIndex < 0 || endEntry.origIndex < 0) return null

  let start = startEntry.origIndex
  let end = endEntry.origIndex + 1
  if (text[end] === '.') end += 1

  return { start, end }
}

function hasWordBoundaries(text: string, start: number, end: number): boolean {
  return isWordBoundaryBefore(text, start) && isWordBoundaryAfter(text, end)
}

function cacheKey(replacements: KnownValueReplacement[]): string {
  return replacements.map((r) => `${r.needle}\0${r.surrogate}`).join('\n')
}

const automatonCache = new Map<string, InstanceType<typeof AhoCorasick>>()

function getAutomaton(replacements: KnownValueReplacement[]): InstanceType<typeof AhoCorasick> {
  const key = cacheKey(replacements)
  const cached = automatonCache.get(key)
  if (cached) return cached
  const ac = buildAutomaton(replacements)
  automatonCache.set(key, ac)
  return ac
}

function buildAutomaton(replacements: KnownValueReplacement[]): InstanceType<typeof AhoCorasick> {
  const ac = new AhoCorasick()

  replacements.forEach((slot, slotIndex) => {
    if (!slot.needle?.trim()) return
    const stems = extractMatchingStems(slot.needle)
    const allPatterns = new Set<string>()
    for (const stem of stems) {
      for (const p of expandStemWithSuffixes(stem)) {
        allPatterns.add(p)
      }
      allPatterns.add(normalizeHungarianForMatching(stem))
    }
    allPatterns.add(normalizeHungarianForMatching(slot.needle))

    for (const pattern of allPatterns) {
      const normalizedPattern = normalizeHungarianForMatching(pattern)
      if (normalizedPattern.length < 2) continue
      const meta: PatternMeta = { surrogate: slot.surrogate, slotIndex }
      ac.add(normalizedPattern, meta)
    }
  })

  ac.build_fail()
  return ac
}

/** Találatok az eredeti szövegben; átfedőket a leghosszabb nyeri. */
export function findKnownValueMatches(
  text: string,
  replacements: KnownValueReplacement[],
): KnownValueMatch[] {
  if (!text || replacements.length === 0) return []

  const built = buildMatchingIndexMap(text)
  const { normalized, map } = trimIndexMap(built.normalized, built.map)
  if (!normalized) return []

  const ac = getAutomaton(replacements)
  const raw: KnownValueMatch[] = []

  ac.search(normalized, (matchedWord, data, offset) => {
    const metas = data as PatternMeta[]
    const normStart = offset
    const normEnd = offset + (matchedWord?.length ?? 0)
    const span = origSpanFromNormSpan(text, normalized, map, normStart, normEnd)
    if (!span) return
    if (!hasWordBoundaries(text, span.start, span.end)) return

    for (const meta of metas) {
      raw.push({
        start: span.start,
        end: span.end,
        surrogate: meta.surrogate,
        matchedText: text.slice(span.start, span.end),
      })
    }
  })

  raw.sort((a, b) => {
    if (b.end - b.start !== a.end - a.start) return b.end - b.start - (a.end - a.start)
    return a.start - b.start
  })

  const chosen: KnownValueMatch[] = []
  for (const match of raw) {
    const overlaps = chosen.some((c) => match.start < c.end && match.end > c.start)
    if (!overlaps) chosen.push(match)
  }

  return chosen.sort((a, b) => a.start - b.start)
}

/** Illesztett spanok cseréje surrogate-re (balról jobbra, nem-átfedő). */
export function applyKnownValueMatches(text: string, matches: KnownValueMatch[]): string {
  if (matches.length === 0) return text
  let out = ''
  let cursor = 0
  for (const match of matches) {
    out += text.slice(cursor, match.start)
    out += match.surrogate
    cursor = match.end
  }
  out += text.slice(cursor)
  return out
}
