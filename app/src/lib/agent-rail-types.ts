import type { AgentActivity } from '@/lib/agent-activity'

/** Élő állapot a bal sáv kártyáin — a rail-state API válasza agentenként. */
export type AgentRailLiveStatus = 'busy' | 'wait' | 'idle' | 'off'

export type AgentRailBadge = {
  tone: 'wait' | 'new' | 'err' | 'muted'
  label: string
}

export type AgentRailCardState = {
  id: string
  name: string
  personaNickname: string | null
  avatarUrl: string | null
  status: string
  taskOnly: boolean
  /** Rövid előnézet a kártyán (max ~80 karakter). */
  roleLabel: string
  /** Teljes munkaköri leírás — hover-hinthez. */
  roleDescription: string
  liveStatus: AgentRailLiveStatus
  activityText: string
  elapsed: string | null
  /** Csak valós lépés-számból — nincs becsült százalék. */
  progress: { current: number; total: number } | null
  badges: AgentRailBadge[]
  /** Rendezéshez: vár rád → dolgozik → szabad → szünetel */
  sortRank: number
}

export type AgentRailStateResponse = {
  agents: AgentRailCardState[]
  /** Szerveridő ISO — poll/SSE szinkronhoz. */
  asOf: string
}

export type AgentWorkspaceTab = 'chat' | 'task' | 'board' | 'apps' | 'training' | 'profile'

export type AgentRailFilter = 'all' | AgentRailLiveStatus

/** UI-szűrő → élő állapot egyezés. */
export function railFilterMatches(filter: AgentRailFilter, liveStatus: AgentRailLiveStatus): boolean {
  if (filter === 'all') return true
  return filter === liveStatus
}

export function liveStatusFromActivity(
  agentStatus: string,
  activity: AgentActivity | undefined,
): AgentRailLiveStatus {
  if (agentStatus === 'suspended' || agentStatus === 'retired' || agentStatus === 'draft') {
    return 'off'
  }
  if (activity?.current?.needsYou || (activity?.awaitingHuman ?? 0) > 0) return 'wait'
  if (activity?.working) return 'busy'
  if (agentStatus === 'active') return 'idle'
  return 'off'
}

export function liveStatusSortRank(status: AgentRailLiveStatus): number {
  switch (status) {
    case 'wait':
      return 0
    case 'busy':
      return 1
    case 'idle':
      return 2
    case 'off':
      return 3
  }
}

export function liveStatusLabel(status: AgentRailLiveStatus): string {
  switch (status) {
    case 'busy':
      return 'Dolgozik'
    case 'wait':
      return 'Vár rád'
    case 'idle':
      return 'Szabad'
    case 'off':
      return 'Szünetel'
  }
}
