/**
 * Known-value szótár-illesztés Aho–Corasick automatával (spec §8/2, APG-16).
 *
 * Determinisztikus, ML-NER nélkül; szóhatár-ellenőrzéssel a hamis pozitívok ellen.
 *
 * A magyar rag NEM része a cserélt szakasznak: „a SPAR-nak” → „a [[COMPANY_1]]-nak”.
 * Az automata a ragozott alakot megtalálja, de az álnév csak a tövet fedi le —
 * így a feloldott szöveg nyelvtanilag ép marad, nem „a SPAR” ragot vesztett alakja.
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

import { createHash } from 'node:crypto'
import type { KnownValueReplacement } from '@/domain/privacy/known-value-substitution'
import {
  expandStemWithSuffixes,
  extractMatchingStems,
  HUNGARIAN_LEGAL_FORM_TOKENS,
} from '@/domain/privacy/hungarian-suffix-morphs'
import {
  applySurrogateReplacements,
  type SurrogateReplacement,
} from '@/domain/privacy/apply-replacements'
import {
  foldHungarianChar,
  hasWordBoundaries,
  isMatchingSeparator,
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
  /** A tő hossza a normalizált alakban — eddig tart az álnév, a rag marad. */
  stemLength: number
  /** A tő utolsó tokenje jogi forma rövidítés (Kft) → a záró pont hozzátartozik. */
  legalFormEnd: boolean
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
    if (isMatchingSeparator(ch)) {
      if (!lastWasSpace && normalized.length > 0) {
        normalized += ' '
        map.push({ origIndex: i })
        lastWasSpace = true
      }
      continue
    }
    normalized += foldHungarianChar(ch)
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

  return { start: startEntry.origIndex, end: endEntry.origIndex + 1 }
}

function endsWithLegalForm(stem: string): boolean {
  const lastToken = stem.split(' ').at(-1) ?? ''
  return HUNGARIAN_LEGAL_FORM_TOKENS.has(lastToken)
}

/**
 * Az automata-cache kulcsa a szótár HASH-e, nem a nyers érték: a cache-kulcsban
 * nem maradhat ott az ügyfélnév, amit épp védeni akarunk. A méret korlátos —
 * beszélgetésenként más szótár épül, korlát nélkül a folyamat memóriája nőne.
 */
const AUTOMATON_CACHE_LIMIT = 64
const automatonCache = new Map<string, InstanceType<typeof AhoCorasick>>()

function cacheKey(replacements: KnownValueReplacement[]): string {
  const hash = createHash('sha256')
  for (const r of replacements) {
    hash.update(r.needle ?? '', 'utf8')
    hash.update('\0')
    hash.update(r.surrogate ?? '', 'utf8')
    hash.update('\n')
  }
  return hash.digest('hex')
}

function getAutomaton(replacements: KnownValueReplacement[]): InstanceType<typeof AhoCorasick> {
  const key = cacheKey(replacements)
  const cached = automatonCache.get(key)
  if (cached) {
    // LRU: a friss találat a sor végére kerül, így a régiek esnek ki előbb.
    automatonCache.delete(key)
    automatonCache.set(key, cached)
    return cached
  }
  const ac = buildAutomaton(replacements)
  automatonCache.set(key, ac)
  if (automatonCache.size > AUTOMATON_CACHE_LIMIT) {
    const oldest = automatonCache.keys().next().value
    if (oldest !== undefined) automatonCache.delete(oldest)
  }
  return ac
}

function buildAutomaton(replacements: KnownValueReplacement[]): InstanceType<typeof AhoCorasick> {
  const ac = new AhoCorasick()

  for (const slot of replacements) {
    if (!slot.needle?.trim()) continue
    const stems = new Set(extractMatchingStems(slot.needle))
    stems.add(normalizeHungarianForMatching(slot.needle))

    // Pattern → a leghosszabb tő, amelyből származik (a hosszabb tő pontosabb csere).
    const patterns = new Map<string, string>()
    for (const stem of stems) {
      const normalizedStem = normalizeHungarianForMatching(stem)
      if (normalizedStem.length < 2) continue
      for (const pattern of [normalizedStem, ...expandStemWithSuffixes(normalizedStem)]) {
        const normalizedPattern = normalizeHungarianForMatching(pattern)
        if (normalizedPattern.length < 2) continue
        const existing = patterns.get(normalizedPattern)
        if (!existing || existing.length < normalizedStem.length) {
          patterns.set(normalizedPattern, normalizedStem)
        }
      }
    }

    for (const [pattern, stem] of patterns) {
      const meta: PatternMeta = {
        surrogate: slot.surrogate,
        stemLength: Math.min(stem.length, pattern.length),
        legalFormEnd: endsWithLegalForm(stem),
      }
      ac.add(pattern, meta)
    }
  }

  ac.build_fail()
  return ac
}

type RawMatch = KnownValueMatch & { fullStart: number; fullEnd: number }

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
  const raw: RawMatch[] = []

  ac.search(normalized, (matchedWord, data, offset) => {
    const metas = data as PatternMeta[]
    const normStart = offset
    const normEnd = offset + (matchedWord?.length ?? 0)

    // A szóhatárt a TELJES (ragot is fedő) találaton kell nézni: a tőre szűkített
    // span vége szándékosan szó belsejébe esik, ott a boundary-check mindig bukna.
    const fullSpan = origSpanFromNormSpan(normalized, map, normStart, normEnd)
    if (!fullSpan) return
    if (!hasWordBoundaries(text, fullSpan.start, fullSpan.end)) return

    for (const meta of metas) {
      const stemEnd = Math.min(normEnd, normStart + meta.stemLength)
      const stemSpan =
        stemEnd < normEnd
          ? origSpanFromNormSpan(normalized, map, normStart, stemEnd)
          : fullSpan
      if (!stemSpan) continue

      // Csak a jogi forma rövidítés záró pontja tartozik az entitáshoz („Kft.”);
      // a mondatvégi pont nem nyelhető le, különben eltűnik a mondathatár.
      const end =
        stemSpan === fullSpan && meta.legalFormEnd && text[stemSpan.end] === '.'
          ? stemSpan.end + 1
          : stemSpan.end

      raw.push({
        start: stemSpan.start,
        end,
        surrogate: meta.surrogate,
        matchedText: text.slice(stemSpan.start, end),
        fullStart: fullSpan.start,
        fullEnd: fullSpan.end,
      })
    }
  })

  // Az átfedést a TELJES találaton döntjük el, hogy a „SPAR Magyarország Kft.”
  // verjen a puszta „SPAR”-on — a kibocsátott span viszont a tő marad.
  raw.sort((a, b) => {
    const lenDiff = b.fullEnd - b.fullStart - (a.fullEnd - a.fullStart)
    if (lenDiff !== 0) return lenDiff
    return a.fullStart - b.fullStart
  })

  const chosen: RawMatch[] = []
  for (const match of raw) {
    const overlaps = chosen.some((c) => match.fullStart < c.fullEnd && match.fullEnd > c.fullStart)
    if (!overlaps) chosen.push(match)
  }

  return chosen
    .sort((a, b) => a.start - b.start)
    .map(({ start, end, surrogate, matchedText }) => ({ start, end, surrogate, matchedText }))
}

/** Illesztett spanok cseréje surrogate-re. */
export function applyKnownValueMatches(text: string, matches: KnownValueMatch[]): string {
  return applySurrogateReplacements(text, matches satisfies readonly SurrogateReplacement[])
}
