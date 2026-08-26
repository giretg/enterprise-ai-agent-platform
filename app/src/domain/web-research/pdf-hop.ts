import { classifySourceType } from '@/domain/web-search/web-search-service'
import { normalizeHostname } from '@/domain/web-search/web-search-policy-service'
import { isFetchTrusted, type FetchTrustPolicy } from './fetch-trust'
import type { WebResearchSourceType } from './web-research-types'

export const WEB_RESEARCH_HOP_DEFAULT = 1
export const WEB_RESEARCH_HOP_HARD_CAP = 2
export const WEB_RESEARCH_HOP_MAX_PER_PAGE = 3

const NO_HOP_SOURCE_TYPES = new Set<string>(['news', 'blog'])

export type HopLink = { url: string; text: string }

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function filenameOf(url: string): string {
  try {
    const path = new URL(url).pathname
    return path.slice(path.lastIndexOf('/') + 1)
  } catch {
    return ''
  }
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9áéíóöőúüű]+/i)
      .filter((token) => token.length >= 3),
  )
}

function overlapScore(objective: string, link: HopLink): number {
  const objectiveTokens = tokens(objective)
  const candidateTokens = tokens(`${filenameOf(link.url)} ${link.text}`)
  let score = 0
  for (const token of candidateTokens) {
    if (objectiveTokens.has(token)) score += 1
  }
  return score
}

export function canHopFromSourceType(sourceType: string): boolean {
  return !NO_HOP_SOURCE_TYPES.has(sourceType)
}

/** Same-host összehasonlítás: leading `www.` levágva. */
export function sameHopHost(left: string, right: string): boolean {
  return normalizeHostname(left).replace(/^www\./, '') === normalizeHostname(right).replace(/^www\./, '')
}

/**
 * Egy sikeresen letöltött, fetch-trusted HTML szülő PDF-hop jelöltjei.
 * A rangsor: fájlnév + link-szöveg token-átfedése a kutatási objective-vel;
 * döntetlenben dokumentum-sorrend. Oldalanként max 3.
 */
export function selectPdfHops(input: {
  parentUrl: string
  parentSourceType: WebResearchSourceType | string
  links: HopLink[]
  objective: string
  policy: FetchTrustPolicy
  maxPerPage?: number
}): HopLink[] {
  if (!canHopFromSourceType(input.parentSourceType)) return []
  const parentHost = hostOf(input.parentUrl)
  if (!parentHost) return []

  const ranked = input.links
    .map((link, index) => {
      const host = hostOf(link.url)
      if (!host) return null
      // Hop only follows same-host PDFs. Cross-host links (incl. docs.*/api.*
      // vendor_doc prefixes) must not expand egress beyond the discovered parent.
      if (!sameHopHost(parentHost, host)) return null
      if (!isFetchTrusted({ host, sourceType: classifySourceType(host), policy: input.policy })) {
        return null
      }
      return { link, index, score: overlapScore(input.objective, link) }
    })
    .filter((row): row is { link: HopLink; index: number; score: number } => row !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)

  const cap = input.maxPerPage ?? WEB_RESEARCH_HOP_MAX_PER_PAGE
  return ranked.slice(0, cap).map((row) => row.link)
}
