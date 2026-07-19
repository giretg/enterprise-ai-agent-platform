'use client'

import Link from 'next/link'
import type { Agent } from '@prisma/client'
import { Card } from '@/components/ui/shell'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentChatButton } from '@/components/agents/agent-chat-panel'
import { AgentMiniAppsLink } from '@/components/agents/agent-mini-apps-link'
import { personaFor, humanStatus } from '@/lib/agent-persona'

export function DashboardAgentCard({ agent }: { agent: Agent }) {
  const p = personaFor(agent.name, agent)
  const mood = humanStatus(agent.status)

  return (
    <Card className="h-full transition-transform duration-200 hover:-translate-y-1">
      <Link href={`/control-plane/agents/${agent.id}`} className="flex items-center gap-4">
        <AgentAvatar
          name={agent.name}
          status={agent.status}
          size="md"
          avatarUrl={agent.avatarUrl}
          personaNickname={agent.personaNickname}
        />
        <div className="min-w-0">
          <p className="font-display text-xl font-semibold leading-tight">{p.nickname}</p>
          <p className="mt-1 text-xs font-medium text-sage">{mood.label}</p>
        </div>
      </Link>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <Link href={`/control-plane/agents/${agent.id}`} className="min-w-0 flex-1">
          <p className="text-sm italic leading-relaxed text-ink-soft">“{p.greeting}”</p>
        </Link>
        <div className="flex shrink-0 flex-col items-end gap-2">
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
            compact
          />
          <AgentMiniAppsLink agentId={agent.id} compact />
        </div>
      </div>
    </Card>
  )
}
