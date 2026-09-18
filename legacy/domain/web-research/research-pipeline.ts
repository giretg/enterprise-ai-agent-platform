/**
 * web_research_request összerakó mag: usable-szűrő, fetch-trust hostok,
 * determinisztikus PDF-hop, fact/meta építés. A Tool Broker ág ezt hívja;
 * a tesztek fake search + fake fetch-csel, hálózat nélkül futtatják.
 */
import { createHash } from 'node:crypto'
import type { WebFetchResult, WebFetchSourceType } from '@/domain/web-fetch/web-fetch-types'
import { WEB_FETCH_PDF_CONTENT_TYPE } from '@/domain/web-fetch/web-fetch-types'
import { normalizeFetchUrl } from '@/domain/web-fetch/normalize-fetch-url'
import { classifySourceType } from '@/domain/web-search/web-search-service'
import type { WebSearchResultItem } from '@/domain/web-search/web-search-types'
import { isFetchTrusted, mergeResearchAllowlistHosts, type FetchTrustPolicy } from './fetch-trust'
import { KnownUrlRegistry } from './known-url-registry'
import {
  selectPdfHops,
  WEB_RESEARCH_HOP_DEFAULT,
  WEB_RESEARCH_HOP_HARD_CAP,
} from './pdf-hop'
import type {
  WebResearchContentType,
  WebResearchFact,
  WebResearchResult,
  WebResearchSource,
  WebResearchSourceType,
} from './web-research-types'
import { WEB_RESEARCH_EMPTY_DOCUMENT_NOTICE, WEB_RESEARCH_FACT_MAX_CHARS } from './web-research-types'

export const WEB_FETCH_RESEARCH_CONTENT_TYPES = [WEB_FETCH_PDF_CONTENT_TYPE] as const

export type ResearchPipelineFetch = (input: {
  url: string
  sourceType: WebFetchSourceType
  allowedSourceUrls: string[]
  extraAllowlistHosts: string[]
  fetchIndex: number
  hop: boolean
  perDiscoveryMax: number
}) => Promise<WebFetchResult>

export type ResearchFetchedItem = {
  url: string
  title: string
  host: string
  sourceType: WebResearchSourceType
  text: string
  contentHash: string
  contentType: WebResearchContentType
  pageCount?: number
  truncated: boolean
  hop: boolean
  notice?: string
}

export function buildResearchSearchArgs(input: {
  objective: string
  knownDomain?: string
  maxSources: number
}): { query: string; maxResults: number; purpose: 'web_research_request'; domains?: string[] } {
  return {
    query: input.objective,
    maxResults: input.maxSources * 2,
    purpose: 'web_research_request',
    ...(input.knownDomain ? { domains: [input.knownDomain] } : {}),
  }
}

