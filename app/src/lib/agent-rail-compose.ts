import type { Agent } from '@prisma/client'
import { summarizeAgentActivity, type AgentActivity } from '@/lib/agent-activity'
import { agentDisplayName } from '@/lib/agent-persona'
import { stripMarkdownForPreview } from '@/lib/markdown-text'
import type { ActiveRun } from '@/lib/active-runs'
import {
  liveStatusFromActivity,
  liveStatusSortRank,
  type AgentRailBadge,
  type AgentRailCardState,
} from '@/lib/agent-rail-types'

function roleDescriptionFor(agent: Agent): string {
  const instruction = agent.roleInstruction?.trim()
  if (!instruction) return 'Munkatárs'
  const preview = stripMarkdownForPreview(instruction)
  return preview || 'Munkatárs'
}

function roleLabelFor(agent: Agent): string {
  const full = roleDescriptionFor(agent)
  if (full === 'Munkatárs' || full.length <= 80) return full
  return full.slice(0, 80)
}

function badgesFor(agent: Agent, activity: AgentActivity | undefined): AgentRailBadge[] {
  const badges: AgentRailBadge[] = []
  const awaiting = activity?.awaitingHuman ?? 0
  if (awaiting > 0) {
    badges.push({
      tone: 'wait',
      label: awaiting === 1 ? 'Jóváhagyásra vár' : `${awaiting} jóváhagyás vár`,
      ...(activity?.attentionHref ? { href: activity.attentionHref } : {}),
    })
  }
  if (agent.status === 'suspended') {
    badges.push({ tone: 'err', label: 'leállítva' })
  }
  return badges
}

function activityTextFor(
  agent: Agent,
  activity: AgentActivity | undefined,
  liveStatus: AgentRailCardState['liveStatus'],
): string {
  if (liveStatus === 'wait') {
    if (activity?.current?.needsYou) {
      const label = activity.current.label.toLowerCase()
      if (label.includes('kérdés') || label.includes('info')) return 'Kérdést tett fel'
      // A „Jóváhagyásra vár” a badge pill — itt a konkrét ügy címe, ne ismétlődjön.
      const title = activity.current.title?.trim()
      return title || 'Döntésre vár'
    }
    return 'Válaszra vár'
  }
  if (liveStatus === 'busy' && activity?.current) {
    return activity.current.title
  }
  if (liveStatus === 'off') {
    if (agent.status === 'suspended') return 'Felfüggesztve'
    if (agent.status === 'retired') return 'Nyugdíjazva'
    if (agent.status === 'draft') return 'Még vázlat'
    return 'Szünetel'
  }
  return 'Feladatra vár'
}

/** Agent-lista + futások → sáv-kártya állapotok (szerveroldali összeállítás). */
export function composeAgentRailStates(
  agents: Agent[],
  runs: readonly ActiveRun[],
  now: Date = new Date(),
): AgentRailCardState[] {
  const activityByAgent = summarizeAgentActivity(runs, now)
  const states = agents.map((agent) => {
    const activity = activityByAgent.get(agent.id)
    const liveStatus = liveStatusFromActivity(agent.status, activity)
    return {
      id: agent.id,
      name: agent.name,
      personaNickname: agent.personaNickname,
      personaGreeting: agent.personaGreeting,
      avatarUrl: agent.avatarUrl,
      status: agent.status,
      taskOnly: agent.taskOnly,
      roleLabel: roleLabelFor(agent),
      roleDescription: roleDescriptionFor(agent),
      liveStatus,
      activityText: activityTextFor(agent, activity, liveStatus),
      elapsed: activity?.current?.elapsed ?? null,
      progress: null,
      badges: badgesFor(agent, activity),
      attentionHref: activity?.attentionHref ?? null,
      sortRank: liveStatusSortRank(liveStatus),
    } satisfies AgentRailCardState
  })

  states.sort((a, b) => {
    if (a.sortRank !== b.sortRank) return a.sortRank - b.sortRank
    return agentDisplayName(a.name, { personaNickname: a.personaNickname }).localeCompare(
      agentDisplayName(b.name, { personaNickname: b.personaNickname }),
      'hu',
    )
  })

  return states
}
