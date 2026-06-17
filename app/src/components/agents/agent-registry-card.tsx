'use client'

import Link from 'next/link'
import type { Agent } from '@prisma/client'
import { Badge, Card } from '@/components/ui/shell'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentChatButton } from '@/components/agents/agent-chat-panel'
import { DeleteAgentButton } from '@/components/agents/delete-agent-button'
import { personaFor, humanStatus } from '@/lib/agent-persona'

export function AgentRegistryCard({
  agent,
  canDelete,
}: {
  agent: Agent
  canDelete: boolean
}) {
  const p = personaFor(agent.name)
  const mood = humanStatus(agent.status)

  return (
    <Card className="h-full transition-transform duration-200 hover:-translate-y-1">
      <div className="flex items-start gap-4">
        <Link href={`/control-plane/agents/${agent.id}`} className="flex min-w-0 flex-1 items-start gap-4">
          <AgentAvatar name={agent.name} status={agent.status} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-2xl font-semibold leading-none">{p.nickname}</h2>
              <span className="text-lg" aria-hidden>
                {p.emoji}
              </span>
            </div>
            <p className="mt-1 text-sm text-ink-faint">{agent.name}</p>
            <p className="mt-1 text-xs font-medium text-sage">{mood.label}</p>
          </div>
        </Link>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Badge tone={agent.status === 'active' ? 'success' : 'neutral'}>
            {agent.status === 'active' ? 'aktív' : 'pihen'}
          </Badge>
          {canDelete && <DeleteAgentButton agentId={agent.id} agentName={agent.name} compact />}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Link href={`/control-plane/agents/${agent.id}`} className="flex-1 min-w-0">
          <p className="text-sm leading-relaxed text-ink-soft">{p.trait}</p>

          <div className="estate-rule my-4" />

          <p className="line-clamp-2 text-xs text-ink-faint">{agent.roleInstruction}</p>
        </Link>
        <AgentChatButton
          agent={{ id: agent.id, name: agent.name, status: agent.status }}
          compact
        />
      </div>
    </Card>
  )
}
