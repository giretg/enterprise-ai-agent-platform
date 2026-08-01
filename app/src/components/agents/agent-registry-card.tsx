'use client'

import Link from 'next/link'
import type { Agent } from '@prisma/client'
import { Badge, Card } from '@/components/ui/shell'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentChatButton } from '@/components/agents/agent-chat-panel'
import { AgentTaskButton } from '@/components/agents/agent-task-button'
import { AgentMiniAppsLink } from '@/components/agents/agent-mini-apps-link'
import { DeleteAgentButton } from '@/components/agents/delete-agent-button'
import { personaFor, humanStatus } from '@/lib/agent-persona'
import { modelLabel, modelTypeLabel } from '@/lib/model-providers'

function agentBrainLabel(agent: Agent) {
  const modelConfig = agent.modelConfig as Record<string, unknown>
  const provider = typeof modelConfig.provider === 'string' ? modelConfig.provider : 'chatgpt-oauth'
  const model = typeof modelConfig.model === 'string' ? modelConfig.model : ''
  if (!model) return null
  const type = modelTypeLabel(
    typeof modelConfig.modelType === 'string' ? modelConfig.modelType : undefined,
  )
  return type ? `${modelLabel(provider, model)} · ${type}` : modelLabel(provider, model)
}

export function AgentRegistryCard({
  agent,
  canDelete,
}: {
  agent: Agent
  canDelete: boolean
}) {
  const p = personaFor(agent.name, agent)
  const mood = humanStatus(agent.status)
  const brainLabel = agentBrainLabel(agent)

  return (
    <Card className="h-full transition-transform duration-200 hover:-translate-y-1">
      <div className="flex items-start gap-4">
        <Link href={`/control-plane/agents/${agent.id}`} className="flex min-w-0 flex-1 items-start gap-4">
          <AgentAvatar
            name={agent.name}
            status={agent.status}
            size="lg"
            avatarUrl={agent.avatarUrl}
            personaNickname={agent.personaNickname}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-2xl font-semibold leading-none">{p.nickname}</h2>
              <span className="text-lg" aria-hidden>
                {p.emoji}
              </span>
            </div>
            <p className="mt-1 text-xs font-medium text-sage">
              {mood.label}
              {brainLabel && ` (Agy: ${brainLabel})`}
            </p>
          </div>
        </Link>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Badge tone={agent.status === 'active' ? 'success' : 'neutral'}>
            {agent.status === 'active'
              ? 'aktív'
              : agent.status === 'retired'
                ? 'nyugdíjazva'
                : agent.status === 'suspended'
                  ? 'felfüggesztve'
                  : agent.status === 'draft'
                    ? 'vázlat'
                    : 'pihen'}
          </Badge>
          {agent.hiddenFromOperators && <Badge tone="neutral">operátoroktól rejtett</Badge>}
          {agent.taskOnly && <Badge tone="neutral">korlátozott feladatkör</Badge>}
          {canDelete && <DeleteAgentButton agentId={agent.id} agentName={p.nickname} compact />}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Link href={`/control-plane/agents/${agent.id}`} className="flex-1 min-w-0">
          <p className="text-sm leading-relaxed text-ink-soft">{p.trait}</p>

          <div className="estate-rule my-4" />

          <p className="line-clamp-2 text-xs text-ink-faint">{agent.roleInstruction}</p>
        </Link>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {/* #199 — korlátozott feladatkörű agentnél nincs chat, csak feladat-gomb. */}
          {agent.taskOnly ? (
            <AgentTaskButton agentId={agent.id} compact />
          ) : (
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
          )}
          <AgentMiniAppsLink agentId={agent.id} compact />
        </div>
      </div>
    </Card>
  )
}
