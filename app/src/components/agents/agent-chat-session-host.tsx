'use client'

import { useSyncExternalStore } from 'react'
import { AgentChatPanel } from '@/components/agents/agent-chat-panel'
import { AgentChatDockHost } from '@/components/agents/agent-chat-dock'
import {
  closeAgentChat,
  getAgentChatSessions,
  getAgentChatSessionsServerSnapshot,
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

  return (
    <>
      {sessions.map((session) => (
        <AgentChatPanel
          key={session.id}
          agent={session.agent}
          open
          onClose={() => closeAgentChat(session.id)}
          canDistillSkill={session.canDistillSkill}
          initialConversationId={session.initialConversationId}
          restoreSignal={session.restoreSignal}
        />
      ))}
      <AgentChatDockHost />
    </>
  )
}
