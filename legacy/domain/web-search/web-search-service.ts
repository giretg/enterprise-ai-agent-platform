/**
 * WebSearchService — query → provider hívás → result-normalizálás → forrás-
 * minősítés → policy-szerinti szűrés (Feature-spec — WebSearchTool §8.1, §5.6).
 */
import { WebSearchPolicyService } from './web-search-policy-service'
import type {
  ProviderSearchResultItem,
  WebSearchAdapterResolver,
  WebSearchConnectorConfig,
  WebSearchEffectiveQuery,
  WebSearchResult,
  WebSearchResultItem,
  WebSearchSourceType,
  WebSearchWarning,
} from './web-search-types'

// (^|\.) is required, not \., so a bare apex like "gov.hu" matches too — not
// only subdomains like "valami.gov.hu".
const OFFICIAL_DOMAIN_RE = /(^|\.)(gov(\.[a-z]{2})?|mnb\.hu|europa\.eu)$/i
const VENDOR_DOC_RE = /^(docs|developer|developers|api)\./i
const NEWS_DOMAIN_RE = /(news|hirek|index\.hu|origo\.hu|reuters\.com|bloomberg\.com)/i
const BLOG_DOMAIN_RE = /blog/i

export function classifySourceType(domain: string): WebSearchSourceType {
  if (OFFICIAL_DOMAIN_RE.test(domain)) return 'official'
  if (VENDOR_DOC_RE.test(domain)) return 'vendor_doc'
  if (NEWS_DOMAIN_RE.test(domain)) return 'news'
  if (BLOG_DOMAIN_RE.test(domain)) return 'blog'
  return 'unknown'
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function redactQuery(query: string): string {
  return query.length > 120 ? `${query.slice(0, 117)}...` : query
}

export type WebSearchServiceResult = {
  result: WebSearchResult
  resultDomains: string[]
  deniedDomainsMatched: string[]
}

export class WebSearchService {
  constructor(
    private resolveAdapter: WebSearchAdapterResolver,
    private policy: WebSearchPolicyService,
  ) {}

  async search(
    effective: WebSearchEffectiveQuery,
    config: WebSearchConnectorConfig,
    secretAlias: string | null = null,
  ): Promise<WebSearchServiceResult> {
    // D-WS-7 / D-WS-2: a provider és a kulcs CONNECTOR-onként (tenant policy)
    // dől el, nem egy folyamat-globális env-állapotból.
    const adapter = await this.resolveAdapter(config, secretAlias)
    const response = await adapter.search({
      query: effective.query,
      domains: effective.domains,
      recencyDays: effective.recencyDays,
      locale: effective.locale,
      region: config.defaultRegion,
      maxResults: effective.maxResultsEffective,
      safeSearch: config.safeSearch,
    })

    const retrievedAt = new Date().toISOString()
    const warnings: WebSearchWarning[] = []
    const deniedDomainsSeen = new Set<string>()

    const normalized = response.items
      .map((item): { item: ProviderSearchResultItem; domain: string | null } => ({
        item,
        domain: hostnameOf(item.url),
      }))
      .filter((entry) => entry.domain !== null) as { item: ProviderSearchResultItem; domain: string }[]

    const kept: WebSearchResultItem[] = []
    let rank = 1
    for (const { item, domain } of normalized) {
      if (this.policy.isDomainDenied(domain, config)) {
        deniedDomainsSeen.add(domain)
        continue
      }
      if (kept.length >= effective.maxResultsEffective) continue

      const sourceType = classifySourceType(domain)
      const policyLabels = ['allowed_domain']
      if (sourceType === 'official') policyLabels.push('official_source')

      kept.push({
        rank: rank++,
        title: item.title,
        url: item.url,
        displayUrl: domain,
        domain,
        snippet: item.snippet,
        publishedAt: item.publishedAt,
        retrievedAt,
        sourceType,
        policyLabels,
      })
    }

    if (deniedDomainsSeen.size > 0) {
      warnings.push({
        code: 'RESULTS_FILTERED_DENIED_DOMAIN',
        message: `${deniedDomainsSeen.size} result(s) removed: denied domain match`,
      })
    }
    if (response.items.length > 0 && kept.length === 0) {
      warnings.push({
        code: 'RESULTS_FILTERED_EMPTY',
        message: 'Provider returned results, but policy filtering removed all of them',
      })
    }

    return {
      result: {
        results: kept,
        queryMeta: {
          queryRedacted: redactQuery(effective.query),
          domainsEffective: effective.domains,
          recencyDays: effective.recencyDays,
          provider: response.provider,
          resultCount: kept.length,
          retrievedAt,
        },
        warnings,
      },
      resultDomains: kept.map((item) => item.domain),
      deniedDomainsMatched: [...deniedDomainsSeen],
    }
  }
}
