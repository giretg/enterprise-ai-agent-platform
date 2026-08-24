'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentMiniAppsLink } from '@/components/agents/agent-mini-apps-link'
import {
  taskOnlyLaunchLabel,
  useLaunchableSkills,
} from '@/components/agents/task-only-launch-form'
import { personaFor } from '@/lib/agent-persona'
import {
  liveStatusLabel,
  type AgentRailCardState,
  type AgentWorkspaceTab,
} from '@/lib/agent-rail-types'

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

const ACTION_PRIMARY =
  'flex-1 rounded-lg border border-coral bg-coral px-2 py-1.5 text-xs font-bold text-card hover:bg-coral-deep'
const ACTION_SECONDARY =
  'flex-1 rounded-lg border border-line bg-card px-2 py-1.5 text-xs font-bold text-ink-soft hover:bg-night-2 hover:text-ink'

const ROLE_POPOVER_GAP_PX = 10
const ROLE_POPOVER_WIDTH_PX = 280

function AgentRailRolePopover({
  nickname,
  description,
  anchorRef,
  popoverRef,
  visible,
  onClose,
}: {
  nickname: string
  description: string
  anchorRef: React.RefObject<HTMLElement | null>
  popoverRef: React.RefObject<HTMLDivElement | null>
  visible: boolean
  onClose: () => void
}) {
  const [mounted, setMounted] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!visible) return

    const updatePosition = () => {
      const el = anchorRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const width = Math.min(ROLE_POPOVER_WIDTH_PX, window.innerWidth - 24)
      const left = Math.min(rect.right + ROLE_POPOVER_GAP_PX, window.innerWidth - width - 12)
      const maxTop = window.innerHeight - 12
      setPosition({
        top: Math.min(rect.top, maxTop),
        left,
      })
    }

    updatePosition()
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)
    return () => {
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
    }
  }, [visible, anchorRef])

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [visible, onClose])

  if (!visible || !mounted) return null

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={`${nickname} munkaköri leírása`}
      className="fixed z-[220] w-[min(280px,calc(100vw-24px))] max-h-[min(280px,70vh)] overflow-y-auto rounded-xl border border-line/90 bg-card px-3.5 py-3 shadow-[0_16px_36px_-12px_rgba(28,24,20,0.32)]"
      style={{ top: position.top, left: position.left }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-display text-sm font-bold leading-tight text-ink">{nickname}</p>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold text-ink-faint hover:bg-night-2 hover:text-ink"
          aria-label="Bezárás"
        >
          ✕
        </button>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">{description}</p>
    </div>,
    document.body,
  )
}

function AgentRailCardMenu({
  agentId,
  onOpenTab,
  onClose,
}: {
  agentId: string
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
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onOpenTab('board')
          onClose()
        }}
        className="block w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-ink-soft transition-colors hover:bg-night-2 hover:text-ink"
      >
        Feladatok
      </button>
      <AgentMiniAppsLink
        agentId={agentId}
        compact
        label="Mini-appok"
        className="block w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-ink-soft transition-colors hover:bg-night-2 hover:text-ink"
      />
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onOpenTab('profile')
          onClose()
        }}
        className="block w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-ink-soft transition-colors hover:bg-night-2 hover:text-ink"
      >
        Adatlap
      </button>
      <Link
        href={`/control-plane/agents/${agentId}`}
        role="menuitem"
        onClick={onClose}
        className="block rounded-lg px-3 py-2 text-sm font-semibold text-ink-soft transition-colors hover:bg-night-2 hover:text-ink"
      >
        Teljes adatlap
      </Link>
    </div>
  )
}

