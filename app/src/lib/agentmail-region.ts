/**
 * AgentMail régió-katalógus — kliens-biztos (nincs node:fs / Secret Manager).
 * A `@/lib/agentmail` szerver-modult a böngésző nem importálhatja: a Firebase
 * `next build` belebukik a connector-secret-store `node:fs/promises` húzásán.
 */
export type AgentMailRegion = 'eu' | 'global'

export const AGENTMAIL_REGIONS: Record<
  AgentMailRegion,
  { apiBase: string; host: string; label: string }
> = {
  eu: { apiBase: 'https://api.agentmail.eu/v0', host: 'api.agentmail.eu', label: 'EU (api.agentmail.eu)' },
  global: { apiBase: 'https://api.agentmail.to/v0', host: 'api.agentmail.to', label: 'Global (api.agentmail.to)' },
}

export function parseAgentMailRegion(value: unknown): AgentMailRegion {
  return value === 'global' ? 'global' : 'eu'
}
