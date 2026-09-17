/**
 * #517 — tartós chat-forduló indítás-helyreállítás.
 *
 * A dispatch/egyeztető ciklus megtalálja a tartós, még el nem indult (`queued`)
 * igényeket. A kérés-út gyors launchja csak optimalizáció: processzhalál vagy
 * elveszett válasz után ez a modul indít / egyeztet. Stale *running* loopot
 * NEM játssza újra — az a watchdogé.
 */
import { randomUUID } from 'node:crypto'
import type { AgentTurn } from '@prisma/client'
import type { AgentTurnRepository } from '@/repositories/interfaces'
import type { WatchdogConversationWriter } from './agent-turn-watchdog'
import {
  ChatTurnLaunchRejectedError,
  type ChatTurnLauncher,
} from './chat-turn-launcher'

/** Biztos hiba-felismerési határ, ha az indítás elfogadott, de nincs claim (#508 §5.3). */
export const CHAT_TURN_LAUNCH_DEADLINE_MS = 10 * 60 * 1000
/** Elveszett / ismeretlen kimenetelű válasz után ennyi idő múlva egyeztetünk. */
export const CHAT_TURN_LAUNCH_UNKNOWN_RETRY_MS = 30_000
const RETRY_BASE_MS = 15_000
const RETRY_CAP_MS = 5 * 60_000
export const CHAT_TURN_LAUNCH_MAX_ATTEMPTS = 5

export const LAUNCH_FAILED_REASON = 'launch_failed'
export const LAUNCH_FAILED_TURN_ERROR =
  'A feladat indítása többszöri próbálkozás után sem sikerült.'

export type LaunchAcceptedResult =
  | { kind: 'launched' }
  | { kind: 'pending' }
  | { kind: 'already_running' }
  | { kind: 'ignored' }
  | { kind: 'failed'; error: string }

export type RecoverQueuedChatTurnsDeps = {
  turns: Pick<
    AgentTurnRepository,
    'findQueuedForLaunch' | 'findById' | 'recordLaunchAttempt' | 'finalize'
  >
  launcher: ChatTurnLauncher
  conversations?: WatchdogConversationWriter
  now?: Date
  limit?: number
}

export type RecoverQueuedChatTurnsSummary = {
  scanned: number
  launched: number
  failed: number
}

export function classifyChatTurnLaunchError(error: unknown): 'permanent' | 'transient' {
  if (error instanceof ChatTurnLaunchRejectedError) return 'permanent'
  const message = error instanceof Error ? error.message : String(error)
  if (
    /Nem támogatott CHAT_TURN_LAUNCHER_MODE/i.test(message) ||
    /\b4\d\d\b/.test(message) ||
    /unauthorized/i.test(message) ||
    /forbidden/i.test(message)
  ) {
    return 'permanent'
  }
  return 'transient'
}

function retryDelayMs(attemptCount: number): number {
  const exp = Math.max(attemptCount - 1, 0)
  return Math.min(RETRY_BASE_MS * 2 ** exp, RETRY_CAP_MS)
}

function launchFailedUserMessage(error: string): string {
  return (
    `⚠️ **A feladat nem indult el.** ${error} ` +
    'A beszélgetés szabad — küldd el újra, ha újra próbálnád.'
  )
}

async function failQueuedLaunch(
  deps: {
    turns: Pick<AgentTurnRepository, 'finalize'>
    conversations?: WatchdogConversationWriter
  },
  turn: AgentTurn,
  error: string,
  now: Date,
): Promise<void> {
  const finalized = await deps.turns.finalize(turn.id, {
    status: 'failed',
    reason: LAUNCH_FAILED_REASON,
    error,
    finishedAt: now,
  })
  if (!finalized || !deps.conversations) return
  try {
    await deps.conversations.appendMessage({
      conversationId: turn.conversationId,
      role: 'agent',
      content: launchFailedUserMessage(error),
      actingUserId: turn.createdById,
      agentVersion: turn.agentVersion,
      actorType: 'agent',
      actorId: turn.agentId,
    })
  } catch (appendError) {
    console.error('[chat-turn-launch] lezáró üzenet írása sikertelen', turn.id, appendError)
  }
}