export function AgentRailCard({
  card,
  selected,
  collapsed,
  onSelect,
  onOpenTab,
}: {
  card: AgentRailCardState
  selected: boolean
  collapsed: boolean
  onSelect: () => void
  onOpenTab: (tab: AgentWorkspaceTab) => void
}) {
  const persona = personaFor(card.name, { personaNickname: card.personaNickname })
  const statusLabel = liveStatusLabel(card.liveStatus)
  const progressPct =
    card.progress && card.progress.total > 0
      ? Math.round((card.progress.current / card.progress.total) * 100)
      : null
  const [menuOpen, setMenuOpen] = useState(false)
  const [rolePopoverOpen, setRolePopoverOpen] = useState(false)
  const roleTextRef = useRef<HTMLButtonElement>(null)
  const rolePopoverRef = useRef<HTMLDivElement>(null)
  const menuWrapRef = useRef<HTMLDivElement>(null)
  const launchSkills = useLaunchableSkills(card.taskOnly ? card.id : null)
  const launchLabel = taskOnlyLaunchLabel(launchSkills)
  const showRolePopover = !collapsed && card.roleDescription !== 'Munkatárs'

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

  useEffect(() => {
    if (!rolePopoverOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (roleTextRef.current?.contains(target) || rolePopoverRef.current?.contains(target)) return
      setRolePopoverOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [rolePopoverOpen])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }

  return (
    <>
      <div
        role="option"
        aria-selected={selected}
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
        className={`relative w-full rounded-2xl border bg-gradient-to-br from-card to-card-2 p-3 text-left shadow-sm transition-all hover:-translate-y-px hover:border-[#dbcaa9] hover:shadow-md ${
        menuOpen ? 'z-20' : ''
      } ${
        selected ? 'border-coral shadow-[0_0_0_1px_inset_var(--color-coral)]' : 'border-line'
      } ${collapsed ? 'w-[52px] overflow-hidden p-1.5' : ''}`}
    >
      {selected && !collapsed ? (
        <span
          aria-hidden
          className="absolute -left-3 top-4 bottom-4 w-0.5 rounded-r bg-coral"
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
            <p className="truncate font-display text-[15px] font-bold leading-tight">
              {persona.nickname}
            </p>
            {showRolePopover ? (
              <button
                ref={roleTextRef}
                type="button"
                aria-expanded={rolePopoverOpen}
                aria-haspopup="dialog"
                onClick={(e) => {
                  e.stopPropagation()
                  setRolePopoverOpen((open) => !open)
                }}
                className="line-clamp-2 w-full text-left text-[11px] leading-snug text-ink-faint underline decoration-ink-faint/35 underline-offset-2 transition-colors hover:text-ink-soft hover:decoration-ink-soft/50"
              >
                {card.roleLabel}
              </button>
            ) : (
              <p className="line-clamp-2 text-[11px] leading-snug text-ink-faint">{card.roleLabel}</p>
            )}
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
              {card.badges.map((badge) => (
                <span
                  key={badge.label}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${BADGE_CLASS[badge.tone]}`}
                >
                  {badge.label}
                </span>
              ))}
            </div>
          ) : null}

          <div className="mt-2.5 flex gap-1.5">
            {/* #199 — korlátozott agent: egy Indítás CTA. Beszélgetős: chat + tábla. */}
            {card.taskOnly ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenTab('task')
                }}
                className={`${ACTION_PRIMARY} min-w-0`}
              >
                <span className="block truncate">{launchLabel}</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenTab('chat')
                  }}
                  className={ACTION_PRIMARY}
                >
                  Beszélgetés
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenTab('board')
                  }}
                  className={ACTION_SECONDARY}
                  title="Az agent feladat-táblája"
                >
                  Feladat
                </button>
              </>
            )}
            <div ref={menuWrapRef} className="relative shrink-0">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen((open) => !open)
                }}
                className="grid h-[30px] w-8 place-items-center rounded-lg border border-line bg-card text-xs font-bold text-ink-soft hover:bg-night-2"
                title="További műveletek"
                aria-label="További műveletek"
              >
                ⋯
              </button>
              {menuOpen ? (
                <AgentRailCardMenu
                  agentId={card.id}
                  onOpenTab={onOpenTab}
                  onClose={() => setMenuOpen(false)}
                />
              ) : null}
            </div>
          </div>
        </>
      ) : null}
      </div>

      <AgentRailRolePopover
        nickname={persona.nickname}
        description={card.roleDescription}
        anchorRef={roleTextRef}
        popoverRef={rolePopoverRef}
        visible={rolePopoverOpen}
        onClose={() => setRolePopoverOpen(false)}
      />
    </>
  )
}
