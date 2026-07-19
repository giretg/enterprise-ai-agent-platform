/**
 * chat-agent-turn-resilience-spec.md §7 / D10 — beragadt AgentTurn watchdog
 * (issue #64 / E6).
 *
 * A futtató process crash/deploy alatt elvágott fordulói `running` állapotban
 * maradnának, heartbeat nélkül — a beszélgetés örökre „gépel" lenne. Ez a
 * modul a meglévő dispatch-ciklus reclaim-fázisára ül: az elavult
 * heartbeatű aktív fordulókat `failed`/`watchdog` végállapotba zárja, a
 * lockot elengedi, és hétköznapi nyelvű lezáró üzenetet ír a beszélgetésbe.
 *
 * Az indítási út lazy reclaimje (`agent-chat-runtime`) ugyanazt a
 * `closeTurnAsWatchdog` lezárást hívja — egy forrás a státuszra és az üzenetre.
 */
import type { AgentTurn, Message, MessageRole } from '@prisma/client'
import type { AgentTurnRepository } from '@/repositories/interfaces'
import { guardTurnPartialText } from './agent-turn-snapshot'

/** Spec §7 / D10 — dokumentált alapérték (~120 mp). */
export const DEFAULT_STALE_TURN_MS = 120_000

/** A forduló-rekordra írt hibaszöveg — lazy és ciklusos reclaim közös. */
export const WATCHDOG_TURN_ERROR =
  'A futtató process leállt a forduló közben (heartbeat elmaradt).'

/** Env: `AGENT_TURN_STALE_MS` — pozitív egész ms; érvénytelen → alapérték. */
export function resolveStaleTurnMs(
  env: NodeJS.ProcessEnv = process.env,
  fallback = DEFAULT_STALE_TURN_MS,
): number {
  const parsed = Number.parseInt(env.AGENT_TURN_STALE_MS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Hétköznapi nyelvű, önmagyarázó lezáró szöveg (közérthető-UI elv): mi történt,
 * mi maradt meg, és hogyan tovább (újrapróbálás).
 */
function describeWatchdogClosure(): string {
  return (
    '⚠️ **A válasz megszakadt.** A futtató folyamat váratlanul leállt ' +
    '(újraindítás vagy infrastruktúra-hiba), mielőtt a forduló befejeződött volna. ' +
    'Amit addig összegyűjtöttem, megmaradt — küldd el újra a kérdést, és újra nekifutok.'
  )
}

/** Részszöveg + watchdog-jelölés egy agent-üzenetbe. */
export function buildWatchdogClosingMessage(partialText: string): string {
  const guarded = guardTurnPartialText(partialText).trim()
  const notice = describeWatchdogClosure()
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
  turns: Pick<AgentTurnRepository, 'findStale' | 'finalize'>
  /** Alapértelmezés: `resolveStaleTurnMs()`. */
  staleAfterMs?: number
  limit?: number
  now?: Date
}

export type ReclaimStaleAgentTurnResult = {
  turnId: string
  status: 'reclaimed' | 'skipped'
}

/**
 * Egy aktív forduló watchdog-lezárása: feltételes `failed`/`watchdog` finalize,
 * majd lezáró üzenet a beszélgetésbe. `skipped`, ha közben más már lezárta.
 */
export async function closeTurnAsWatchdog(
  deps: CloseTurnAsWatchdogDeps,
  turn: AgentTurn,
  now: Date = new Date(),
): Promise<ReclaimStaleAgentTurnResult> {
  const partialText = typeof turn.partialText === 'string' ? turn.partialText : ''
  const guardedPartial = guardTurnPartialText(partialText)

  // Először a feltételes lezárás: ha a runner (vagy más reclaim) már terminálisba
  // vitte, ne írjunk árva „megszakadt" üzenetet a kész válasz mellé.
  const finalized = await deps.turns.finalize(turn.id, {
    status: 'failed',
    reason: 'watchdog',
    error: WATCHDOG_TURN_ERROR,
    finishedAt: now,
    partialText: guardedPartial,
  })

  if (!finalized) {
    return { turnId: turn.id, status: 'skipped' }
  }

  try {
    await deps.conversations.appendMessage({
      conversationId: turn.conversationId,
      role: 'agent',
      content: buildWatchdogClosingMessage(partialText),
      actingUserId: turn.createdById,
      agentVersion: turn.agentVersion,
      actorType: 'agent',
      actorId: turn.agentId,
    })
  } catch (error) {
    // A forduló már lezárult (a beszélgetés nincs beragadva); az üzenet hiánya
    // megfigyelhetőségi veszteség, nem állapot-hiba.
    console.error('[agent-turn-watchdog] lezáró üzenet írása sikertelen', turn.id, error)
  }

  return { turnId: turn.id, status: 'reclaimed' }
}

/**
 * Elavult heartbeatű aktív fordulók lezárása a dispatch-ciklus reclaim-fázisában.
 */
export async function reclaimStaleAgentTurns(
  deps: ReclaimStaleAgentTurnsDeps,
): Promise<ReclaimStaleAgentTurnResult[]> {
  const staleAfterMs = deps.staleAfterMs ?? resolveStaleTurnMs()
  const limit = deps.limit ?? 20
  const now = deps.now ?? new Date()
  const cutoff = new Date(now.getTime() - staleAfterMs)

  const stale = await deps.turns.findStale(cutoff, limit)
  const results: ReclaimStaleAgentTurnResult[] = []

  for (const turn of stale) {
    results.push(await closeTurnAsWatchdog(deps, turn, now))
  }

  return results
}
