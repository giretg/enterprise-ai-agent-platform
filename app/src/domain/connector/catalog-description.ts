/**
 * Secret-mentes connector-katalógus leírás (agent választó, admin UI).
 * Önfrissítőnél a capability snapshot; fix http_api-nál a config.
 */

export type ConnectorCatalogMeta = {
  description: string | null
  baseUrl: string | null
  tools: Array<{ method: string; path: string; description?: string | null }>
}

function trimText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text.slice(0, max) : null
}

export function describeConnectorCatalog(
  type: string,
  config: unknown,
  capabilitySet: unknown,
): ConnectorCatalogMeta {
  if (type === 'gmail') {
    return {
      description: 'Gmail-fiók olvasása és írása a felhasználó nevében, engedélyhez kötve.',
      baseUrl: null,
      tools: [],
    }
  }
  if (type === 'code_sandbox') {
    const cfg = config as Record<string, unknown> | null
    const baseUrl = typeof cfg?.baseUrl === 'string' ? cfg.baseUrl : null
    return {
      description:
        'Izolált külső doboz, ahol az agent által írt kód fut. A platform-adatok csak a futtatás bemenetén kerülnek be.',
      baseUrl,
      tools: [],
    }
  }
  const cfg = (capabilitySet ?? config) as Record<string, unknown> | null
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { description: null, baseUrl: null, tools: [] }
  }
  const baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl : null
  const provider = typeof cfg.provider === 'string' ? cfg.provider : null
  const apiDescription = trimText(cfg.description, 500)
  const rawTools = Array.isArray(cfg.proposedTools)
    ? cfg.proposedTools
    : Array.isArray(cfg.endpoints)
      ? cfg.endpoints
      : []
  const tools = rawTools
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map((t) => ({
      method: String(t.method ?? ''),
      path: String(t.path ?? ''),
      ...(typeof t.description === 'string' && t.description.trim()
        ? { description: t.description.trim().slice(0, 300) }
        : {}),
    }))
    .filter((t) => t.method && t.path)
    .slice(0, 50)
  if (apiDescription) {
    return { description: apiDescription, baseUrl, tools }
  }
  if (tools.length === 0) {
    if (!provider && !baseUrl) return { description: null, baseUrl, tools: [] }
    return {
      description: [provider, baseUrl].filter(Boolean).join(' · ') || null,
      baseUrl,
      tools: [],
    }
  }
  const withDesc = tools.filter((t) => t.description).length
  const head =
    withDesc > 0
      ? tools
          .filter((t) => t.description)
          .slice(0, 2)
          .map((t) => t.description as string)
          .join(' ')
          .slice(0, 300)
      : `${tools.length} művelet${provider ? ` · ${provider}` : ''}${baseUrl ? ` · ${baseUrl}` : ''}`
  return { description: head || null, baseUrl, tools }
}
