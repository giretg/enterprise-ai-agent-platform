/**
 * Web Search Tool — adatmodell és tool-kontraktus típusok
 * (Feature-spec — WebSearchTool §3, §4).
 */

/** PlatformSetting kulcs a web_search kill-switchhez (Feature-spec §7.2, WS13). */
export const WEB_SEARCH_CONTROLS_KEY = 'web_search.controls'

export type WebSearchConnectorConfig = {
  provider: 'managed_search' | 'custom_search_api' | 'stub'
  allowedDomains: string[]
  deniedDomains: string[]
  defaultLocale: string
  defaultRegion: string
  defaultMaxResults: number
  hardMaxResults: number
  maxQueryLength: number
  maxQueriesPerTicket: number
  maxQueriesPerAgentDay: number
  allowGeneralWeb: boolean
  safeSearch: 'strict' | 'moderate'
  logRawQuery: boolean
  retentionDays: number
  requireHumanApprovalForSensitiveQuery: boolean
}

export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConnectorConfig = {
  provider: 'stub',
  allowedDomains: [],
  deniedDomains: [],
  defaultLocale: 'hu-HU',
  defaultRegion: 'HU',
  defaultMaxResults: 5,
  hardMaxResults: 10,
  maxQueryLength: 500,
  maxQueriesPerTicket: 10,
  maxQueriesPerAgentDay: 100,
  allowGeneralWeb: false,
  safeSearch: 'strict',
  logRawQuery: false,
  retentionDays: 90,
  requireHumanApprovalForSensitiveQuery: false,
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((d): d is string => typeof d === 'string') : []
}

export function parseWebSearchConfig(raw: unknown): WebSearchConnectorConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_WEB_SEARCH_CONFIG }
  const v = raw as Partial<WebSearchConnectorConfig>
  return {
    provider:
      v.provider === 'custom_search_api' || v.provider === 'managed_search' ? v.provider : 'stub',
    allowedDomains: asStringArray(v.allowedDomains),
    deniedDomains: asStringArray(v.deniedDomains),
    defaultLocale: typeof v.defaultLocale === 'string' ? v.defaultLocale : DEFAULT_WEB_SEARCH_CONFIG.defaultLocale,
    defaultRegion: typeof v.defaultRegion === 'string' ? v.defaultRegion : DEFAULT_WEB_SEARCH_CONFIG.defaultRegion,
    defaultMaxResults:
      typeof v.defaultMaxResults === 'number' && v.defaultMaxResults > 0
        ? Math.floor(v.defaultMaxResults)
        : DEFAULT_WEB_SEARCH_CONFIG.defaultMaxResults,
    hardMaxResults:
      typeof v.hardMaxResults === 'number' && v.hardMaxResults > 0
        ? Math.floor(v.hardMaxResults)
        : DEFAULT_WEB_SEARCH_CONFIG.hardMaxResults,
    maxQueryLength:
      typeof v.maxQueryLength === 'number' && v.maxQueryLength > 0
        ? Math.floor(v.maxQueryLength)
        : DEFAULT_WEB_SEARCH_CONFIG.maxQueryLength,
    maxQueriesPerTicket:
      typeof v.maxQueriesPerTicket === 'number' && v.maxQueriesPerTicket > 0
        ? Math.floor(v.maxQueriesPerTicket)
        : DEFAULT_WEB_SEARCH_CONFIG.maxQueriesPerTicket,
    maxQueriesPerAgentDay:
      typeof v.maxQueriesPerAgentDay === 'number' && v.maxQueriesPerAgentDay > 0
        ? Math.floor(v.maxQueriesPerAgentDay)
        : DEFAULT_WEB_SEARCH_CONFIG.maxQueriesPerAgentDay,
    allowGeneralWeb:
      typeof v.allowGeneralWeb === 'boolean' ? v.allowGeneralWeb : DEFAULT_WEB_SEARCH_CONFIG.allowGeneralWeb,
    safeSearch: v.safeSearch === 'moderate' ? 'moderate' : 'strict',
    logRawQuery: typeof v.logRawQuery === 'boolean' ? v.logRawQuery : DEFAULT_WEB_SEARCH_CONFIG.logRawQuery,
    retentionDays:
      typeof v.retentionDays === 'number' && v.retentionDays > 0
        ? Math.floor(v.retentionDays)
        : DEFAULT_WEB_SEARCH_CONFIG.retentionDays,
    requireHumanApprovalForSensitiveQuery:
      typeof v.requireHumanApprovalForSensitiveQuery === 'boolean'
        ? v.requireHumanApprovalForSensitiveQuery
        : DEFAULT_WEB_SEARCH_CONFIG.requireHumanApprovalForSensitiveQuery,
  }
}

