/**
 * Search provider adapter — cserélhető kereső-backend (Feature-spec §8.3, D-WS-7).
 * Az adapter NEM dönt policyről; csak a minimalizált queryt küldi ki és a nyers
 * választ normalizálja. Policy mindig a WebSearchPolicyService felelőssége.
 */
import type {
  ProviderSearchInput,
  ProviderSearchResponse,
  ProviderSearchResultItem,
  SearchProviderAdapter,
} from './web-search-types'

/** Brave freshness kódok — recencyDays nem küldhető „Nd” formában (422). */
export function mapRecencyDaysToBraveFreshness(recencyDays: number): string | undefined {
  if (recencyDays <= 0) return undefined
  if (recencyDays <= 1) return 'pd'
  if (recencyDays <= 7) return 'pw'
  if (recencyDays <= 31) return 'pm'
  if (recencyDays <= 365) return 'py'
  return 'py'
}

/** Brave Web Search `country` enum — HU és sok más ISO kód nincs benne (422). */
export const BRAVE_SUPPORTED_COUNTRIES = new Set([
  'AR',
  'AU',
  'AT',
  'BE',
  'BR',
  'CA',
  'CL',
  'DK',
  'FI',
  'FR',
  'DE',
  'GR',
  'HK',
  'IN',
  'ID',
  'IT',
  'JP',
  'KR',
  'MY',
  'MX',
  'NL',
  'NZ',
  'NO',
  'CN',
  'PL',
  'PT',
  'PH',
  'RU',
  'SA',
  'ZA',
  'ES',
  'SE',
  'CH',
  'TW',
  'TR',
  'GB',
  'US',
  'ALL',
])

export function braveLocaleParams(
  locale: string,
  region: string,
): { search_lang?: string; country?: string } {
  const trimmedLocale = locale.trim()
  const trimmedRegion = region.trim()
  const params: { search_lang?: string; country?: string } = {}
  if (trimmedLocale) {
    const lang = trimmedLocale.includes('-') ? trimmedLocale.split('-')[0] : trimmedLocale
    params.search_lang = lang.toLowerCase()
  }
  if (trimmedRegion.length === 2) {
    const country = trimmedRegion.toUpperCase()
    if (BRAVE_SUPPORTED_COUNTRIES.has(country)) {
      params.country = country
    }
  }
  return params
}

type BraveSearchResultRow = {
  title: string
  url: string
  description: string
  page_age?: string
  published?: string
}

/** Brave Web Search API válasz — a találatok a `web.results` alatt érkeznek. */
export function parseBraveSearchResponse(body: unknown): ProviderSearchResultItem[] {
  const record = body as {
    web?: { results?: BraveSearchResultRow[] }
    results?: BraveSearchResultRow[]
  }
  const rows = record.web?.results ?? record.results ?? []
  return rows.map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.description,
    publishedAt: item.page_age ?? item.published,
  }))
}

async function readSearchProviderErrorDetail(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as {
      error?: { detail?: string; code?: string; meta?: { errors?: Array<{ msg?: string; loc?: unknown[] }> } }
    }
    const parts: string[] = []
    if (body.error?.code) parts.push(body.error.code)
    if (body.error?.detail) parts.push(body.error.detail)
    const first = body.error?.meta?.errors?.[0]
    if (first?.msg) {
      const loc = Array.isArray(first.loc) ? first.loc.join('.') : ''
      parts.push(loc ? `${loc}: ${first.msg}` : first.msg)
    }
    return parts.length > 0 ? parts.join(' — ') : null
  } catch {
    return null
  }
}

/**
 * Determinisztikus dev/acceptance stub — nincs valódi kimenő hálózati hívás
 * (Feature-spec §13 WS-B: "Stub provider determinisztikus találatokkal").
 */