export function researchPerDiscoveryMax(maxSources: number): number {
  return maxSources + WEB_RESEARCH_HOP_HARD_CAP
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function asResearchSourceType(value: string): WebResearchSourceType {
  if (
    value === 'official' ||
    value === 'vendor_doc' ||
    value === 'news' ||
    value === 'blog' ||
    value === 'unknown'
  ) {
    return value
  }
  return 'unknown'
}

function asFetchSourceType(value: WebResearchSourceType): WebFetchSourceType {
  return value
}

function researchContentType(mime: string): WebResearchContentType {
  return mime === WEB_FETCH_PDF_CONTENT_TYPE ? 'pdf' : 'html'
}

export function filterUsableResearchSources(input: {
  results: WebSearchResultItem[]
  allowedSourceTypes: WebResearchSourceType[]
  policy: FetchTrustPolicy
  maxSources: number
}): WebSearchResultItem[] {
  const allowed = new Set(input.allowedSourceTypes)
  return input.results
    .filter((result) => {
      const host = hostOf(result.url)
      if (!host) return false
      if (!allowed.has(asResearchSourceType(result.sourceType))) return false
      return isFetchTrusted({ host, sourceType: result.sourceType, policy: input.policy })
    })
    .slice(0, input.maxSources)
}

export async function runWebResearchPipeline(input: {
  objective: string
  searchResults: WebSearchResultItem[]
  allowedSourceTypes: WebResearchSourceType[]
  maxSources: number
  policy: FetchTrustPolicy
  fetch: ResearchPipelineFetch
  registry: KnownUrlRegistry
  hopQuota?: number
}): Promise<{ fetched: ResearchFetchedItem[]; extraAllowlistHosts: string[] }> {
  const usable = filterUsableResearchSources({
    results: input.searchResults,
    allowedSourceTypes: input.allowedSourceTypes,
    policy: input.policy,
    maxSources: input.maxSources,
  })
  const allowedSourceUrls: string[] = []
  for (const source of usable) {
    const normalized = normalizeFetchUrl(source.url)
    if (normalized) allowedSourceUrls.push(normalized)
  }
  const extraAllowlistHosts = mergeResearchAllowlistHosts(
    [],
    usable.map((source) => hostOf(source.url)).filter((host): host is string => Boolean(host)),
  )
  const perDiscoveryMax = researchPerDiscoveryMax(input.maxSources)
  const fetched: ResearchFetchedItem[] = []
  let fetchIndex = 0

  const recordOk = (
    source: { url: string; title: string; sourceType: string },
    result: Extract<WebFetchResult, { ok: true }>,
    hop: boolean,
  ) => {
    fetched.push({
      url: source.url,
      title: source.title,
      host: result.host,
      sourceType: asResearchSourceType(source.sourceType),
      text: result.text,
      contentHash: result.contentHash,
      contentType: researchContentType(result.contentType),
      pageCount: result.pageCount,
      truncated: result.truncated === true || Boolean(result.notice && !result.text.trim()),
      hop,
      notice: result.notice,
    })
  }

  const hopParents: Array<{ url: string; sourceType: WebResearchSourceType; links: Array<{ url: string; text: string }> }> =
    []

  for (const source of usable) {
    const sourceType = asResearchSourceType(source.sourceType)
    input.registry.add(source.url, sourceType)
    const result = await input.fetch({
      url: source.url,
      sourceType: asFetchSourceType(sourceType),
      allowedSourceUrls: [...allowedSourceUrls],
      extraAllowlistHosts,
      fetchIndex,
      hop: false,
      perDiscoveryMax,
    })
    fetchIndex += 1
    if (!result.ok) continue
    recordOk(source, result, false)
    if (result.contentType !== WEB_FETCH_PDF_CONTENT_TYPE && (result.links?.length ?? 0) > 0) {
      hopParents.push({ url: source.url, sourceType, links: result.links ?? [] })
    }
  }

  const hopQuota = Math.min(input.hopQuota ?? WEB_RESEARCH_HOP_DEFAULT, WEB_RESEARCH_HOP_HARD_CAP)
  const hopSeen = new Set(allowedSourceUrls)
  const hopQueue: Array<{ url: string; text: string }> = []
  for (const parent of hopParents) {
    const selected = selectPdfHops({
      parentUrl: parent.url,
      parentSourceType: parent.sourceType,
      links: parent.links,
      objective: input.objective,
      policy: input.policy,
    })
    for (const hop of selected) {
      if (hopSeen.has(hop.url)) continue
      hopSeen.add(hop.url)
      hopQueue.push(hop)
    }
  }

  for (const hop of hopQueue.slice(0, hopQuota)) {
    const hopHost = hostOf(hop.url)
    const hopType = asResearchSourceType(classifySourceType(hopHost ?? ''))
    if (hopHost && !extraAllowlistHosts.includes(hopHost)) extraAllowlistHosts.push(hopHost)
    allowedSourceUrls.push(hop.url)
    input.registry.add(hop.url, hopType)
    const result = await input.fetch({
      url: hop.url,
      sourceType: asFetchSourceType(hopType),
      allowedSourceUrls: [...allowedSourceUrls],
      extraAllowlistHosts,
      fetchIndex,
      hop: true,
      perDiscoveryMax,
    })
    fetchIndex += 1
    if (!result.ok) continue
    recordOk({ url: hop.url, title: hop.text, sourceType: hopType }, result, true)
  }

  return { fetched, extraAllowlistHosts }
}

export function buildWebResearchCandidate(input: {
  objective: string
  fetched: ResearchFetchedItem[]
  egressRoleAgentId: string
  egressRoleAgentVersion?: number
  requesterAgentId: string
  queryHash: string
}): WebResearchResult {
  const fetchedAt = new Date().toISOString()
  const sources: WebResearchSource[] = input.fetched.map((item) => ({
    urlHash: createHash('sha256').update(item.url).digest('hex').slice(0, 16),
    host: item.host.toLowerCase(),
    sourceType: item.sourceType,
    contentHash: item.contentHash,
    fetchedAt,
    title: item.title.slice(0, 500) || undefined,
    contentType: item.contentType,
    pageCount: item.pageCount,
    truncated: item.truncated,
    hop: item.hop,
    notice: item.notice ?? (item.text.trim() ? undefined : WEB_RESEARCH_EMPTY_DOCUMENT_NOTICE),
  }))
  const facts: WebResearchFact[] = input.fetched.map((item, index) => {
    const extracted = item.text.replace(/\s+/g, ' ').trim().slice(0, WEB_RESEARCH_FACT_MAX_CHARS)
    return {
      statement: extracted,
      sourceIndices: [index],
      confidence:
        item.sourceType === 'official' || item.sourceType === 'vendor_doc' ? 'medium' : 'low',
    }
  })
  const hasUnverified = sources.some(
    (source) => source.sourceType === 'news' || source.sourceType === 'blog' || source.sourceType === 'unknown',
  )
  return {
    objectiveEcho: input.objective.slice(0, 500),
    facts,
    sources,
    overallConfidence: 'medium',
    unverified: hasUnverified,
    provenance: {
      egressRoleAgentId: input.egressRoleAgentId,
      egressRoleAgentVersion: input.egressRoleAgentVersion,
      requesterAgentId: input.requesterAgentId,
      queryHash: input.queryHash,
      contractVersion: 'web_research/v1',
    },
  }
}
