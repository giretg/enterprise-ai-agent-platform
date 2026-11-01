const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Beszélgetés indítása egy adott munkatárssal a platform-chatben. */
export function platformChatHref(agentId: string): string {
  return `/control-plane/chat?agent=${encodeURIComponent(agentId)}`
}

export function parsePlatformChatAgentParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw || !AGENT_ID_RE.test(raw)) return null
  return raw
}

/** A kártya / adatlap gombja: tenant + agent kapcsoló, és a munkatárs MCP-n elérhető. */
export function canStartPlatformChat(input: {
  tenantEnabled: boolean
  platformChatEnabled: boolean
  status: string
  currentDefinitionVersionId: string | null
}): boolean {
  return (
    input.tenantEnabled &&
    input.platformChatEnabled &&
    input.status === 'active' &&
    Boolean(input.currentDefinitionVersionId)
  )
}

export function pickPlatformChatAgentId(
  agents: ReadonlyArray<{ agentId: string }>,
  requested: string | null | undefined,
): string | null {
  if (requested && agents.some((agent) => agent.agentId === requested)) return requested
  return agents[0]?.agentId ?? null
}