export class StubSearchProviderAdapter implements SearchProviderAdapter {
  async search(input: ProviderSearchInput): Promise<ProviderSearchResponse> {
    const domains = input.domains.length > 0 ? input.domains : ['example.com']
    const count = Math.max(1, Math.min(input.maxResults, domains.length * 3))
    const items = Array.from({ length: count }, (_, i) => {
      const domain = domains[i % domains.length]
      return {
        title: `${input.query} — eredmény ${i + 1} (${domain})`,
        url: `https://${domain}/search-result-${i + 1}`,
        snippet: `Stub találat a(z) "${input.query}" keresésre a ${domain} domainen (dev/teszt provider, nincs valódi kimenő hívás).`,
        publishedAt: undefined,
      }
    })

    return { provider: 'stub', items }
  }
}

export type HttpSearchProviderConfig = {
  apiUrl: string
  apiKey?: string
  providerName?: 'custom_search_api' | 'platform_hosted_search' | 'brave'
  providerType?: 'bing' | 'brave' // az URL alapján inference, vagy explicit
}

/**
 * Generikus HTTP-alapú adapter valódi kereső API-hoz (pl. Bing/Google Programmable
 * Search-kompatibilis JSON válasszal). A providerválasztás konfigurálható, az
 * üzleti logikába nincs beégetve külső függés (D-WS-7).
 */
export class HttpSearchProviderAdapter implements SearchProviderAdapter {
  private providerType: 'bing' | 'brave'

  constructor(private config: HttpSearchProviderConfig) {
    this.providerType = this.config.providerType ?? this.inferProviderType()
  }

  private inferProviderType(): 'bing' | 'brave' {
    if (this.config.apiUrl.includes('brave')) return 'brave'
    if (this.config.apiUrl.includes('bing')) return 'bing'
    return 'bing'
  }

  async search(input: ProviderSearchInput): Promise<ProviderSearchResponse> {
    const url = new URL(this.config.apiUrl)

    if (this.providerType === 'brave') {
      return this.searchBrave(url, input)
    } else {
      return this.searchBing(url, input)
    }
  }

  private async searchBing(url: URL, input: ProviderSearchInput): Promise<ProviderSearchResponse> {
    url.searchParams.set('q', input.query)
    url.searchParams.set('count', String(input.maxResults))
    url.searchParams.set('mkt', input.locale)
    url.searchParams.set('safeSearch', input.safeSearch === 'strict' ? 'Strict' : 'Moderate')
    if (input.domains.length > 0) {
      url.searchParams.set('domains', input.domains.join(','))
    }
    if (input.recencyDays) {
      url.searchParams.set('freshnessDays', String(input.recencyDays))
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(url.toString(), {
        headers: this.config.apiKey ? { 'Ocp-Apim-Subscription-Key': this.config.apiKey } : undefined,
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`search provider HTTP ${response.status}`)
      }
      const body = (await response.json()) as {
        webPages?: { value?: Array<{ name: string; url: string; snippet: string; datePublished?: string }> }
      }
      const items = (body.webPages?.value ?? []).map((item) => ({
        title: item.name,
        url: item.url,
        snippet: item.snippet,
        publishedAt: item.datePublished,
      }))
      return { provider: this.config.providerName ?? 'custom_search_api', items }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async searchBrave(url: URL, input: ProviderSearchInput): Promise<ProviderSearchResponse> {
    url.searchParams.set('q', input.query)
    url.searchParams.set('count', String(input.maxResults))
    url.searchParams.set('safesearch', input.safeSearch === 'strict' ? 'strict' : 'moderate')
    const freshness = input.recencyDays ? mapRecencyDaysToBraveFreshness(input.recencyDays) : undefined
    if (freshness) {
      url.searchParams.set('freshness', freshness)
    }
    const { search_lang, country } = braveLocaleParams(input.locale, input.region)
    if (search_lang) url.searchParams.set('search_lang', search_lang)
    if (country) url.searchParams.set('country', country)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache',
          ...(this.config.apiKey ? { 'X-Subscription-Token': this.config.apiKey } : {}),
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = await readSearchProviderErrorDetail(response)
        throw new Error(`search provider HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      const items = parseBraveSearchResponse(await response.json())
      return { provider: this.config.providerName ?? 'brave', items }
    } finally {
      clearTimeout(timeout)
    }
  }
}
