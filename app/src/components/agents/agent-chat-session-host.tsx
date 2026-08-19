'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { AgentChatPanel } from '@/components/agents/agent-chat-panel'
import { AgentChatDockHost } from '@/components/agents/agent-chat-dock'
import {
  closeAgentChat,
  consumePendingOAuthAgentChat,
  getAgentChatSessions,
  getAgentChatSessionsServerSnapshot,
  openAgentChat,
  subscribeAgentChatSessions,
} from '@/components/agents/agent-chat-session-store'

export function useAgentChatSessions() {
  return useSyncExternalStore(
    subscribeAgentChatSessions,
    getAgentChatSessions,
    getAgentChatSessionsServerSnapshot,
  )
}

/** Control-plane layout: nyitott / tálcán lévő chat-ablakok túlélik az oldalnavigációt. */
export function AgentChatSessionHost() {
  const sessions = useAgentChatSessions()
  const [tileTarget, setTileTarget] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    const pending = consumePendingOAuthAgentChat()
    if (!pending) return
    const granted =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('granted') === '1'
    openAgentChat({
      agent: pending.agent,
      canDistillSkill: pending.canDistillSkill,
      initialConversationId: pending.initialConversationId,
      ...(granted ? { resumeAfterGrant: true } : {}),
    })
  }, [])

  return (
    <>
      <div
        ref={setTileTarget}
        className="pointer-events-none fixed inset-0 z-[200] grid grid-cols-1 gap-3 overflow-y-auto p-3 sm:grid-flow-col sm:auto-cols-fr sm:grid-cols-none sm:grid-rows-1 sm:overflow-hidden sm:p-4"
        aria-label="Megnyitott agent beszélgetések"
      />
      {sessions.map((session) => (
        <AgentChatPanel
          key={session.id}
          agent={session.agent}
          open
          onClose={() => closeAgentChat(session.id)}
          canDistillSkill={session.canDistillSkill}
          initialConversationId={session.initialConversationId}
          resumeAfterGrant={session.resumeAfterGrant}
          restoreSignal={session.restoreSignal}
          tileTarget={tileTarget}
        />
      ))}
      <AgentChatDockHost />
    </>
  )
}
