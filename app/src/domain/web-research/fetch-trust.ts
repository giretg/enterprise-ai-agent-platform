/**
 * Fetch-trust predikátum: egy host akkor tölthető le, ha official/vendor_doc,
 * vagy a tenant web-search `allowedDomains` mintája illeszkedik. A deny-lista
 * mindkét ágat felülírja. Az `allowGeneralWeb` NEM ad fetch-jogot.
 */
import { matchForbiddenHost } from '@/domain/net/egress-guard'
import { domainMatchesPattern, normalizeHostname } from '@/domain/web-search/web-search-policy-service'

export type FetchTrustPolicy = {
  allowedDomains: string[]
  deniedDomains: string[]
}

export const FETCH_TRUSTED_SOURCE_TYPES = new Set(['official', 'vendor_doc'])

export function isHostDenied(host: string, policy: FetchTrustPolicy): boolean {
  const normalized = normalizeHostname(host)
  if (!normalized) return false
  return policy.deniedDomains.some((pattern) => domainMatchesPattern(normalized, pattern))
}

export function isFetchTrusted(input: {
  host: string
  sourceType: string
  policy: FetchTrustPolicy
}): boolean {
  const host = normalizeHostname(input.host)
  if (!host) return false
  if (isHostDenied(host, input.policy)) return false
  if (FETCH_TRUSTED_SOURCE_TYPES.has(input.sourceType)) return true
  return input.policy.allowedDomains.some((pattern) => domainMatchesPattern(host, pattern))
}

/** A kutatási ág per-hívásos egress-listája: platform-lista ∪ fetch-trusted hostok. Nem perzisztál. */
export function mergeResearchAllowlistHosts(
  platformHosts: Iterable<string>,
  trustedHosts: Iterable<string>,
): string[] {
  return [
    ...new Set(
      [...platformHosts, ...trustedHosts]
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
}

/**
 * Connector `allowedDomains` mentéskori SSRF-szűrő: nyers IP, localhost,
 * metadata-host, ismert exfil-sink, `*.internal` / `.local`.
 */
export function matchForbiddenDomainPattern(pattern: string): string | null {
  const normalized = normalizeHostname(pattern)
  if (!normalized) return 'invalid_host'
  const host = normalized.startsWith('*.') ? normalized.slice(2) : normalized
  if (!host) return 'invalid_host'
  if (host === 'internal' || host.endsWith('.internal')) return 'internal_host'
  if (host === 'local' || host.endsWith('.local')) return 'local_host'
  return matchForbiddenHost(host) ?? matchForbiddenHost(normalized)
}

export function findForbiddenAllowedDomain(domains: string[]): { pattern: string; reason: string } | null {
  for (const pattern of domains) {
    const reason = matchForbiddenDomainPattern(pattern)
    if (reason) return { pattern, reason }
  }
  return null
}
