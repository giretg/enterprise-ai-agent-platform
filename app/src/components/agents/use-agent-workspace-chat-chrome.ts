'use client'

import { useEffect } from 'react'
import { openAgentChat } from '@/components/agents/agent-chat-session-store'
import {
  clearWorkspaceChatChrome,
  registerWorkspaceChatChrome,
} from '@/lib/agent-workspace-chat-chrome'

type WorkspaceChatAgent = {
  id: string
  name: string
  status?: string
  avatarUrl?: string | null
  personaNickname?: string | null
}

/** Az embedded chat fejléc-műveleteit egyetlen regisztrációs seam mögé rejti. */
export function useAgentWorkspaceChatChrome({
  embedded,
  open,
  agent,
  canDistillSkill,
  conversationId,
  startNewChat,
  toggleHistory,
  analyze,
  analyzeDisabled,
}: {
  embedded: boolean
  open: boolean
  agent: WorkspaceChatAgent
  canDistillSkill: boolean
  conversationId: string | null
  startNewChat: () => void
  toggleHistory: () => void
  analyze: () => void
  analyzeDisabled: boolean
}) {
  useEffect(() => {
    if (!embedded || !open) return
    registerWorkspaceChatChrome({
      startNewChat,
      toggleHistory,
      detach: () =>
        openAgentChat({
          agent,
          canDistillSkill,
          initialConversationId: conversationId,
        }),
      hasSavedConversation: Boolean(conversationId),
      analyzeDisabled,
      analyze,
    })
    return () => clearWorkspaceChatChrome()
  }, [
    agent,
    analyze,
    analyzeDisabled,
    canDistillSkill,
    conversationId,
    embedded,
    open,
    startNewChat,
    toggleHistory,
  ])
}
