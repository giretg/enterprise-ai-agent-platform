'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  assessChatTurnLiveness,
  describeChatTurnLiveness,
} from '@/domain/agent/chat-turn-liveness'
import { AGENT_TURN_RECONNECT_POLL_DEFAULT_MS } from '@/domain/agent/agent-turn-reconnect'
import type { ChatTurnActivity } from '@/lib/chat-turn-progress'

export type ChatTurnProgressSnapshot = {
  id: string
  status?: string
  partialText?: string
  activities?: unknown
  heartbeatAt?: string
  startedAt?: string
  cancelRequested?: boolean
}

export function describeChatTurnStall(turn: ChatTurnProgressSnapshot): string | null {
  const liveness = assessChatTurnLiveness({
    status: turn.status ?? 'running',
    cancelRequested: turn.cancelRequested,
    heartbeatAt: turn.heartbeatAt,
    startedAt: turn.startedAt,
    activities: turn.activities,
  })
  return liveness.kind === 'stalled' ? describeChatTurnLiveness(liveness).detail : null
}

/**
 * Egy aktív chat-turn életjelét és részleges eredményét pollolja. A hívó csak a
 * beszélgetés-azonosítót és a megfigyelhető progress-kezelőt ismeri; a heartbeat
 * döntés, retry és timer a modul implementációjában marad.
 */
export function useAgentChatTurnLiveness(input: {
  active: boolean
  conversationId: string | null
  activeTurnId: string | null
  onProgress: (progress: {
    turnId: string
    partialText: string
    activities: ChatTurnActivity[]
  }) => void
}) {
  const { active, conversationId, activeTurnId, onProgress } = input
  const [stallDetail, setStallDetail] = useState<string | null>(null)
  const reset = useCallback(() => setStallDetail(null), [])
  const updateFromSnapshot = useCallback((turn: ChatTurnProgressSnapshot) => {
    const detail = describeChatTurnStall(turn)
    setStallDetail(detail)
    return detail !== null
  }, [])

  useEffect(() => {
    if (!active || !conversationId || !activeTurnId) return
    let cancelled = false

    const pullProgress = async () => {
      try {
        const response = await fetch(
          `/api/v1/agent-chat/turns?conversationId=${encodeURIComponent(conversationId)}&active=1`,
        )
        if (!response.ok || cancelled) return
        const data = (await response.json()) as {
          active: boolean
          turn: ChatTurnProgressSnapshot | null
        }
        if (!data.active || !data.turn || cancelled) return
        updateFromSnapshot(data.turn)
        const activities = Array.isArray(data.turn.activities)
          ? (data.turn.activities as ChatTurnActivity[])
          : []
        const partialText = data.turn.partialText ?? ''
        if (activities.length === 0 && !partialText) return
        onProgress({ turnId: data.turn.id, activities, partialText })
      } catch {
        // Hálózati hiba után a következő tick újrapróbál.
      }
    }

    void pullProgress()
    const timer = window.setInterval(
      () => void pullProgress(),
      AGENT_TURN_RECONNECT_POLL_DEFAULT_MS,
    )
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [
    active,
    activeTurnId,
    conversationId,
    onProgress,
    updateFromSnapshot,
  ])

  return { stalled: stallDetail !== null, stallDetail, reset, updateFromSnapshot }
}
