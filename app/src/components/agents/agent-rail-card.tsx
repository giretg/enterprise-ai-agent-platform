'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentMiniAppsLink } from '@/components/agents/agent-mini-apps-link'
import { AgentRoleDescriptionButton } from '@/components/agents/agent-role-description-modal'
import { personaFor } from '@/lib/agent-persona'
import {
  liveStatusLabel,
  type AgentRailCardState,
  type AgentWorkspaceTab,
} from '@/lib/agent-rail-types'
import { workspaceTabsForAgent } from '@/lib/agent-workspace-routes'

const SOUL_CLASS: Record<AgentRailCardState['liveStatus'], string> = {
  busy: 'bg-sky motion-safe:animate-pulse',
  wait: 'bg-honey motion-safe:animate-pulse',
  idle: 'bg-sage',
  off: 'bg-ink-faint/60',
}

const BADGE_CLASS = {
  wait: 'bg-honey/15 text-honey',
  new: 'bg-coral/14 text-coral-deep',
  err: 'bg-coral/18 text-coral-deep',
  muted: 'bg-ink/10 text-ink-soft',
} as const

const MENU_ITEM =
  'block w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-ink-soft transition-colors hover:bg-night-2 hover:text-ink'

function AgentRailCardMenu({
  agentId,
  taskOnly,
  onOpenTab,
  onClose,
}: {
  agentId: string
  taskOnly: boolean
  onOpenTab: (tab: AgentWorkspaceTab) => void
  onClose: () => void
}) {
  const menuId = useId()

  return (
    <div
      id={menuId}
      role="menu"
      className="absolute right-0 top-full z-20 mt-1 min-w-[11rem] rounded-xl border border-line bg-card p-1 shadow-xl"
    >
      {workspaceTabsForAgent(taskOnly).map((tab) =>
        tab.key === 'apps' ? (
          <AgentMiniAppsLink
            key={tab.key}
            agentId={agentId}
            compact
            label={tab.label}
            className={MENU_ITEM}
          />
        ) : (
          <button
            key={tab.key}
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation()
              onOpenTab(tab.key)
              onClose()
            }}
            className={MENU_ITEM}
          >
            {tab.label}
          </button>
        ),
      )}
    </div>
  )
}

export function AgentRailCard({
  card,
  selected,
  collapsed,
  onSelect,
  onOpenTab,
  onOpenAttention,
}: {
  card: AgentRailCardState
  selected: boolean
  collapsed: boolean
  onSelect: () => void
  onOpenTab: (tab: AgentWorkspaceTab) => void
  /** Jóváhagyásra váró ticket/beszélgetés megnyitása a pillről. */
  onOpenAttention?: (href: string) => void
}) {
  const persona = personaFor(card.name, {
    personaNickname: card.personaNickname,
    personaGreeting: card.personaGreeting,
  })
  const statusLabel = liveStatusLabel(card.liveStatus)
  const progressPct =
    card.progress && card.progress.total > 0
      ? Math.round((card.progress.current / card.progress.total) * 100)
      : null
  const [menuOpen, setMenuOpen] = useState(false)
  const menuWrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (!menuWrapRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }

  const roleInstructionText = card.roleInstruction || card.roleDescription

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={`relative w-full rounded-2xl border p-3 text-left transition-all hover:-translate-y-px hover:border-[#dbcaa9] hover:shadow-md ${
        menuOpen ? 'z-20' : ''
      } ${
        selected
          ? 'border-coral-deep border-l-[6px] border-l-coral-deep bg-gradient-to-br from-coral/[0.18] via-card to-card shadow-lg ring-2 ring-coral/50'
          : 'border-line bg-gradient-to-br from-card to-card-2 shadow-sm'
      } ${collapsed ? 'w-[52px] overflow-hidden p-1.5' : ''}`}
    >
      {selected && !collapsed ? (
        <span
          aria-hidden
          className="absolute left-0 top-3 bottom-3 w-1.5 rounded-r-full bg-coral-deep"
        />
      ) : null}

      <div className={`flex gap-2.5 ${collapsed ? 'flex-col items-center' : 'items-start'}`}>
        <div className="relative shrink-0">
          <AgentAvatar
            name={card.name}
            status={card.status}
            size={collapsed ? 'sm' : 'md'}
            avatarUrl={card.avatarUrl}
            personaNickname={card.personaNickname}
            isWorking={card.liveStatus === 'busy'}
          />
          <span
            aria-hidden
            className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-card ${SOUL_CLASS[card.liveStatus]}`}
          />
        </div>

        {collapsed ? (
          <p className="w-full min-w-0 truncate text-center text-[9px] font-semibold leading-tight text-ink-soft">
            {persona.nickname}
          </p>
        ) : (
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <p
                className={`min-w-0 flex-1 truncate font-display text-[15px] font-bold leading-tight ${
                  selected ? 'text-coral-deep' : 'text-ink'
                }`}
              >
                {persona.nickname}
              </p>
              <div ref={menuWrapRef} className="relative -mr-1 shrink-0">
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpen((open) => !open)
                  }}
                  className="grid h-6 w-6 place-items-center rounded-md text-sm font-bold leading-none text-ink-faint hover:bg-night-2 hover:text-ink"
                  title="További műveletek"
                  aria-label="További műveletek"
                >
                  ⋯
                </button>
                {menuOpen ? (
                  <AgentRailCardMenu
                    agentId={card.id}
                    taskOnly={card.taskOnly}
                    onOpenTab={onOpenTab}
                    onClose={() => setMenuOpen(false)}
                  />
                ) : null}
              </div>
            </div>
            <div className="mt-0.5 flex items-start gap-1">
              <p className="min-w-0 flex-1 text-[11px] leading-snug italic text-ink-faint line-clamp-2">
                &quot;{persona.greeting}&quot;
              </p>
              {roleInstructionText ? (
                <AgentRoleDescriptionButton
                  nickname={persona.nickname}
                  description={roleInstructionText}
                  compact
                />
              ) : null}
            </div>
          </div>
        )}
      </div>

      {!collapsed ? (
        <>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-ink-soft">
            <span className="font-semibold">{statusLabel}</span>
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate">{card.activityText}</span>
            {card.elapsed ? (
              <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
                {card.elapsed}
              </span>
            ) : null}
          </div>

          {progressPct !== null ? (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line/80">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky to-grape transition-[width] duration-700"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          ) : null}

          {card.badges.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {card.badges.map((badge) =>
                badge.href && onOpenAttention ? (
                  <button
                    key={badge.label}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenAttention(badge.href!)
                    }}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold transition-colors hover:brightness-95 ${BADGE_CLASS[badge.tone]}`}
                    title="Jóváhagyásra váró ügy megnyitása"
                  >
                    {badge.label}
                  </button>
                ) : (
                  <span
                    key={badge.label}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${BADGE_CLASS[badge.tone]}`}
                  >
                    {badge.label}
                  </span>
                ),
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
