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

/**
 * Ismert értékből illesztő szótő(k): teljes név + első jelentős token
 * (pl. „SPAR Magyarország Kft.” → „spar magyarorszag kft”, „spar”).
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
  if (withoutLegal && withoutLegal !== normalized) {
    const wl = normalizeHungarianForMatching(withoutLegal)
    stems.add(wl)
    const first = wl.split(/\s+/)[0]
    if (first && first.length >= 2) stems.add(first)
  } else {
    const first = folded.split(/\s+/)[0]
    if (first && first.length >= 2) stems.add(first)
  }

  return [...stems].filter((s) => s.length >= 2)
}
