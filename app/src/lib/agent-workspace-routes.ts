import type { AgentWorkspaceTab } from '@/lib/agent-rail-types'

export const AGENT_WORKSPACE_TABS: readonly AgentWorkspaceTab[] = [
  'chat',
  'task',
  'board',
  'apps',
  'profile',
]

const WORKSPACE_TAB_ITEMS: { key: AgentWorkspaceTab; label: string }[] = [
  { key: 'chat', label: 'Beszélgetés' },
  { key: 'task', label: 'Indítás' },
  { key: 'board', label: 'Feladatok' },
  { key: 'apps', label: 'Mini-appok' },
  { key: 'profile', label: 'Adatlap' },
]

/** Korlátozott agent: Indítás-fül, nincs chat. Beszélgetős: nincs Indítás-fül. Feladatok mindkettőn. */
export function workspaceTabsForAgent(taskOnly: boolean) {
  return WORKSPACE_TAB_ITEMS.filter((item) =>
    taskOnly ? item.key !== 'chat' : item.key !== 'task',
  )
}

export function defaultAgentWorkspaceTab(taskOnly: boolean): AgentWorkspaceTab {
  return taskOnly ? 'task' : 'chat'
}

const WORKSPACE_PATH =
  /^\/control-plane\/agents\/([^/]+)\/(chat|task|board|apps|profile)$/

export function agentWorkspacePath(agentId: string, tab: AgentWorkspaceTab): string {
  return `/control-plane/agents/${agentId}/${tab}`
}

export function isAgentWorkspacePath(pathname: string): boolean {
  return WORKSPACE_PATH.test(pathname)
}

export function parseAgentWorkspacePath(
  pathname: string,
): { agentId: string; tab: AgentWorkspaceTab } | null {
  const match = pathname.match(WORKSPACE_PATH)
  if (!match) return null
  return { agentId: match[1], tab: match[2] as AgentWorkspaceTab }
}
