'use client'

import { useEffect } from 'react'
import { openAgentChat } from '@/components/agents/agent-chat-session-store'
import {
  clearWorkspaceChatChrome,
  registerWorkspaceChatChrome,
  type WorkspaceDistillTarget,
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
  conversationId,
  fallbackModel,
  startNewChat,
  toggleHistory,
  analyze,
  analyzeDisabled,
  distill,
  distillDisabled,
  distillPending,
  distillTargets,
  distillTargetSkillId,
  setDistillTargetSkillId,
}: {
  embedded: boolean
  open: boolean
  agent: WorkspaceChatAgent
  conversationId: string | null
  fallbackModel: string | null
  startNewChat: () => void
  toggleHistory: () => void
  analyze: () => void
  analyzeDisabled: boolean
  distill: () => void
  distillDisabled: boolean
  distillPending: boolean
  distillTargets: WorkspaceDistillTarget[]
  distillTargetSkillId: string
  setDistillTargetSkillId: (id: string) => void
}) {
  useEffect(() => {
    if (!embedded || !open) return
    registerWorkspaceChatChrome({
      startNewChat,
      toggleHistory,
      detach: () =>
        openAgentChat({
          agent,
          canDistillSkill: true,
          initialConversationId: conversationId,
        }),
      hasSavedConversation: Boolean(conversationId),
      fallbackModel,
      analyzeDisabled,
      analyze,
      distill,
      distillDisabled,
      distillPending,
      distillTargets,
      distillTargetSkillId,
      setDistillTargetSkillId,
    })
    return () => clearWorkspaceChatChrome()
  }, [
    agent,
    analyze,
    analyzeDisabled,
    conversationId,
    distill,
    distillDisabled,
    distillPending,
    distillTargetSkillId,
    distillTargets,
    embedded,
    fallbackModel,
    open,
    setDistillTargetSkillId,
    startNewChat,
    toggleHistory,
  ])
}
