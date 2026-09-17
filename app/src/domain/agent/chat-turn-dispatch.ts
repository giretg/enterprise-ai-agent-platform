/**
 * #517 — tartós chat-forduló indítás-helyreállítás.
 * #518 — kapacitáskorlátos sorban állás.
 *
 * A dispatch/egyeztető ciklus megtalálja a tartós, még el nem indult (`queued`)
 * igényeket. A kérés-út gyors launchja csak optimalizáció: processzhalál vagy
 * elveszett válasz után ez a modul indít / egyeztet. Stale *running* loopot
 * NEM játssza újra — az a watchdogé.
 *
 * Három, külön mért szakasz egy `queued` rekordon belül:
 *   - kapacitásra vár:  `launchId == null` — nem számít a limitbe, nincs attempt,
 *                       a 10 perces indítási határ nem vonatkozik rá;
 *   - indításra foglalva: `launchId != null` (`launchReservedAt`) — foglalja a
 *                       helyet, attempt/deadline/reconcile (#517) él;
 *   - fut:              `running`/`streaming` (claim, `startedAt`).
 */
import { randomUUID } from 'node:crypto'
import type { AgentTurn } from '@prisma/client'
import type { AgentTurnRepository, ChatTurnCapacityLimits } from '@/repositories/interfaces'
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

/** Véges alapértékek (#508 §5.3) — a demó tényleges értékei a deploy-konfigból. */
export const DEFAULT_CHAT_TURN_MAX_ACTIVE_GLOBAL = 6
export const DEFAULT_CHAT_TURN_MAX_ACTIVE_PER_TENANT = 3

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Env: `CHAT_TURN_MAX_ACTIVE_GLOBAL`, `CHAT_TURN_MAX_ACTIVE_PER_TENANT` — pozitív egész; érvénytelen → alapérték. */
export function resolveChatTurnCapacity(
  env: Record<string, string | undefined> = process.env,
): ChatTurnCapacityLimits {
  return {
    global: positiveInt(env.CHAT_TURN_MAX_ACTIVE_GLOBAL, DEFAULT_CHAT_TURN_MAX_ACTIVE_GLOBAL),
    perTenant: positiveInt(
      env.CHAT_TURN_MAX_ACTIVE_PER_TENANT,
      DEFAULT_CHAT_TURN_MAX_ACTIVE_PER_TENANT,
    ),
  }
}
export const LAUNCH_FAILED_TURN_ERROR =
  'A feladat indítása többszöri próbálkozás után sem sikerült.'

export type LaunchAcceptedResult =
  | { kind: 'launched' }
  | { kind: 'pending' }
  | { kind: 'already_running' }
  | { kind: 'waiting'; reason: 'global_full' | 'tenant_full' }
  | { kind: 'cancelled' }
  | { kind: 'ignored' }
  | { kind: 'failed'; error: string }

export type LaunchAcceptedChatTurnDeps = {
  turns: Pick<
    AgentTurnRepository,
    'findById' | 'recordLaunchAttempt' | 'reserveLaunchCapacity' | 'finalize'
  >
  launcher: ChatTurnLauncher
  conversations?: WatchdogConversationWriter
  /** Alapértelmezés: `resolveChatTurnCapacity()`. */
  capacity?: ChatTurnCapacityLimits
}

export type RecoverQueuedChatTurnsDeps = LaunchAcceptedChatTurnDeps & {
  turns: LaunchAcceptedChatTurnDeps['turns'] & Pick<AgentTurnRepository, 'findQueuedForLaunch'>
  now?: Date
  limit?: number
}

