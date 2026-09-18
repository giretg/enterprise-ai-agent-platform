/**
 * Önfrissítő connector — capability-set reprezentáció (Dev-Spec §4).
 *
 * A "capability-set" a nyers spec-pillanatképből KIPARSE-OLT, strukturált képességlista:
 * a broker és a diff ezt érti (nem a nyers OpenAPI-t). A tárolt alak a meglévő
 * `ConnectorConfig` (a provisioning OpenAPI-extractor kimenete) — így a runtime
 * http-api-kliens és a sablon-katalógus reprezentációja változatlanul újrahasznált.
 *
 * Ez a modul TISZTA: nincs DB, nincs hálózat. A verzió `capability_set` JSON-je
 * ebből az alakból (`CapabilitySet`) áll elő, és ide is olvasható vissza.
 */
import {
  connectorConfigSchema,
  type ConnectorConfig,
  type ProposedTool,
  type HttpMethod,
} from '@/domain/provisioning/connector-config'

/**
 * A tárolt capability-set = a normalizált `ConnectorConfig`. Külön típusaliasként
 * tartjuk, hogy a self-update réteg szándéka olvasható legyen a hívási helyeken.
 */
export type CapabilitySet = ConnectorConfig

/** Egy capability (végpont) stabil azonosítója a diffhez: `"METHOD /path"`. */
export type OpKey = string

export function opKey(method: HttpMethod | string, path: string): OpKey {
  return `${String(method).toUpperCase()} ${path}`
}

export function opKeyOf(tool: ProposedTool): OpKey {
  return opKey(tool.method, tool.path)
}

/** A capability-set végpontjai opKey → tool indexben (dedup: első nyer, a diff stabil). */
export function indexCapabilities(set: CapabilitySet): Map<OpKey, ProposedTool> {
  const index = new Map<OpKey, ProposedTool>()
  for (const tool of set.proposedTools ?? []) {
    const key = opKeyOf(tool)
    if (!index.has(key)) index.set(key, tool)
  }
  return index
}

/**
 * A tárolt JSON visszaolvasása typed CapabilitySet-té. Fail-closed: ha a tárolt
 * alak nem illik a sémára, `null` — a hívó ilyenkor NEM enged futásidejű hívást.
 */
export function parseCapabilitySet(value: unknown): CapabilitySet | null {
  const parsed = connectorConfigSchema.safeParse(value)
  return parsed.success ? (parsed.data as CapabilitySet) : null
}

/**
 * A capability-set → futásidejű endpoint-allowlist a broker http-api-kliensnek (A3).
 * A rögzített verzió képességei EZ, és csak ez, hívható; `restrictToEndpoints` mindig
 * true (a self-updating connector lényege, hogy a lista az engedélylista is).
 */
export function capabilitySetToRuntimeEndpoints(
  set: CapabilitySet,
): Array<Pick<ProposedTool, 'method' | 'path' | 'description' | 'idempotent' | 'access' | 'parameters' | 'pagination'>> {
  return (set.proposedTools ?? []).map((tool) => ({
    method: tool.method,
    path: tool.path,
    access: tool.access,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.idempotent ? { idempotent: true } : {}),
    ...(tool.parameters ? { parameters: tool.parameters } : {}),
    ...(tool.pagination ? { pagination: tool.pagination } : {}),
  }))
}
