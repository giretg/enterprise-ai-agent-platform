'use client'

import Link from 'next/link'
import type { Agent } from '@prisma/client'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentCardActions, type AssigneeOptions } from '@/components/agents/agent-card-actions'
import { personaFor, humanStatus } from '@/lib/agent-persona'
import { EMPTY_AGENT_ACTIVITY, type AgentActivity } from '@/lib/agent-activity'

const LABEL_TONE = {
  working: 'text-coral-deep',
  available: 'text-sage',
  unknown: 'text-sage',
  idle: 'text-ink-faint',
} as const

const DOT_TONE = {
  working: 'bg-coral',
  available: 'bg-sage',
  unknown: 'bg-sage',
  idle: 'bg-ink-faint',
} as const

/** Halk állapot-pirula a fejléc jobb szélén — csak ha eltér a megszokottól. */
function StatusChip({ agent }: { agent: Agent }) {
  if (agent.status === 'suspended') return <Chip tone="danger">Felfüggesztve</Chip>
  if (agent.status === 'draft') return <Chip tone="neutral">Még vázlat</Chip>
  if (agent.status === 'retired') return <Chip tone="neutral">Nyugdíjazva</Chip>
  if (agent.taskOnly) return <Chip tone="neutral">Csak indítás</Chip>
  return null
}

function Chip({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'danger' | 'warning'
}) {
  const toneClass =
    tone === 'danger'
      ? 'bg-coral/12 text-coral-deep'
      : tone === 'warning'
        ? 'bg-honey/15 text-honey'
        : 'bg-night-2 text-ink-faint'
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${toneClass}`}>
      {children}
    </span>
  )
}

/**
 * Egy munkatárs a dashboardon: arc, hangulat és — ami eddig hiányzott — az,
 * hogy MIN dolgozik éppen veled, mi vár a döntésedre, és mit zárt le ma.
 *
 * Az `activity` a bejelentkezett felhasználó SAJÁT futásaiból készül
 * (`summarizeAgentActivity`), ezért a szövegek végig „neked” nézőpontúak.
 */
export function DashboardAgentCard({
  agent,
  canCreateTicket,
  assigneeOptions,
  activity,
}: {
  agent: Agent
  canCreateTicket?: boolean
  assigneeOptions?: AssigneeOptions
  /** Ha nincs megadva, a kártya nem állít semmit a mai közös munkáról. */
  activity?: AgentActivity
}) {
  const p = personaFor(agent.name, agent)
  const act = activity ?? EMPTY_AGENT_ACTIVITY
  const mood = humanStatus(agent.status, act.working)
  const detailHref = `/control-plane/agents/${agent.id}`
  const current = act.current
  const pendingElsewhere = act.awaitingHuman - (current?.needsYou ? 1 : 0)
  const doneToday = act.completedToday

  return (
    <article className="atelier-card group relative flex h-full flex-col overflow-hidden transition-transform duration-200 hover:-translate-y-1">
      {/* Persona-fátyol: minden munkatársnak saját színe van, halkan. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-28"
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
            isWorking={act.working}
          />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <Link href={detailHref} className="min-w-0 flex-1">
              <h3 className="truncate font-display text-[1.5rem] font-semibold leading-tight transition-colors group-hover:text-coral-deep">
                {p.nickname}
              </h3>
            </Link>
            <StatusChip agent={agent} />
          </div>
          <p className={`mt-1 flex items-center gap-1.5 text-xs font-medium ${LABEL_TONE[mood.tone]}`}>
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${DOT_TONE[mood.tone]} ${
                mood.tone === 'working' ? 'animate-soul' : ''
              }`}
            />
            {mood.label}
          </p>
          <Link href={detailHref} className="mt-2 block">
            <p className="line-clamp-2 text-[13px] italic leading-relaxed text-ink-soft">
              “{p.greeting}”
            </p>
          </Link>
        </div>
      </div>

      <div className="relative flex-1 px-5 pb-4 pt-4">
        {current ? (
          <>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              {current.needsYou ? 'Rád vár' : 'Most ezen dolgozik'}
            </p>
            <Link
              href={current.href}
              className="atelier-soft flex items-center gap-2 px-3 py-2 transition-colors hover:border-coral/35"
            >
              <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
                <span
                  className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${
                    current.needsYou ? 'bg-honey' : 'bg-sky'
                  }`}
                />
                <span
                  className={`relative inline-flex h-2 w-2 rounded-full ${
                    current.needsYou ? 'bg-honey' : 'bg-sky'
                  }`}
                />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                {current.title}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
                {current.elapsed}
              </span>
            </Link>
          </>
        ) : (
          <p className="text-[13px] text-ink-faint">
            {doneToday > 0
              ? 'Most nem dolgozik semmin — nyugodtan adj neki új feladatot.'
              : 'Ma még nem dolgoztatok együtt.'}
          </p>
        )}

        {(pendingElsewhere > 0 || doneToday > 0) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {pendingElsewhere > 0 && (
              <Chip tone="warning">{pendingElsewhere} döntés rád vár</Chip>
            )}
            {doneToday > 0 && <Chip>Ma {doneToday} ügyet zárt le neked</Chip>}
          </div>
        )}
      </div>

      <AgentCardActions
        agent={agent}
        canCreateTicket={canCreateTicket}
        assigneeOptions={assigneeOptions}
      />
    </article>
  )
}
