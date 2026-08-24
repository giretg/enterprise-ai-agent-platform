import type { AgentWorkspaceTab } from '@/lib/agent-rail-types'

type AgentWorkspaceTabDef = {
  label: string
  availability: 'conversational' | 'task-only' | 'all'
  renderer: 'client' | 'route'
}

const AGENT_WORKSPACE_TAB_DEFS: Record<AgentWorkspaceTab, AgentWorkspaceTabDef> = {
  chat: { label: 'Beszélgetés', availability: 'conversational', renderer: 'client' },
  task: { label: 'Indítás', availability: 'task-only', renderer: 'client' },
  board: { label: 'Feladatok', availability: 'all', renderer: 'route' },
  apps: { label: 'Mini-appok', availability: 'all', renderer: 'client' },
  training: { label: 'Tanítás', availability: 'all', renderer: 'route' },
  profile: { label: 'Adatlap', availability: 'all', renderer: 'route' },
}

export const AGENT_WORKSPACE_TABS = Object.keys(
  AGENT_WORKSPACE_TAB_DEFS,
) as AgentWorkspaceTab[]

export type AgentWorkspaceClientTab = 'chat' | 'task' | 'apps'
export type AgentWorkspaceRouteTab = Exclude<AgentWorkspaceTab, AgentWorkspaceClientTab>

/** Korlátozott agent: Indítás-fül, nincs chat. Beszélgetős: nincs Indítás-fül. Feladatok mindkettőn. */
export function workspaceTabsForAgent(taskOnly: boolean) {
  return AGENT_WORKSPACE_TABS.flatMap((key) => {
    const def = AGENT_WORKSPACE_TAB_DEFS[key]
    const visible =
      def.availability === 'all' ||
      (taskOnly ? def.availability === 'task-only' : def.availability === 'conversational')
    return visible ? [{ key, label: def.label }] : []
  })
}

export function defaultAgentWorkspaceTab(taskOnly: boolean): AgentWorkspaceTab {
  return taskOnly ? 'task' : 'chat'
}

const WORKSPACE_PATH = new RegExp(
  `^/control-plane/agents/([^/]+)/(${AGENT_WORKSPACE_TABS.join('|')})$`,
)

export function isAgentWorkspaceTab(value: string | null | undefined): value is AgentWorkspaceTab {
  return Boolean(value && Object.hasOwn(AGENT_WORKSPACE_TAB_DEFS, value))
}

export function isAgentWorkspaceRouteTab(tab: AgentWorkspaceTab): tab is AgentWorkspaceRouteTab {
  return AGENT_WORKSPACE_TAB_DEFS[tab].renderer === 'route'
}

export function isAgentWorkspaceClientTab(tab: AgentWorkspaceTab): tab is AgentWorkspaceClientTab {
  return AGENT_WORKSPACE_TAB_DEFS[tab].renderer === 'client'
}

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
  if (!isAgentWorkspaceTab(match[2])) return null
  return { agentId: match[1], tab: match[2] }
}