export type WebSearchArgs = {
  query: string
  domains?: string[]
  recencyDays?: number
  locale?: string
  maxResults?: number
  purpose?: string
}

export type WebSearchSourceType = 'official' | 'vendor_doc' | 'news' | 'blog' | 'unknown'

export type WebSearchResultItem = {
  rank: number
  title: string
  url: string
  displayUrl: string
  domain: string
  snippet: string
  publishedAt?: string
  retrievedAt: string
  sourceType: WebSearchSourceType
  policyLabels: string[]
}

export type WebSearchWarning = { code: string; message: string }

export type WebSearchResult = {
  results: WebSearchResultItem[]
  queryMeta: {
    queryRedacted?: string
    domainsEffective: string[]
    recencyDays?: number
    provider: string
    resultCount: number
    retrievedAt: string
  }
  warnings: WebSearchWarning[]
}

/** Tool Broker hibakódok (Feature-spec §4.3). */
export type WebSearchDenyReason =
  | 'web_search_disabled'
  | 'query_policy_blocked'
  | 'domain_not_allowed'
  | 'domain_denied'
  | 'rate_limited'

export type WebSearchEffectiveQuery = {
  query: string
  domains: string[]
  recencyDays?: number
  locale: string
  maxResultsRequested: number
  maxResultsEffective: number
  purpose?: string
  queryHash: string
}

export type WebSearchAuthorizeDecision =
  | { allowed: true; effective: WebSearchEffectiveQuery; labels: string[] }
  | { allowed: false; reason: WebSearchDenyReason; detail: string }

/** Provider-adapter szerződés — a tényleges kereső API-t a Tool Broker mögött hívja. */
export type ProviderSearchInput = {
  query: string
  domains: string[]
  recencyDays?: number
  locale: string
  region: string
  maxResults: number
  safeSearch: 'strict' | 'moderate'
}

export type ProviderSearchResultItem = {
  title: string
  url: string
  snippet: string
  publishedAt?: string
}

export type ProviderSearchResponse = {
  provider: string
  items: ProviderSearchResultItem[]
}

export interface SearchProviderAdapter {
  search(input: ProviderSearchInput): Promise<ProviderSearchResponse>
}

/**
 * Provider-választás CONNECTOR-onként (D-WS-7): a tenant connector config
 * `provider` mezője és az agent/connector-szintű `secretAlias` dönti el, melyik
 * adapter és melyik kulcs fut — nem egy folyamat-globális env-állapot.
 */
export type WebSearchAdapterResolver = (
  config: WebSearchConnectorConfig,
  secretAlias: string | null,
) => Promise<SearchProviderAdapter>

/** Audit metaadat-séma (Feature-spec §3.4) — sosem tartalmaz nyers query-t vagy teljes snippetet. */
export type WebSearchAuditMeta = {
  tool: 'web_search'
  connectorId: string
  provider: string
  queryHash: string
  queryRedacted?: string
  domainsRequested?: string[]
  domainsEffective: string[]
  deniedDomainsMatched: string[]
  recencyDays?: number
  maxResultsRequested: number
  maxResultsEffective: number
  resultCount: number
  resultDomains: string[]
  latencyMs: number
  status: 'ok' | 'denied' | 'rate_limited' | 'provider_error' | 'policy_blocked'
  denyReason?: string
  estimatedCost?: number
}
