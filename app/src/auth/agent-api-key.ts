import { repositories } from '@/repositories/postgres'

export type AgentAuthContext = {
  agentId: string
  scopes: string[]
}

export async function authenticateAgentRequest(
  authorization: string | null,
): Promise<AgentAuthContext | null> {
  if (!authorization?.startsWith('Bearer ')) return null
  const rawKey = authorization.slice('Bearer '.length).trim()
  if (!rawKey) return null
  return repositories.agents.authenticateApiKey(rawKey)
}

export function requireAgentScope(auth: AgentAuthContext, scope: string) {
  if (!auth.scopes.includes(scope)) {
    throw new Error(`Missing scope: ${scope}`)
  }
}
