export const DEFAULT_AGENT_WORKSPACE_FALLBACK = '/control-plane/agents'

export async function resolveDefaultAgentWorkspacePath(): Promise<string> {
  return DEFAULT_AGENT_WORKSPACE_FALLBACK
}
