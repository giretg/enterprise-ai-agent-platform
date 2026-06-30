/**
 * Search provider adapter — cserélhető kereső-backend (Feature-spec §8.3, D-WS-7).
 * Az adapter NEM dönt policyről; csak a minimalizált queryt küldi ki és a nyers
 * választ normalizálja. Policy mindig a WebSearchPolicyService felelőssége.
 */
import type { ProviderSearchInput, ProviderSearchResponse, SearchProviderAdapter } from './web-search-types'

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
}

/**
 * Generikus HTTP-alapú adapter valódi kereső API-hoz (pl. Bing/Google Programmable
 * Search-kompatibilis JSON válasszal). A providerválasztás konfigurálható, az
 * üzleti logikába nincs beégetve külső függés (D-WS-7).
 */
export class HttpSearchProviderAdapter implements SearchProviderAdapter {
  constructor(private config: HttpSearchProviderConfig) {}

  async search(input: ProviderSearchInput): Promise<ProviderSearchResponse> {
    const url = new URL(this.config.apiUrl)
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
      return { provider: 'custom_search_api', items }
    } finally {
      clearTimeout(timeout)
    }
  }
}
