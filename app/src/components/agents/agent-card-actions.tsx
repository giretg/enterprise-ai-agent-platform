'use client'

import type { Agent } from '@prisma/client'
import Link from 'next/link'
import { AgentChatButton } from '@/components/agents/agent-chat-panel'
import { AgentTaskButton } from '@/components/agents/agent-task-button'
import { AgentMiniAppsLink } from '@/components/agents/agent-mini-apps-link'
import { agentWorkspacePath } from '@/lib/agent-workspace-routes'

export type AssigneeOptions = {
  agents: {
    id: string
    name: string
    avatarUrl?: string | null
    personaNickname?: string | null
    personaTrait?: string | null
    status?: string
    taskOnly?: boolean
  }[]
  users: { id: string; name: string; role: string }[]
}

/** Egy hangsúlyos „szólítsd meg” gomb — kártyánként pontosan egy van belőle. */
const PRIMARY_ACTION =
  'inline-flex min-w-0 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-full bg-coral px-2.5 py-2 text-xs font-semibold text-card shadow-[0_10px_22px_-14px_rgba(178,58,85,0.95)] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0'

/** A másodlagos utak — azonos magasság, halkabb hang. */
const SECONDARY_ACTION =
  'inline-flex min-w-0 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-full border border-line bg-card px-2.5 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep disabled:cursor-not-allowed disabled:opacity-50'

/**
 * A kártyák lábléce: ugyanaz a gombsor a dashboardon és a csapat-listában,
 * hogy a felhasználó ne kelljen két különböző elrendezést megtanulnia.
 *
 * A gombok maguk hordozzák a modáljaikat (chat-dock), itt csak
 * az egységes megjelenés és a sorrend dől el: előbb a megszólítás, utána a
 * mellékutak.
 */
export function AgentCardActions({
  agent,
}: {
  agent: Agent
  canCreateTicket?: boolean
  assigneeOptions?: AssigneeOptions
}) {
  return (
    <div className="mt-auto flex flex-nowrap items-stretch gap-1.5 border-t border-line/70 bg-night-2/40 px-4 py-3">
      {/* #199 — korlátozott agentnél nincs chat, csak skill-kötött indító. */}
      {agent.taskOnly ? (
        <AgentTaskButton agentId={agent.id} className={PRIMARY_ACTION} />
      ) : (
        <>
          <AgentChatButton
            agent={{
              id: agent.id,
              name: agent.name,
              status: agent.status,
              avatarUrl: agent.avatarUrl,
              personaNickname: agent.personaNickname,
              personaGreeting: agent.personaGreeting,
              personaTrait: agent.personaTrait,
            }}
            label="Beszélgetés"
            className={PRIMARY_ACTION}
          />
          <Link
            href={agentWorkspacePath(agent.id, 'board')}
            className={SECONDARY_ACTION}
            title="Az agent feladat-táblája"
          >
            Feladat
          </Link>
        </>
      )}
      <AgentMiniAppsLink agentId={agent.id} compact className={SECONDARY_ACTION} />
    </div>
  )
}
