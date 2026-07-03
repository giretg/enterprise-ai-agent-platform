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

import { isIP } from 'node:net'

/**
 * SSRF-tiltott host-minták — ugyanaz az osztály, mint a determinisztikus
 * draft-validátorban (nyers IP, localhost-osztály, felhő-metadata, ismert exfil-sink).
 * Névvel, hogy a blokk-ok determinisztikusan auditálható (`reason`) legyen.
 */
export const FORBIDDEN_HOST_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'localhost_host', pattern: /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i },
  { name: 'metadata_host', pattern: /(169\.254\.169\.254|metadata\.google\.internal)/i },
  { name: 'known_exfil_sink', pattern: /(webhook\.site|requestbin|ngrok\.io|burpcollaborator)/i },
]

function normalizeIpLiteral(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
}

function isIpLiteralHost(host: string): boolean {
  return isIP(normalizeIpLiteral(host)) !== 0
}

/** A tiltott host-minta neve, ha van találat; különben `null`. */
export function matchForbiddenHost(host: string): string | null {
  const h = host.trim().toLowerCase()
  if (isIpLiteralHost(h)) return 'raw_ip_host'
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
 * IPv4: RFC1918, loopback, link-local/metadata, CGNAT, dokumentációs/benchmark/
 * multicast/reserved tartományok.
 * IPv6: loopback/unspecified, ULA, link-local, multicast, dokumentációs/transition
 * prefixek, IPv4-mapped/compatible/NAT64 alakok a beágyazott IPv4-re visszavezetve.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const addr = normalizeIpLiteral(ip)

  if (addr.includes(':')) {
    return isPrivateOrReservedIpv6(addr)
  }

  const ipv4 = parseIpv4ToInt(addr)
  if (ipv4 == null) return false
  return isPrivateOrReservedIpv4Int(ipv4)
}

function parseIpv4ToInt(addr: string): number | null {
  const octets = addr.split('.')
  if (octets.length !== 4) return null
  const nums = octets.map((o) => Number(o))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums.reduce((acc, n) => acc * 256 + n, 0) >>> 0
}

function ipv4InCidr(ip: number, base: string, prefix: number): boolean {
  const baseInt = parseIpv4ToInt(base)
  if (baseInt == null) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ip & mask) === (baseInt & mask)
}

function isPrivateOrReservedIpv4Int(ip: number): boolean {
  return [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ].some(([base, prefix]) => ipv4InCidr(ip, base as string, prefix as number))
}

function ipv4IntToDotted(ip: number): string {
  return `${(ip >>> 24) & 255}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`
}

function ipv4ToHextets(ip: string): [string, string] | null {
  const parsed = parseIpv4ToInt(ip)
  if (parsed == null) return null
  return [((parsed >>> 16) & 0xffff).toString(16), (parsed & 0xffff).toString(16)]
}

function parseIpv6ToBigInt(addr: string): bigint | null {
  const dotted = addr.match(/(.+:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) {
    const parts = ipv4ToHextets(dotted[2])
    if (!parts) return null
    addr = `${dotted[1]}${parts[0]}:${parts[1]}`
  }

  const halves = addr.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0
  if (missing < 0) return null
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left
  if (groups.length !== 8) return null

  let value = BigInt(0)
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    value = (value << BigInt(16)) + BigInt(parseInt(group, 16))
  }
  return value
}

function ipv6InCidr(ip: bigint, base: string, prefix: number): boolean {
  const baseInt = parseIpv6ToBigInt(base)
  if (baseInt == null) return false
  const shift = BigInt(128 - prefix)
  return (ip >> shift) === (baseInt >> shift)
}

function embeddedIpv4FromIpv6(ip: bigint, prefixBase: string, prefix: number): string | null {
  if (!ipv6InCidr(ip, prefixBase, prefix)) return null
  const embedded = Number(ip & BigInt(0xffffffff)) >>> 0
  return ipv4IntToDotted(embedded)
}

function isPrivateOrReservedIpv6(addr: string): boolean {
  const ip = parseIpv6ToBigInt(addr)
  if (ip == null) return false

  const mapped = embeddedIpv4FromIpv6(ip, '::ffff:0:0', 96)
  if (mapped) return isPrivateOrReservedIp(mapped)

  const compatible = embeddedIpv4FromIpv6(ip, '::', 96)
  if (compatible) return true

  const nat64 = embeddedIpv4FromIpv6(ip, '64:ff9b::', 96)
  if (nat64 && isPrivateOrReservedIp(nat64)) return true

  return [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ].some(([base, prefix]) => ipv6InCidr(ip, base as string, prefix as number))
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
