/**
 * chat-agent-turn-resilience-spec.md §7 / D10 — beragadt AgentTurn watchdog
 * (issue #64 / E6, #519).
 *
 * A futtató process crash/deploy alatt elvágott fordulói `running` állapotban
 * maradnának, heartbeat nélkül — a beszélgetés örökre „gépel" lenne. Ez a
 * modul a meglévő dispatch-ciklus reclaim-fázisára ül: az elavult
 * heartbeatű aktív fordulókat `failed`/`watchdog` végállapotba zárja, a
 * lockot elengedi, és hétköznapi nyelvű lezáró üzenetet ír a beszélgetésbe.
 *
 * #519: a 30 perces aktív szakaszkeretet is itt söpörjük (startedAt, nem a
 * sorban állás) — akkor is, ha a heartbeat még friss, mert a loop elakadt.
 *
 * Az indítási út lazy reclaimje (`agent-chat-runtime`) ugyanazt a
 * `closeTurnAsWatchdog` lezárást hívja — egy forrás a státuszra és az üzenetre.
 */
import type { AgentTurn, Message, MessageRole, Prisma } from '@prisma/client'
import type { AgentTurnRepository } from '@/repositories/interfaces'
import { guardTurnPartialText } from './agent-turn-snapshot'
import { CHAT_TURN_ACTIVE_PHASE_MS } from './loop-stop-decision'

/** Spec §7 / D10 — dokumentált alapérték (~120 mp). */
export const DEFAULT_STALE_TURN_MS = 120_000

/** A forduló-rekordra írt hibaszöveg — lazy és ciklusos reclaim közös. */
export const WATCHDOG_TURN_ERROR =
  'A futtató process leállt a forduló közben (heartbeat elmaradt).'

export const WALLCLOCK_TURN_ERROR =
  'Az aktív futási szakasz elérte a 30 perces korlátot.'

