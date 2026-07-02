/**
 * Közös, determinisztikus egress-őr (Feature-spec — WebFetch-Egress §3.1 „A" réteg,
 * §7.1). Egy helyen a kimenő-hálózati védelem: SSRF-tiltott host-osztályok,
 * feloldás-utáni privát/reserved IP re-check (DNS-rebinding), és a deny-by-default
 * egress-allowlist. NEM az LLM-re bízott döntés — sima szerveroldali kód, ami
 * minden `web_fetch` (és a sandbox-connection-tester) hívásnál lefut.
 *
 * Iparági megfelelés: OWASP SSRF Prevention Cheat Sheet (privát IP-tartományok,
 * felhő-metadata host, DNS-rebinding, séma-korlát) + az Anthropic `web_fetch`
 * `allowed_domains`/`blocked_domains` modellje.
 *
 * A modul SZÁNDÉKOSAN nem végez maga hálózati hívást — a DNS-feloldó (`resolveHostIps`)
 * injektálható, így a determinisztikus tesztek hálózat nélkül futnak, élesben pedig a
 * node `dns` rétege köti be.
 */

/**
 * SSRF-tiltott host-minták — ugyanaz az osztály, mint a determinisztikus
 * draft-validátorban (nyers IP, localhost-osztály, felhő-metadata, ismert exfil-sink).
 * Névvel, hogy a blokk-ok determinisztikusan auditálható (`reason`) legyen.
 */
export const FORBIDDEN_HOST_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'raw_ip_host', pattern: /^\d{1,3}(\.\d{1,3}){3}$/ },
  { name: 'localhost_host', pattern: /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i },
  { name: 'metadata_host', pattern: /(169\.254\.169\.254|metadata\.google\.internal)/i },
  { name: 'known_exfil_sink', pattern: /(webhook\.site|requestbin|ngrok\.io|burpcollaborator)/i },
]

/** A tiltott host-minta neve, ha van találat; különben `null`. */
export function matchForbiddenHost(host: string): string | null {
  const h = host.toLowerCase()
  for (const rule of FORBIDDEN_HOST_PATTERNS) {
    if (rule.pattern.test(h)) return rule.name
  }
  return null
}

/** Kényelmi boolean a sandbox-connection-tester meglévő hívási helyéhez. */
export function isForbiddenHost(host: string): boolean {
  return matchForbiddenHost(host) !== null
}

/**
 * Egy feloldott IP privát/loopback/link-local/reserved-e (OWASP SSRF Cheat Sheet).
 * IPv4: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0/8, 100.64/10 (CGNAT).
 * IPv6: ::1 (loopback), fc00::/7 (ULA), fe80::/10 (link-local), és a
 * ::ffff:0:0/96 IPv4-mapped alak (a beágyazott IPv4-re visszavezetve).
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase()

  // IPv4-mapped IPv6 (pl. ::ffff:169.254.169.254) → a beágyazott IPv4-et vizsgáljuk.
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mapped) return isPrivateOrReservedIp(mapped[1])

  if (addr.includes(':')) {
    // IPv6
    if (addr === '::1' || addr === '::') return true
    if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true // fc00::/7 (ULA)
    if (/^fe[89ab][0-9a-f]:/.test(addr)) return true // fe80::/10 (link-local)
    return false
  }

  const octets = addr.split('.')
  if (octets.length !== 4) return false
  const nums = octets.map((o) => Number(o))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = nums
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true // link-local / cloud-metadata
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  return false
}

export type EgressBlockReason =
  | 'invalid_url'
  | 'scheme_blocked'
  | 'ssrf_blocked'
  | 'egress_not_allowlisted'

export type EgressGuardResult =
  | { ok: true; host: string; url: string }
  | { ok: false; reason: EgressBlockReason; detail?: string }

export type EgressGuardInput = {
  url: string
  /** A megengedett cél-hostnevek (deny-by-default). Pontos hostname-egyezés, kisbetűsítve. */
  allowlistHosts: Iterable<string>
  /**
   * DNS-feloldó (injektálható). Ha megadva, a feloldott IP-ket re-checkeljük a
   * privát/reserved tartományok ellen (DNS-rebinding elleni feloldás-utáni ellenőrzés).
   * Ha nincs megadva, csak a host-minta alapú SSRF-szűrés fut (determinisztikus teszt).
   */
  resolveHostIps?: (host: string) => Promise<string[]>
}

/**
 * A kimenő URL determinisztikus ellenőrzése a fetch pillanata ELŐTT (§7.2/3–5):
 *   3. séma: csak https;
 *   4. SSRF-őr: tiltott host-minta + feloldás-utáni privát/reserved IP;
 *   5. egress-allowlist: deny-by-default, pontos hostname-egyezés.
 *
 * A hívó (`web_fetch`) a `reason`-t 1:1 audit `web_fetch.blocked` eseményre képezi.
 * A `redirect: 'manual'` utáni cél-hostot ugyanezzel a függvénnyel kell újra átfuttatni.
 */
export async function guardEgressUrl(input: EgressGuardInput): Promise<EgressGuardResult> {
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }

  // (3) Séma: csak https. http/file:/data:/ftp: elutasítva.
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'scheme_blocked', detail: parsed.protocol.replace(':', '') }
  }

  const host = parsed.hostname.toLowerCase()

  // (4a) SSRF host-minta (nyers IP, localhost, metadata, exfil-sink).
  const forbidden = matchForbiddenHost(host)
  if (forbidden) {
    return { ok: false, reason: 'ssrf_blocked', detail: forbidden }
  }

  // (5) Egress deny-by-default: a hostnak a megadott allowliston kell lennie.
  const allow = new Set<string>()
  for (const h of input.allowlistHosts) allow.add(h.toLowerCase())
  if (!allow.has(host)) {
    return { ok: false, reason: 'egress_not_allowlisted', detail: host }
  }

  // (4b) DNS-rebinding: feloldás-utáni privát/reserved IP re-check (ha van feloldó).
  if (input.resolveHostIps) {
    let ips: string[]
    try {
      ips = await input.resolveHostIps(host)
    } catch {
      return { ok: false, reason: 'ssrf_blocked', detail: 'dns_resolution_failed' }
    }
    if (ips.length === 0) {
      return { ok: false, reason: 'ssrf_blocked', detail: 'dns_no_address' }
    }
    for (const ip of ips) {
      if (isPrivateOrReservedIp(ip)) {
        return { ok: false, reason: 'ssrf_blocked', detail: 'resolved_private_ip' }
      }
    }
  }

  return { ok: true, host, url: parsed.toString() }
}
