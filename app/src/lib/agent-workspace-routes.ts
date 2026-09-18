import type { AgentWorkspaceTab } from '@/lib/agent-rail-types'

export function agentWorkspacePath(agentId: string, _tab?: AgentWorkspaceTab): string {
  return `/control-plane/agents/${agentId}`
}

export function defaultAgentWorkspaceTab(_taskOnly?: boolean): AgentWorkspaceTab {
  return 'profile'
}

export function parseAgentWorkspacePath(
  pathname: string,
): { agentId: string; tab: AgentWorkspaceTab } | null {
  const match = pathname.match(/^\/control-plane\/agents\/([^/]+)/)
  if (!match?.[1] || match[1] === 'new') return null
  return { agentId: match[1], tab: 'profile' }
}

export function isAgentWorkspacePath(pathname: string): boolean {
  return parseAgentWorkspacePath(pathname) !== null
}

export function workspaceTabsForAgent(_taskOnly?: boolean): Array<{ key: AgentWorkspaceTab; label: string }> {
  return [{ key: 'profile', label: 'Profil' }]
}
