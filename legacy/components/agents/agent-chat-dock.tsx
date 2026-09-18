'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import {
  getAgentChatDockEntries,
  getAgentChatDockServerSnapshot,
  subscribeAgentChatDock,
  type AgentChatDockEntry,
} from '@/components/agents/agent-chat-dock-store'

export type { AgentChatDockEntry }

export function useAgentChatDockEntries() {
  return useSyncExternalStore(
    subscribeAgentChatDock,
    getAgentChatDockEntries,
    getAgentChatDockServerSnapshot,
  )
}

export function AgentChatDockHost() {
  const items = useAgentChatDockEntries()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])

  if (!mounted || items.length === 0) return null

  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[210] flex justify-center p-3 sm:p-4"
      role="toolbar"
      aria-label="Tálcán lévő beszélgetések"
    >
      <div className="pointer-events-auto flex max-w-[min(100%,72rem)] flex-wrap items-stretch justify-center gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex max-w-[min(100%,20rem)] items-center gap-2 rounded-2xl border border-line bg-card px-2.5 py-2 shadow-2xl sm:gap-3 sm:px-3 sm:py-2.5"
          >
            <button
              type="button"
              onClick={item.onRestore}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-xl text-left transition-colors hover:bg-night-2/60 sm:gap-3"
              title="Beszélgetés visszaállítása"
            >
              <AgentAvatar
                name={item.agentName}
                status={item.agentStatus}
                size="sm"
                avatarUrl={item.avatarUrl}
                personaNickname={item.personaNickname}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-sm font-semibold text-ink">{item.displayName}</p>
                <p className="truncate text-[11px] text-ink-faint">
                  {item.isTyping ? 'Dolgozik…' : 'Tálcán'}
                </p>
              </div>
            </button>
            <button
              type="button"
              onClick={item.onRestore}
              className="rounded-full p-2 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink"
              aria-label={`${item.displayName} visszaállítása`}
              title="Visszaállítás"
            >
              ▢
            </button>
            <button
              type="button"
              onClick={item.onClose}
              className="rounded-full p-2 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink"
              aria-label={`${item.displayName} bezárása`}
              title="Bezárás"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
}
