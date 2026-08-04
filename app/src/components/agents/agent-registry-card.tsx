'use client'

import Link from 'next/link'
import type { Agent } from '@prisma/client'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentCardActions, type AssigneeOptions } from '@/components/agents/agent-card-actions'
import { DeleteAgentButton } from '@/components/agents/delete-agent-button'
import { personaFor, humanStatus } from '@/lib/agent-persona'
import { modelLabel, modelTypeLabel } from '@/lib/model-providers'

const LABEL_TONE = {
  working: 'text-coral-deep',
  available: 'text-sage',
  unknown: 'text-sage',
  idle: 'text-ink-faint',
} as const

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

function Chip({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'success' | 'danger'
}) {
  const toneClass =
    tone === 'success'
      ? 'bg-sage/12 text-sage'
      : tone === 'danger'
        ? 'bg-coral/12 text-coral-deep'
        : 'bg-night-2 text-ink-faint'
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${toneClass}`}>
      {children}
    </span>
  )
}

/**
 * Egy munkatárs a csapat-listában: ugyanaz az arc és gombsor, mint a
 * dashboardon, de itt a „ki ez és mire van beállítva” a fontos — jellem,
 * feladatkör-leírás, agy (modell) és a kormányzási jelzők.
 */
export function AgentRegistryCard({
  agent,
  canDelete,
  isWorking = false,
  canCreateTicket = false,
  assigneeOptions,
}: {
  agent: Agent
  canDelete: boolean
  /** Aktívan futó ügy a saját futásokból — dashboard `act.working` párja. */
  isWorking?: boolean
  canCreateTicket?: boolean
  assigneeOptions?: AssigneeOptions
}) {
  const p = personaFor(agent.name, agent)
  const mood = humanStatus(agent.status, isWorking)
  const brainLabel = agentBrainLabel(agent)
  const detailHref = `/control-plane/agents/${agent.id}`

  return (
    <article className="atelier-card group relative flex h-full flex-col overflow-hidden transition-transform duration-200 hover:-translate-y-1">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-32"
        style={{
          background: `linear-gradient(165deg, ${p.gradient[0]}1f, ${p.gradient[1]}00 72%)`,
        }}
      />

      <div className="relative flex items-start gap-4 px-5 pt-5">
        <Link href={detailHref} aria-label={`${p.nickname} adatlapja`}>
          <AgentAvatar
            name={agent.name}
            status={agent.status}
            size="lg"
            avatarUrl={agent.avatarUrl}
            personaNickname={agent.personaNickname}
            isWorking={isWorking}
          />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <Link href={detailHref} className="min-w-0 flex-1">
              <h2 className="truncate font-display text-[1.6rem] font-semibold leading-tight transition-colors group-hover:text-coral-deep">
                {p.nickname} <span aria-hidden>{p.emoji}</span>
              </h2>
            </Link>
            {canDelete && <DeleteAgentButton agentId={agent.id} agentName={p.nickname} compact />}
          </div>
          <p className={`mt-1 text-xs font-medium ${LABEL_TONE[mood.tone]}`}>{mood.label}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {agent.status === 'active' ? (
              <Chip tone="success">aktív</Chip>
            ) : (
              <Chip tone={agent.status === 'suspended' ? 'danger' : 'neutral'}>{mood.label}</Chip>
            )}
            {brainLabel && <Chip>Agy: {brainLabel}</Chip>}
            {agent.taskOnly && <Chip>korlátozott feladatkör</Chip>}
            {agent.hiddenFromOperators && <Chip>operátoroktól rejtett</Chip>}
          </div>
        </div>
      </div>

      <Link href={detailHref} className="relative flex-1 px-5 pb-4 pt-4">
        <p className="line-clamp-2 text-sm leading-relaxed text-ink-soft">{p.trait}</p>
        <div className="estate-rule my-3.5" />
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Mivel bízták meg
        </p>
        <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-ink-faint">
          {agent.roleInstruction}
        </p>
      </Link>

      <AgentCardActions
        agent={agent}
        canCreateTicket={canCreateTicket}
        assigneeOptions={assigneeOptions}
      />
    </article>
  )
}