/**
 * Egy már tartósan fogadott queued forduló indítása vagy egyeztetése.
 * Ugyanezt hívja a kérés-út gyors próbálkozása és a dispatch-ciklus.
 */
export async function launchAcceptedChatTurn(
  deps: {
    turns: Pick<AgentTurnRepository, 'findById' | 'recordLaunchAttempt' | 'finalize'>
    launcher: ChatTurnLauncher
    conversations?: WatchdogConversationWriter
  },
  turn: AgentTurn,
  now: Date = new Date(),
): Promise<LaunchAcceptedResult> {
  if (turn.status !== 'queued' || turn.cancelRequested || !turn.userMessageId) {
    return { kind: 'ignored' }
  }

  if (turn.launchId) {
    const rec = await deps.launcher.reconcile({
      turnId: turn.id,
      launchId: turn.launchId,
      providerRef: turn.launchProviderRef,
    })
    if (rec.state === 'running') {
      await deps.turns.recordLaunchAttempt(turn.id, {
        launchId: turn.launchId,
        nextRetryAt: new Date(now.getTime() + CHAT_TURN_LAUNCH_UNKNOWN_RETRY_MS),
        incrementAttempt: false,
        providerRef: rec.providerRef ?? turn.launchProviderRef,
      })
      return { kind: 'already_running' }
    }
    const latest = await deps.turns.findById(turn.id)
    if (!latest || latest.status !== 'queued') return { kind: 'ignored' }
    turn = latest
    if (turn.launchAttemptCount >= CHAT_TURN_LAUNCH_MAX_ATTEMPTS) {
      await failQueuedLaunch(deps, turn, LAUNCH_FAILED_TURN_ERROR, now)
      return { kind: 'failed', error: LAUNCH_FAILED_TURN_ERROR }
    }
  }

  // Elfogadott (provider-refes) attempt újrapróbálása: új azonosító, a régi worker ne claimelhessen.
  const launchId =
    turn.launchId && !turn.launchProviderRef ? turn.launchId : randomUUID()

  const recorded = await deps.turns.recordLaunchAttempt(turn.id, {
    launchId,
    nextRetryAt: new Date(now.getTime() + CHAT_TURN_LAUNCH_UNKNOWN_RETRY_MS),
    incrementAttempt: true,
  })
  if (!recorded) return { kind: 'ignored' }

  try {
    const launched = await deps.launcher.launch({ turnId: turn.id, launchId })
    await deps.turns.recordLaunchAttempt(turn.id, {
      launchId,
      nextRetryAt: new Date(now.getTime() + CHAT_TURN_LAUNCH_DEADLINE_MS),
      incrementAttempt: false,
      providerRef: launched.providerRef ?? launchId,
    })
    return launched.outcome === 'duplicate' ? { kind: 'already_running' } : { kind: 'launched' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (classifyChatTurnLaunchError(error) === 'permanent') {
      await failQueuedLaunch(deps, recorded, message, now)
      return { kind: 'failed', error: message }
    }
    await deps.turns.recordLaunchAttempt(turn.id, {
      launchId,
      nextRetryAt: new Date(now.getTime() + retryDelayMs(recorded.launchAttemptCount)),
      incrementAttempt: false,
      providerRef: null,
    })
    return { kind: 'pending' }
  }
}

export async function recoverQueuedChatTurns(
  deps: RecoverQueuedChatTurnsDeps,
): Promise<RecoverQueuedChatTurnsSummary> {
  const now = deps.now ?? new Date()
  const due = await deps.turns.findQueuedForLaunch(now, deps.limit ?? 20)
  const summary: RecoverQueuedChatTurnsSummary = { scanned: due.length, launched: 0, failed: 0 }
  for (const turn of due) {
    const result = await launchAcceptedChatTurn(deps, turn, now)
    if (result.kind === 'launched') summary.launched += 1
    if (result.kind === 'failed') summary.failed += 1
  }
  return summary
}
