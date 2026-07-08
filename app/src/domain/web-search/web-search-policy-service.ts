/**
 * Web Search policy + biztonsági kontrollok (Feature-spec — WebSearchTool §5).
 *
 * Determinisztikus, szerveroldali döntés — a query, a domain-szűrés és a
 * rate-limit sosem a modellre van bízva (I-WS-4, I-WS-8, I-WS-9).
 */
import { createHash } from 'node:crypto'
import { inspectPromptSensitivity } from '@/domain/gateway/sensitivity-router'
import type { WebSearchArgs, WebSearchAuthorizeDecision, WebSearchConnectorConfig } from './web-search-types'

export type WebSearchUsageContext = {
  /** Kill-switch (web_search.enabled) — Feature-spec §7.2, WS13. */
  enabled: boolean
  ticketQueryCount: number
  agentDayQueryCount: number
}

function queryHash(query: string): string {
  return createHash('sha256').update(query).digest('hex').slice(0, 16)
}

/**
 * Normalizált hostname-egyezés, punycode/IDN után. Wildcard csak balról
 * engedett (`*.example.com`); az nem fedi a csupasz `example.com`-ot — a
 * konfigban mindkettőt fel kell sorolni, ha mindkettő kell (§5.3).
 * `example.com.evil.tld` sosem illeszkedik `example.com`-ra (csak pontos
 * egyezés vagy bal-oldali wildcard-szuffix).
 */
export function normalizeHostname(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '')
}

export function domainMatchesPattern(host: string, pattern: string): boolean {
  const normalizedHost = normalizeHostname(host)
  const normalizedPattern = normalizeHostname(pattern)
  if (!normalizedHost || !normalizedPattern) return false

  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(1) // ".example.com"
    return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length
  }

  return normalizedHost === normalizedPattern
}

function matchesAny(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => domainMatchesPattern(host, pattern))
}

export class WebSearchPolicyService {
  /** Query-safety guard: PII/secret/kártyaadat gyanú esetén default blokk (D-WS-5). */
  classifyQuery(query: string): { blocked: boolean; category?: string } {
    const inspection = inspectPromptSensitivity([{ role: 'user', content: query }])
    if (inspection.level === 'clean') return { blocked: false }
    return { blocked: true, category: inspection.matchedCategory }
  }

  resolveEffectiveDomains(
    requested: string[] | undefined,
    config: WebSearchConnectorConfig,
  ): { domains: string[]; deniedDomainsMatched: string[]; reason?: 'domain_not_allowed' | 'domain_denied' } {
    const requestedList = (requested ?? []).map((d) => normalizeHostname(d)).filter(Boolean)

    const deniedDomainsMatched = requestedList.filter((d) => this.isDomainDenied(d, config))
    if (deniedDomainsMatched.length > 0) {
      return { domains: [], deniedDomainsMatched, reason: 'domain_denied' }
    }

    // A domains paraméter csak SZŰKÍTHETI a tenant allowlistet, nem bővítheti (§4.1)
    // — kivéve, ha a connector allowGeneralWeb-je engedélyezi a teljes webet, ekkor
    // az allowlist mellett bármely kért domain is megengedett.
    if (requestedList.length > 0) {
      const narrowed = requestedList.filter((d) => config.allowGeneralWeb || matchesAny(d, config.allowedDomains))
      if (narrowed.length === 0) {
        return { domains: [], deniedDomainsMatched: [], reason: 'domain_not_allowed' }
      }
      return { domains: narrowed, deniedDomainsMatched: [] }
    }

    // Nincs kért domain: allowGeneralWeb elsőbbséget élvez (korlátlan keresés),
    // különben az allowlist a hatályos domain-kör, ha van ilyen.
    if (config.allowGeneralWeb) {
      return { domains: [], deniedDomainsMatched: [] }
    }
    if (config.allowedDomains.length > 0) {
      return { domains: [...config.allowedDomains], deniedDomainsMatched: [] }
    }

    // Banki/PSP preset: nincs allowlist és nincs general web → nincs kereshető domain.
    return { domains: [], deniedDomainsMatched: [], reason: 'domain_not_allowed' }
  }

  isDomainDenied(domain: string, config: WebSearchConnectorConfig): boolean {
    return matchesAny(domain, config.deniedDomains)
  }

  /**
   * Determinisztikus authorize sorrend (§5.1, lépés 6-9 — a kapcsoló/capability/
   * connector-feloldás a ToolBrokerService szintjén, ez előtt már megtörtént).
   */
  authorize(
    input: WebSearchArgs,
    config: WebSearchConnectorConfig,
    usage: WebSearchUsageContext,
  ): WebSearchAuthorizeDecision {
    if (!usage.enabled) {
      return { allowed: false, reason: 'web_search_disabled', detail: 'web_search kill-switch active' }
    }

    const query = input.query.trim()
    if (!query) {
      return { allowed: false, reason: 'query_policy_blocked', detail: 'empty query' }
    }
    if (query.length > config.maxQueryLength) {
      return { allowed: false, reason: 'query_policy_blocked', detail: 'query exceeds maxQueryLength' }
    }

    const safety = this.classifyQuery(query)
    if (safety.blocked) {
      return {
        allowed: false,
        reason: 'query_policy_blocked',
        detail: `query matched sensitive category: ${safety.category ?? 'unknown'}`,
      }
    }

    const domainResolution = this.resolveEffectiveDomains(input.domains, config)
    if (domainResolution.reason) {
      return { allowed: false, reason: domainResolution.reason, detail: 'no domain in scope for this query' }
    }

    if (usage.ticketQueryCount >= config.maxQueriesPerTicket) {
      return { allowed: false, reason: 'rate_limited', detail: 'maxQueriesPerTicket exceeded' }
    }
    if (usage.agentDayQueryCount >= config.maxQueriesPerAgentDay) {
      return { allowed: false, reason: 'rate_limited', detail: 'maxQueriesPerAgentDay exceeded' }
    }

    // input.maxResults <= 0 nem érvényes "kérés" (a publikus zod-séma min(1)-et
    // ír elő) — defenzíven a configból vett alapértékre esünk vissza ahelyett,
    // hogy csendben 1-re vágnánk egy hibás 0-t.
    const maxResultsRequested =
      input.maxResults != null && input.maxResults > 0 ? input.maxResults : config.defaultMaxResults
    const maxResultsEffective = Math.max(1, Math.min(maxResultsRequested, config.hardMaxResults))

    const labels = ['allowed_domain']
    if (domainResolution.domains.length === 0 && config.allowGeneralWeb) labels.push('general_web')

    return {
      allowed: true,
      labels,
      effective: {
        query,
        domains: domainResolution.domains,
        recencyDays: input.recencyDays,
        locale: input.locale?.trim() || config.defaultLocale,
        maxResultsRequested,
        maxResultsEffective,
        purpose: input.purpose,
        queryHash: queryHash(query),
      },
    }
  }
}
