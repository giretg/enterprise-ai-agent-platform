/** Agent-saját KB tár belső neve: `kb:{agentUuid}` — UI-ban ne ez jelenjen meg. */
const AGENT_OWNED_KB_CONNECTOR_NAME =
  /^kb:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const AGENT_OWNED_KB_CONNECTOR_DISPLAY_LABEL = 'Saját tudásbázis kapcsolat'

export function connectorDisplayLabel(type: string, name: string, config?: unknown): string {
  if (type === 'knowledge_base' && AGENT_OWNED_KB_CONNECTOR_NAME.test(name)) {
    return AGENT_OWNED_KB_CONNECTOR_DISPLAY_LABEL
  }
  // #946: a Control Plane-en létrehozott (közös / privát) tudásbázis neve a configban él.
  if (type === 'knowledge_base' && /^kb:(shared|private):/.test(name)) {
    const displayName =
      config && typeof config === 'object' && !Array.isArray(config)
        ? (config as Record<string, unknown>).displayName
        : null
    return typeof displayName === 'string' && displayName.trim() ? displayName.trim() : 'Tudásbázis'
  }
  return name
}
