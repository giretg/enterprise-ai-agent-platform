/**
 * Brave Web Search adapter (#1020, legacy EXTRACT). Policyről nem dönt: a már engedélyezett,
 * normalizált lekérdezést küldi ki, és a választ egységes alakra hozza.
 */
import type { ProviderSearchInput, ProviderSearchItem, SearchProvider } from './web-search'

export const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search'

/** A Brave csak kódolt frissességet fogad (`Nd` → 422). */
export function braveFreshness(recencyDays: number | undefined): string | undefined {
  if (!recencyDays || recencyDays <= 0) return undefined
  if (recencyDays <= 1) return 'pd'
  if (recencyDays <= 7) return 'pw'
  if (recencyDays <= 31) return 'pm'
  return 'py'
}

/** A Brave `country` enumja szűk (pl. HU nincs benne → 422), ezért csak ismert kódot küldünk. */
const BRAVE_COUNTRIES = new Set(
  'AR AU AT BE BR CA CL DK FI FR DE GR HK IN ID IT JP KR MY MX NL NZ NO CN PL PT PH RU SA ZA ES SE CH TW TR GB US ALL'.split(' '),
)

export function braveLocaleParams(locale: string, region: string): { search_lang?: string; country?: string } {
  const lang = locale.trim().split('-')[0]?.toLowerCase()
  const country = region.trim().toUpperCase()
  return {
    ...(lang ? { search_lang: lang } : {}),
    ...(BRAVE_COUNTRIES.has(country) ? { country } : {}),
  }
}

/** A domain-kör `site:` operátorként megy ki; a találatokat a hívó ettől függetlenül is szűri. */
export function braveQuery(query: string, domains: readonly string[]): string {
  const sites = [...new Set(domains.map((d) => d.replace(/^\*\./, '')))]
  if (sites.length === 0) return query
  return `${query} (${sites.map((s) => `site:${s}`).join(' OR ')})`
}

type BraveRow = { title?: unknown; url?: unknown; description?: unknown; page_age?: unknown; published?: unknown }

export function parseBraveResponse(body: unknown): ProviderSearchItem[] {
  const record = (body ?? {}) as { web?: { results?: BraveRow[] } }
  const rows = Array.isArray(record.web?.results) ? record.web.results : []
  return rows
    .filter((row) => typeof row.url === 'string' && typeof row.title === 'string')
    .map((row) => {
      const publishedAt = typeof row.page_age === 'string' ? row.page_age : typeof row.published === 'string' ? row.published : undefined
      return {
        title: row.title as string,
        url: row.url as string,
        snippet: typeof row.description === 'string' ? row.description : '',
        ...(publishedAt ? { publishedAt } : {}),
      }
    })
}

export class BraveSearchError extends Error {
  constructor(public readonly status: number) {
    super(`brave_search_http_${status}`)
    this.name = 'BraveSearchError'
  }
}

export function braveSearchProvider(apiKey: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    async search(input: ProviderSearchInput) {
      const url = new URL(BRAVE_WEB_SEARCH_URL)
      url.searchParams.set('q', braveQuery(input.query, input.domains))
      url.searchParams.set('count', String(input.maxResults))
      url.searchParams.set('safesearch', input.safeSearch)
      const freshness = braveFreshness(input.recencyDays)
      if (freshness) url.searchParams.set('freshness', freshness)
      for (const [key, value] of Object.entries(braveLocaleParams(input.locale, input.region))) {
        url.searchParams.set(key, value)
      }
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new BraveSearchError(response.status)
      return { provider: 'brave', items: parseBraveResponse(await response.json()) }
    },
  }
}