/** Env: `AGENT_TURN_STALE_MS` — pozitív egész ms; érvénytelen → alapérték. */
export function resolveStaleTurnMs(
  env: NodeJS.ProcessEnv = process.env,
  fallback = DEFAULT_STALE_TURN_MS,
): number {
  const parsed = Number.parseInt(env.AGENT_TURN_STALE_MS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export type TurnInterruptKind = 'watchdog' | 'wallclock_timeout'

function describeWatchdogClosure(): string {
  return (
    '⚠️ **A válasz megszakadt.** A futtató folyamat váratlanul leállt ' +
    '(újraindítás vagy infrastruktúra-hiba), mielőtt a forduló befejeződött volna. ' +
    'Amit addig összegyűjtöttem, megmaradt — küldd el újra a kérdést, és újra nekifutok.'
  )
}

function describeWallclockClosure(): string {
  return (
    '⏱️ **A válasz megszakadt, mert a futási keret letelt.** Egy aktív szakasz ' +
    'legfeljebb 30 percig tarthat (a sorban állás és a jóváhagyási várakozás nem számít bele). ' +
    'Amit addig összegyűjtöttem, megmaradt — küldd el újra a kérdést, és újra nekifutok.'
  )
}

/** Részszöveg + megszakítás-jelölés egy agent-üzenetbe. */
export function buildWatchdogClosingMessage(
  partialText: string,
  kind: TurnInterruptKind = 'watchdog',
): string {
  const guarded = guardTurnPartialText(partialText).trim()
  const notice = kind === 'wallclock_timeout' ? describeWallclockClosure() : describeWatchdogClosure()
  if (!guarded) return notice
  return `${guarded}\n\n${notice}`
}

export type WatchdogConversationWriter = {
  appendMessage(params: {
    conversationId: string
    role: MessageRole
    content: string
    actingUserId?: string | null
    agentVersion?: number | null
    actorType?: 'system' | 'agent' | 'human'
    actorId?: string | null
  }): Promise<Pick<Message, 'id'>>
}

export type CloseTurnAsWatchdogDeps = {
  turns: Pick<AgentTurnRepository, 'finalize'>
  conversations: WatchdogConversationWriter
}

export type ReclaimStaleAgentTurnsDeps = CloseTurnAsWatchdogDeps & {
  turns: Pick<AgentTurnRepository, 'findStale' | 'findOwnedStartedBefore' | 'finalize'>
  /** Alapértelmezés: `resolveStaleTurnMs()`. */
  staleAfterMs?: number
  /** Alapértelmezés: `CHAT_TURN_ACTIVE_PHASE_MS`. */
  activePhaseMs?: number
  limit?: number
  now?: Date
}

export type ReclaimStaleAgentTurnResult = {
  turnId: string
  status: 'reclaimed' | 'skipped'
}

/**
 * Egy aktív forduló megszakítása: feltételes finalize, majd lezáró üzenet.
 * `skipped`, ha közben más már lezárta. A részszöveg és az aktivitások a
 * rekordon maradnak — v1-ben nincs automatikus loop-replay.
 */
export async function closeTurnAsWatchdog(
  deps: CloseTurnAsWatchdogDeps,
  turn: AgentTurn,
  now: Date = new Date(),
  kind: TurnInterruptKind = 'watchdog',
): Promise<ReclaimStaleAgentTurnResult> {
  const partialText = typeof turn.partialText === 'string' ? turn.partialText : ''
  const guardedPartial = guardTurnPartialText(partialText)
  const isWallclock = kind === 'wallclock_timeout'

  const finalized = await deps.turns.finalize(turn.id, {
    status: isWallclock ? 'exhausted' : 'failed',
    reason: isWallclock ? 'wallclock_timeout' : 'watchdog',
    error: isWallclock ? WALLCLOCK_TURN_ERROR : WATCHDOG_TURN_ERROR,
    finishedAt: now,
    partialText: guardedPartial,
    ...(turn.activities != null
      ? { activities: turn.activities as Prisma.InputJsonValue }
      : {}),
  })

  if (!finalized) {
    return { turnId: turn.id, status: 'skipped' }
  }

  try {
    await deps.conversations.appendMessage({
      conversationId: turn.conversationId,
      role: 'agent',
      content: buildWatchdogClosingMessage(partialText, kind),
      actingUserId: turn.createdById,
      agentVersion: turn.agentVersion,
      actorType: 'agent',
      actorId: turn.agentId,
    })
  } catch (error) {
    console.error('[agent-turn-watchdog] lezáró üzenet írása sikertelen', turn.id, error)
  }

  return { turnId: turn.id, status: 'reclaimed' }
}

/**
 * Elavult heartbeatű VAGY a 30 perces szakaszkeretet túllépő aktív fordulók
 * lezárása a dispatch-ciklus reclaim-fázisában. Stale running loopot nem
 * játssza újra.
 */
export async function reclaimStaleAgentTurns(
  deps: ReclaimStaleAgentTurnsDeps,
): Promise<ReclaimStaleAgentTurnResult[]> {
  const staleAfterMs = deps.staleAfterMs ?? resolveStaleTurnMs()
  const activePhaseMs = deps.activePhaseMs ?? CHAT_TURN_ACTIVE_PHASE_MS
  const limit = deps.limit ?? 20
  const now = deps.now ?? new Date()
  const heartbeatCutoff = new Date(now.getTime() - staleAfterMs)
  const startedCutoff = new Date(now.getTime() - activePhaseMs)

  const stale = await deps.turns.findStale(heartbeatCutoff, limit)
  const results: ReclaimStaleAgentTurnResult[] = []
  const seen = new Set<string>()

  for (const turn of stale) {
    seen.add(turn.id)
    results.push(await closeTurnAsWatchdog(deps, turn, now))
  }

  const expired = await deps.turns.findOwnedStartedBefore(startedCutoff, limit)
  for (const turn of expired) {
    if (seen.has(turn.id)) continue
    results.push(await closeTurnAsWatchdog(deps, turn, now, 'wallclock_timeout'))
  }

  return results
}
