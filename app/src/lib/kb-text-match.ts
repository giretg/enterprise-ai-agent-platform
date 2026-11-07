/**
 * #1136 §6: az egyetlen szövegillesztési szabály. Ezt használja a wiki-keresés és a
 * `kb_search` tartaléka, ezért a „találat” fogalma nem térhet el közöttük.
 * Tiszta függvények, DB nélkül: a szótövet a hívó adja (`ts_lexize`), a kliens is importálhatja.
 */
import { maskKbSensitiveText } from './kb-retrieval'

const FOLD_GROUPS: Record<string, string> = {
  a: 'áàâäãåāăą',
  c: 'çćč',
  d: 'ďđ',
  e: 'éèêëēėęě',
  g: 'ğ',
  i: 'íìîïīį',
  l: 'ł',
  n: 'ñńň',
  o: 'óòôöõőøō',
  r: 'ř',
  s: 'śšş',
  t: 'ťţ',
  u: 'úùûüűūůų',
  y: 'ýÿ',
  z: 'žźż',
}

const foldPairs: Array<[string, string]> = Object.entries(FOLD_GROUPS).flatMap(([base, accented]) =>
  [...accented].map((char): [string, string] => [char, base]),
)

/**
 * A SQL `translate(lower(x), …)` paraméterei: ugyanaz a térkép, mint a `foldKbText`-é.
 * Csak kisbetűk: a `translate` minden karakterre végigfut a térképen, a nagybetűkkel
 * együtt kétszer annyi ideig tartott a mérésen (#1136 §9).
 */
export const KB_FOLD_FROM = foldPairs.map(([from]) => from).join('')
export const KB_FOLD_TO = foldPairs.map(([, to]) => to).join('')

const FOLD_MAP = new Map(foldPairs)

/**
 * Ékezet le + kisbetű, karakterenként 1:1. A hossz nem változik, ezért a találat
 * helye az eredeti szövegre visszavetíthető.
 */
export function foldKbText(text: string): string {
  let out = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    const lower = char.toLowerCase()
    out += FOLD_MAP.get(lower) ?? (lower.length === 1 ? lower : char)
  }
  return out
}

/** A keresőkifejezés szavai: kisbetű, nem-betű/szám karakternél vágva, dedup, min. 2 karakter. */
export function kbQueryTerms(query: string): string[] {
  const seen = new Set<string>()
  for (const token of query.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 2) seen.add(token)
  }
  return [...seen]
}

export type KbTextTerm = {
  /** Ahogy a néző beírta (kisbetűvel). */
  term: string
  folded: string
  /** Hajtogatott szótő, ha a §6 feltételei teljesülnek; különben nincs tőalak. */
  stem: string | null
}

/** §6 tőalak: a túl rövidre vágott tő torz egyezést adna (bank → ba, terminál → term). */
export function kbStemForm(term: string, lexeme: string | null | undefined): string | null {
  if (!lexeme) return null
  const folded = foldKbText(term)
  const stem = foldKbText(lexeme)
  const removed = folded.length - stem.length
  if (folded.length < 5 || stem.length < 3 || removed < 1 || removed > 3) return null
  return folded.startsWith(stem) ? stem : null
}

export function kbTextTerm(term: string, lexeme?: string | null): KbTextTerm {
  return { term, folded: foldKbText(term), stem: kbStemForm(term, lexeme) }
}

type LiteralMode = 'whole' | 'start' | 'anywhere'

function literalMode(folded: string): LiteralMode {
  if (folded.length <= 2) return 'whole'
  return folded.length === 3 ? 'start' : 'anywhere'
}

/** A szavak csak betűből és számból állnak (`kbQueryTerms`); ez a tartalék, ha más hívó mást adna. */
function escapeRegex(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, '\\$&')
}

/** Postgres-regex a betű szerinti illesztésre (`\m`: szó eleje, `\M`: szó vége). */
export function kbLiteralPattern(term: Pick<KbTextTerm, 'folded'>): string {
  const body = escapeRegex(term.folded)
  const mode = literalMode(term.folded)
  if (mode === 'whole') return `\\m${body}\\M`
  return mode === 'start' ? `\\m${body}` : body
}

/** Postgres-regex a teljes szabályra: betű szerint VAGY a szó eleje a tőalak. */
export function kbTermPattern(term: Pick<KbTextTerm, 'folded' | 'stem'>): string {
  const literal = kbLiteralPattern(term)
  return term.stem ? `${literal}|\\m${escapeRegex(term.stem)}` : literal
}