export type RecoverQueuedChatTurnsSummary = {
  scanned: number
  launched: number
  failed: number
  /** Kapacitásra váró sorok, amiket ebben a körben nem lehetett lefoglalni. */
  waiting: number
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
 * Queued Stop (#508 §5.3): a még el nem indult sor tulajdonos nélkül zárható,
 * a kapacitás-hely felszabadul. Ha közben claimelték, a `null`-token feltétel
 * nem enged, és a futó loop maga áll le a `cancelRequested` flagből.
 * A Stop-út azonnal hívja; a dispatch-ciklus a lemaradtakat söpri.
 */
export async function cancelQueuedChatTurn(
  turns: Pick<AgentTurnRepository, 'finalize'>,
  turnId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const closed = await turns.finalize(
    turnId,
    { status: 'cancelled', reason: 'stop', finishedAt: now },
    null,
  )
  return closed !== null
}

/**
 * Egy már tartósan fogadott queued forduló indítása vagy egyeztetése.
 * Ugyanezt hívja a kérés-út gyors próbálkozása és a dispatch-ciklus.
 */
export async function launchAcceptedChatTurn(
  deps: LaunchAcceptedChatTurnDeps,
  turn: AgentTurn,
  now: Date = new Date(),
): Promise<LaunchAcceptedResult> {
  if (turn.status !== 'queued' || !turn.userMessageId) {
    return { kind: 'ignored' }
  }
  if (turn.cancelRequested) {
    const closed = await cancelQueuedChatTurn(deps.turns, turn.id, now)
    return closed ? { kind: 'cancelled' } : { kind: 'ignored' }
  }

  if (!turn.launchId) {
    // Kapacitásra váró sor: a hely foglalása atomi (globális + tenant limit).
    // Sikertelen foglalás nem attempt és nem hiba — a következő kör újra néz.
    const launchId = randomUUID()
    const reserved = await deps.turns.reserveLaunchCapacity(
      turn.id,
      {
        launchId,
        nextRetryAt: new Date(now.getTime() + CHAT_TURN_LAUNCH_UNKNOWN_RETRY_MS),
        limits: deps.capacity ?? resolveChatTurnCapacity(),
      },
      now,
    )
    if (reserved === 'global_full' || reserved === 'tenant_full') {
      return { kind: 'waiting', reason: reserved }
    }
    if (reserved !== 'reserved') return { kind: 'ignored' }
    const recorded = await deps.turns.findById(turn.id)
    if (!recorded || recorded.status !== 'queued') return { kind: 'ignored' }
    return launchReserved(deps, recorded, launchId, now)
  }

  // Indításra lefoglalt sor (#517): egyeztetés a szolgáltatói ref / helyi futás
  // alapján; elveszett válasz nem végleges hiba.
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
  if (!latest || latest.status !== 'queued' || !latest.launchId) return { kind: 'ignored' }
  turn = latest
  if (turn.launchAttemptCount >= CHAT_TURN_LAUNCH_MAX_ATTEMPTS) {
    await failQueuedLaunch(deps, turn, LAUNCH_FAILED_TURN_ERROR, now)
    return { kind: 'failed', error: LAUNCH_FAILED_TURN_ERROR }
  }

  // #519: a lejárt attempt érvénytelen — új launchId, a késői worker a régivel
  // nem claimelhet, akkor sem, ha az első indításnak nem lett provider-refje.
  const launchId = randomUUID()

  const recorded = await deps.turns.recordLaunchAttempt(turn.id, {
    launchId,
    nextRetryAt: new Date(now.getTime() + CHAT_TURN_LAUNCH_UNKNOWN_RETRY_MS),
    incrementAttempt: true,
  })
  if (!recorded) return { kind: 'ignored' }
  return launchReserved(deps, recorded, launchId, now)
}

/** Indítás egy már lefoglalt (launchId-s) fordulóra; a hiba-osztályozás #517. */
async function launchReserved(
  deps: LaunchAcceptedChatTurnDeps,
  turn: AgentTurn,
  launchId: string,
  now: Date,
): Promise<LaunchAcceptedResult> {
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
      await failQueuedLaunch(deps, turn, message, now)
      return { kind: 'failed', error: message }
    }
    await deps.turns.recordLaunchAttempt(turn.id, {
      launchId,
      nextRetryAt: new Date(now.getTime() + retryDelayMs(turn.launchAttemptCount)),
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
  const summary: RecoverQueuedChatTurnsSummary = {
    scanned: due.length,
    launched: 0,
    failed: 0,
    waiting: 0,
  }
  // Telített tenant sorát átugorjuk (nincs head-of-line blokkolás); telített
  // globális kapacitásnál csak a Stop-olt sorokat zárjuk még le.
  const fullTenants = new Set<string | null>()
  let globalFull = false
  for (const turn of due) {
    if (!turn.cancelRequested && !turn.launchId && (globalFull || fullTenants.has(turn.tenantId))) {
      summary.waiting += 1
      continue
    }
    const result = await launchAcceptedChatTurn(deps, turn, now)
    if (result.kind === 'launched') summary.launched += 1
    if (result.kind === 'failed') summary.failed += 1
    if (result.kind === 'waiting') {
      summary.waiting += 1
      if (result.reason === 'global_full') globalFull = true
      else fullTenants.add(turn.tenantId)
    }
  }
  return summary
}
