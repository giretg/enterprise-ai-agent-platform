'use client'

import { useCallback, useState } from 'react'
import {
  assessChatTurnLiveness,
  describeChatTurnLiveness,
} from '@/domain/agent/chat-turn-liveness'
import {
  AGENT_TURN_LIVENESS_POLL_ENV,
  resolveLivenessPollMs,
} from '@/domain/agent/agent-turn-reconnect'
import type { ChatTurnActivity } from '@/lib/chat-turn-progress'
import { useAdaptivePoll } from '@/lib/use-adaptive-poll'

export type ChatTurnProgressSnapshot = {
  id: string
  status?: string
  partialText?: string
  activities?: unknown
  heartbeatAt?: string
  startedAt?: string
  createdAt?: string
  launchReservedAt?: string | null
  cancelRequested?: boolean
}

function assessSnapshot(turn: ChatTurnProgressSnapshot) {
  return assessChatTurnLiveness({
    status: turn.status ?? 'running',
    cancelRequested: turn.cancelRequested,
    heartbeatAt: turn.heartbeatAt,
    startedAt: turn.startedAt,
    createdAt: turn.createdAt,
    launchReservedAt: turn.launchReservedAt,
    activities: turn.activities,
  })
}

export function describeChatTurnStall(turn: ChatTurnProgressSnapshot): string | null {
  const liveness = assessSnapshot(turn)
  return liveness.kind === 'stalled' ? describeChatTurnLiveness(liveness).detail : null
}

/**
 * #518 — a még el nem indult forduló sor-állapota („Sorban áll” / „Indul…”),
 * `null`, ha már fut. A fejléc-chip ebből tudja, hogy nem gépel, hanem vár.
 */
export function describeChatTurnQueue(
  turn: ChatTurnProgressSnapshot,
): { label: string; detail: string } | null {
  if (turn.status !== 'queued') return null
  const liveness = assessSnapshot(turn)
  return liveness.kind === 'queued' || liveness.kind === 'starting'
    ? describeChatTurnLiveness(liveness)
    : null
}

/**
 * Next.js a kliens-bundle-be csak a literális `process.env.NEXT_PUBLIC_*`
 * hozzáférést égeti be. A `resolveLivenessPollMs(process.env)` indirekt olvasás
 * a böngészőben mindig az alapértékre esne.
 */
const LIVENESS_POLL_MS = resolveLivenessPollMs({
  [AGENT_TURN_LIVENESS_POLL_ENV]: process.env.NEXT_PUBLIC_AGENT_TURN_LIVENESS_POLL_MS,
})

/**
 * Egy aktív chat-turn életjelét és részleges eredményét pollolja. A hívó csak a
 * beszélgetés-azonosítót és a megfigyelhető progress-kezelőt ismeri; a heartbeat
 * döntés, retry és timer a modul implementációjában marad.
 *
 * Az élő SSE-stream az elsődleges csatorna; ez a poll stall-érzékelés és
 * részszöveg-backstop, ha a stream megszakad. 5 mp elég — a stall-küszöb 45 mp.
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
  onFinished: (conversationId: string) => void
}) {
  const { active, conversationId, activeTurnId, onProgress, onFinished } = input
  const [stallDetail, setStallDetail] = useState<string | null>(null)
  const [queueState, setQueueState] = useState<{ label: string; detail: string } | null>(null)
  const reset = useCallback(() => {
    setStallDetail(null)
    setQueueState(null)
  }, [])
  const updateFromSnapshot = useCallback((turn: ChatTurnProgressSnapshot) => {
    const detail = describeChatTurnStall(turn)
    setStallDetail(detail)
    setQueueState(describeChatTurnQueue(turn))
    return detail !== null
  }, [])

  const pullProgress = useCallback(async () => {
    if (!active || !conversationId || !activeTurnId) return
    try {
      const response = await fetch(
        `/api/v1/agent-chat/turns?conversationId=${encodeURIComponent(conversationId)}&active=1`,
      )
      if (!response.ok) return
      const data = (await response.json()) as {
        active: boolean
        turn: ChatTurnProgressSnapshot | null
      }
      if (!data.active || !data.turn) {
        onFinished(conversationId)
        return
      }
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
  }, [
    active,
    activeTurnId,
    conversationId,
    onFinished,
    onProgress,
    updateFromSnapshot,
  ])

  useAdaptivePoll(pullProgress, {
    activeMs: LIVENESS_POLL_MS,
    idleMs: LIVENESS_POLL_MS,
    idle: false,
    enabled: active && Boolean(conversationId) && Boolean(activeTurnId),
  })

  return { stalled: stallDetail !== null, stallDetail, queueState, reset, updateFromSnapshot }
}