/** A részszöveg, amely nélkül a szó biztosan nem illeszkedik: ez az olcsó előszűrés a regex előtt. */
export function kbTermNeedle(term: Pick<KbTextTerm, 'folded' | 'stem'>): string {
  return term.stem ?? term.folded
}

const WORD_CHAR = '[\\p{L}\\p{N}_]'
const WORD_START = `(?<!${WORD_CHAR})`
const WORD_END = `(?!${WORD_CHAR})`

/** A `kbTermPattern` JS-megfelelője, hajtogatott szövegre. */
export function kbTermRegExp(term: Pick<KbTextTerm, 'folded' | 'stem'>): RegExp {
  const body = escapeRegex(term.folded)
  const mode = literalMode(term.folded)
  const literal = mode === 'whole' ? `${WORD_START}${body}${WORD_END}` : mode === 'start' ? `${WORD_START}${body}` : body
  return new RegExp(term.stem ? `${literal}|${WORD_START}${escapeRegex(term.stem)}` : literal, 'gu')
}

/** Illeszkedik-e a szó a szövegre (ugyanaz a szabály, mint a SQL-ben). */
export function kbTermMatches(term: Pick<KbTextTerm, 'folded' | 'stem'>, text: string): boolean {
  return kbTermRegExp(term).test(foldKbText(text))
}

const IS_WORD_CHAR = new RegExp(`^${WORD_CHAR}$`, 'u')

export type KbMatchRange = { start: number; end: number; term: number }

/**
 * A szavak előfordulásai a hajtogatott szövegben, a teljes szóra bővítve: a `kártya`
 * a `bankkártyát` egészét jelöli, nem egy szó közepét. Kezdőpont szerint rendezve.
 */
export function kbMatchRanges(foldedText: string, terms: ReadonlyArray<Pick<KbTextTerm, 'folded' | 'stem'>>): KbMatchRange[] {
  const ranges: KbMatchRange[] = []
  terms.forEach((term, index) => {
    for (const match of foldedText.matchAll(kbTermRegExp(term))) {
      let start = match.index
      let end = start + match[0].length
      while (start > 0 && IS_WORD_CHAR.test(foldedText[start - 1])) start--
      while (end < foldedText.length && IS_WORD_CHAR.test(foldedText[end])) end++
      ranges.push({ start, end, term: index })
    }
  })
  return ranges.sort((a, b) => a.start - b.start || a.end - b.end)
}

const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g

