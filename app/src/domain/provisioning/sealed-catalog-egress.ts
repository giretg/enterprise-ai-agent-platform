/**
 * Katalógus-sablon fast-path: a tenant egress-allowlist szertartás nélkül
 * CSAK a szerveroldalon lezárt (parametermentes) sablon-hostok trustedek.
 *
 * A draft `egressHosts` / `baseUrl` mezői tenant-admin vagy agent által
 * szerkeszthetők — ezeket SOHA nem szabad „ismert sablon”-ként kezelni,
 * különben egy átírt baseUrl (pl. google-calendar + attacker host) üres
 * allowlist mellett is aktiválható, és a delegált OAuth Bearer idegen
 * hostra megy ki.
 */
import { BUILTIN_CONNECTOR_TEMPLATES } from '@/domain/connector-template/builtin-templates'
import { CUSTOM_CONNECTOR_TEMPLATES } from '@/domain/connector-template/custom-template-seeds'
import type { TemplateDescriptor } from '@/domain/connector-template/template-descriptor'

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function isParameterized(value: string): boolean {
  return value.includes('{')
}

function sealedHostsFromDescriptor(descriptor: TemplateDescriptor): string[] | null {
  if (isParameterized(descriptor.baseUrl) || descriptor.egressHosts.some(isParameterized)) {
    return null
  }
  const hosts = new Set<string>()
  for (const host of descriptor.egressHosts) hosts.add(host.toLowerCase())
  const baseHost = hostOf(descriptor.baseUrl)
  if (baseHost) hosts.add(baseHost)
  for (const method of descriptor.authMethods) {
    if (!('authUrl' in method)) continue
    for (const url of [method.authUrl, method.tokenUrl, method.userInfoUrl]) {
      if (typeof url !== 'string') continue
      const host = hostOf(url)
      if (host) hosts.add(host)
    }
  }
  return [...hosts]
}

function buildSealedCatalogEgressByTemplateKey(): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>()
  for (const descriptor of [...BUILTIN_CONNECTOR_TEMPLATES, ...CUSTOM_CONNECTOR_TEMPLATES]) {
    const sealed = sealedHostsFromDescriptor(descriptor)
    if (!sealed || sealed.length === 0) continue
    map.set(descriptor.key.toLowerCase(), sealed)
  }
  return map
}

const SEALED_CATALOG_EGRESS_BY_TEMPLATE_KEY = buildSealedCatalogEgressByTemplateKey()

/** Szerveroldalon lezárt egress-hostok a sablonkulcshoz; paraméteres / ismeretlen → üres. */
export function sealedCatalogEgressHosts(templateKey: string | null | undefined): string[] {
  if (!templateKey?.trim()) return []
  const sealed = SEALED_CATALOG_EGRESS_BY_TEMPLATE_KEY.get(templateKey.trim().toLowerCase())
  return sealed ? [...sealed] : []
}