/** A részlethez: a látható szöveg, a Markdown-jelölések nélkül. A HTML-t szövegként hagyja. */
export function kbStripMarkdown(markdown: string): string {
  return markdown
    .replace(WIKI_LINK, (_all, target: string, label?: string) =>
      label?.trim() || target.replace(/\s*\\\s*$/, '').split('/').pop()!.replace(/\.md$/, ''),
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:```|~~~).*$/gm, ' ')
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/\*\*|__|~~|`|\*/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type KbSnippet = { text: string; ranges: Array<[start: number, end: number]> }

const SNIPPET_CHARS = 160
const SNAP_CHARS = 24

/** A legtöbb különböző szót tartalmazó ablak; holtversenyben a legkorábbi. */
function bestWindow(matches: KbMatchRange[], size: number): { from: number; to: number } {
  let best = { from: matches[0].start, to: matches[0].end, distinct: 0 }
  const counts = new Map<number, number>()
  let tail = 0
  for (let head = 0; head < matches.length; head++) {
    counts.set(matches[head].term, (counts.get(matches[head].term) ?? 0) + 1)
    while (matches[head].end - matches[tail].start > size && tail < head) {
      const left = counts.get(matches[tail].term)! - 1
      if (left === 0) counts.delete(matches[tail].term)
      else counts.set(matches[tail].term, left)
      tail++
    }
    if (counts.size > best.distinct) {
      best = { from: matches[tail].start, to: matches[head].end, distinct: counts.size }
    }
  }
  return best
}

function shorten(text: string, size: number): string {
  if (text.length <= size) return text
  const cut = text.lastIndexOf(' ', size)
  return `${text.slice(0, cut > size - SNAP_CHARS ? cut : size)}…`
}

/**
 * A találat részlete: Markdown le → maszkolás → ablak → tartományok. A tartományok a
 * maszkolás UTÁN számolódnak, különben elcsúsznának. Ha a látható szövegben nincs
 * találat (pl. link célja), a tartalék szöveg jelenik meg kiemelés nélkül.
 */
export function kbSnippet(input: {
  body: string
  fallback: string
  terms: ReadonlyArray<Pick<KbTextTerm, 'folded' | 'stem'>>
  size?: number
}): KbSnippet {
  const size = input.size ?? SNIPPET_CHARS
  const visible = maskKbSensitiveText(kbStripMarkdown(input.body))
  const matches = kbMatchRanges(foldKbText(visible), input.terms)
  if (matches.length === 0) {
    return { text: shorten(maskKbSensitiveText(input.fallback).trim(), size), ranges: [] }
  }
  const { from, to } = bestWindow(matches, size)
  const slack = Math.max(0, size - (to - from))
  let start = Math.max(0, from - Math.floor(slack / 2))
  let end = Math.min(visible.length, start + Math.max(size, to - from))
  start = Math.max(0, Math.min(start, end - size))
  if (start > 0) {
    const space = visible.indexOf(' ', start)
    if (space !== -1 && space < from && space - start <= SNAP_CHARS) start = space + 1
  }
  if (end < visible.length) {
    const space = visible.lastIndexOf(' ', end)
    if (space >= to && end - space <= SNAP_CHARS) end = space
  }
  const prefix = start > 0 ? '…' : ''
  const ranges: KbSnippet['ranges'] = []
  for (const match of matches) {
    const left = Math.max(match.start, start)
    const right = Math.min(match.end, end)
    if (left >= right) continue
    const last = ranges[ranges.length - 1]
    const mapped: [number, number] = [left - start + prefix.length, right - start + prefix.length]
    if (last && mapped[0] <= last[1]) last[1] = Math.max(last[1], mapped[1])
    else ranges.push(mapped)
  }
  return { text: `${prefix}${visible.slice(start, end)}${end < visible.length ? '…' : ''}`, ranges }
}

function quoteTsLexeme(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

/**
 * #1136 K1: egy szó explicit `tsquery`-je. A `lexemes` a `ts_lexize` eredménye: üres tömb =
 * stopszó, a szó kiesik (`null`). A második ág nyers, szótövezetlen prefix; a mai `to_tsquery`
 * a TÖVEZETT alakra tett prefixet, innen jött a torz egyezés (`bank` → `ba:*` → `barát`).
 */
export function kbTermTsQuery(term: string, lexemes: readonly string[] | null | undefined): string | null {
  if (lexemes && lexemes.length === 0) return null
  const lexeme = lexemes?.[0]
  const raw = `${quoteTsLexeme(term)}:*`
  if (!lexeme) return raw
  return kbStemForm(term, lexeme) ? `${quoteTsLexeme(lexeme)}:* | ${raw}` : `${quoteTsLexeme(lexeme)} | ${raw}`
}

/** A szavankénti kifejezések VAGY-kapcsolata; a `kb_search` jelölt-sorrendjéhez is ez kell. */
export function kbCombinedTsQuery(perTerm: readonly string[]): string {
  return perTerm.map((query) => `(${query})`).join(' | ')
}

/** K2: a tartalék legfeljebb ennyi szóra fut, a leghosszabbakra (a ritka, tartalmi szavak). */
const KB_FALLBACK_MAX_TERMS = 8
const KB_FALLBACK_MIN_CHARS = 3

export function kbFallbackTerms<T extends { term: string }>(terms: readonly T[]): T[] {
  return terms
    .filter((row) => row.term.length >= KB_FALLBACK_MIN_CHARS)
    .sort((a, b) => b.term.length - a.term.length)
    .slice(0, KB_FALLBACK_MAX_TERMS)
}

/**
 * K2: a tartalék találatai a meglévő jelöltekhez: ugyanazon a helyen a `matched` összevonódik,
 * új hely `score: 0`-val jön, így a sorrendet továbbra is a `rankKbHits` dönti el.
 */
export function kbMergeFallbackHits<T extends { matched?: string[]; score: number }>(
  base: readonly T[],
  extra: readonly T[],
  key: (hit: T) => string,
): T[] {
  const merged = new Map<string, T>(base.map((hit) => [key(hit), hit]))
  for (const hit of extra) {
    const existing = merged.get(key(hit))
    merged.set(
      key(hit),
      existing
        ? { ...existing, matched: [...new Set([...(existing.matched ?? []), ...(hit.matched ?? [])])] }
        : { ...hit, score: 0 },
    )
  }
  return [...merged.values()]
}
