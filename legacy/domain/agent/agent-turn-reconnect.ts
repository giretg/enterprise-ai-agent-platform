/**
 * chat-agent-turn-resilience-spec.md §6.3–6.4 / E2 / E8 / E10 (issue #66) —
 * a visszacsatlakozó stream tiszta, injektálható magja.
 *
 * A route (`/api/v1/agent-chat/turns/[turnId]/stream`) csak vékony SSE-adapter:
 * a snapshot → delta → lezáró-esemény folyamat ide van kiszervezve, hogy élő DB
 * és HTTP nélkül is tesztelhető legyen (E2), és hogy a figyelési frekvencia egy
 * helyen, dokumentált alapértékkel legyen konfigurálható.
 */
import type { ToolLoopActivityEvent } from './chat-tool-loop'
import type { AgentChatStreamEvent } from './agent-turn-runner'
import { ACTIVE_AGENT_TURN_STATUSES } from '@/repositories/interfaces'
import { readPositiveInt } from '@/lib/read-positive-int'

/**
 * A DB-figyelés dokumentált alapértéke (spec §6.3, ~750 ms). Csak akkor lép
 * életbe, ha a fordulót NEM a jelen process futtatja (nincs élő event-busz), így
 * a másik instance által futtatott fordulóhoz (E10) is teljes kép jut vissza.
 */
export const AGENT_TURN_RECONNECT_POLL_DEFAULT_MS = 750

/** A figyelési frekvenciát felülíró környezeti változó (ms). */
export const AGENT_TURN_RECONNECT_POLL_ENV = 'AGENT_TURN_RECONNECT_POLL_MS'

/**
 * A konfigurált figyelési frekvencia ms-ben. Érvénytelen / nem pozitív érték
 * esetén a dokumentált alapértékre esik vissza.
 */
export function resolveReconnectPollMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return readPositiveInt(env[AGENT_TURN_RECONNECT_POLL_ENV], AGENT_TURN_RECONNECT_POLL_DEFAULT_MS)
}

/**
 * A KLIENS-oldali életjel-poll (`useAgentChatTurnLiveness`) alapértéke. Ez NEM a
 * fenti szerver-oldali DB-figyelési kadencia: a böngésző az élő SSE-stream
 * MELLETT pollozza ezt a végpontot, pusztán stall-érzékelésre és
 * részszöveg-backstopként arra az esetre, ha a stream megszakad. Ehhez 5 mp
 * bőven elég. Korábban a hook a 750 ms-es DB-kadenciát használta kliens
 * HTTP-poll ütemének, ami forduló-futásonként ~1,3 kérés/mp fölösleges
 * Cloud Run + Neon terhelést jelentett (a stream már szállítja ugyanazt).
 * A `NEXT_PUBLIC_` előtag kell, hogy az érték a kliens-bundle-be is bekerüljön.
 */
export const AGENT_TURN_LIVENESS_POLL_DEFAULT_MS = 5000

/** A kliens-életjel-poll frekvenciáját felülíró (build-időben beégő) változó. */
export const AGENT_TURN_LIVENESS_POLL_ENV = 'NEXT_PUBLIC_AGENT_TURN_LIVENESS_POLL_MS'

/**
 * A kliens-életjel-poll konfigurált frekvenciája ms-ben. Érvénytelen / nem
 * pozitív érték esetén a dokumentált alapértékre esik vissza.
 */
export function resolveLivenessPollMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return readPositiveInt(env[AGENT_TURN_LIVENESS_POLL_ENV], AGENT_TURN_LIVENESS_POLL_DEFAULT_MS)
}

/**
 * A visszacsatlakozáshoz szükséges forduló-mezők strukturális halmaza — a
 * Prisma `AgentTurn` sor ezt kielégíti, de a mag nem kötődik a Prisma típushoz.
 */
export type ReconnectTurnState = {
  id: string
  status: string
  partialText: string
  activities: unknown
  conversationId: string
  userMessageId: string | null
  assistantMessageId: string | null
  error: string | null
  reason: string | null
}

export function isTerminalTurnStatus(status: string): boolean {
  return !(ACTIVE_AGENT_TURN_STATUSES as readonly string[]).includes(status)
}

/** A stream első eseménye (spec §6.3): a perzisztált pillanatkép. */
export function snapshotEvent(turn: ReconnectTurnState): AgentChatStreamEvent {
  return {
    type: 'snapshot',
    turnId: turn.id,
    status: turn.status,
    partialText: turn.partialText,
    activities: turn.activities,
    conversationId: turn.conversationId,
    userMessageId: turn.userMessageId,
  }
}

/** A lezáró esemény egy terminális forduló-rekordból (spec §6.3, E8). */
export function terminalEventForTurn(turn: ReconnectTurnState): AgentChatStreamEvent {
  if (turn.status === 'cancelled' && turn.assistantMessageId) {
    return {
      type: 'done',
      conversationId: turn.conversationId,
      messageId: turn.assistantMessageId,
      reason: 'cancelled',
    }
  }
  if (turn.assistantMessageId) {
    return {
      type: 'done',
      conversationId: turn.conversationId,
      messageId: turn.assistantMessageId,
    }
  }
  if (turn.status === 'failed') {
    return {
      type: 'error',
      message: turn.error ?? turn.reason ?? 'A forduló hibával zárult.',
    }
  }
  return {
    type: 'done',
    conversationId: turn.conversationId,
    messageId: turn.assistantMessageId ?? turn.id,
    ...(turn.status === 'cancelled' ? { reason: 'cancelled' as const } : {}),
  }
}

export type ReconnectSleep = (ms: number, signal: AbortSignal) => Promise<void>

/** Abort-ra azonnal feloldó időzített várakozás — a poll-loop üteme. */
export const defaultReconnectSleep: ReconnectSleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

export type ReconnectDeps = {
  /** A forduló-rekord friss állapota — a DB-figyelés forrása. */
  findById: (turnId: string) => Promise<ReconnectTurnState | null>
  /**
   * Élő event-busz feliratkozás, ha a fordulót EZ a process futtatja; `null`,
   * ha máshol fut (E10) — ekkor a DB-poll fallback lép életbe.
   */
  subscribe: (turnId: string) => AsyncGenerator<AgentChatStreamEvent, void, unknown> | null
  signal: AbortSignal
  /** Figyelési frekvencia ms-ben; alapértelmezés: {@link resolveReconnectPollMs}. */
  pollMs?: number
  /** Injektálható várakozás (tesztekhez). */
  sleep?: ReconnectSleep
}

/**
 * A teljes visszacsatlakozó folyam: snapshot → (terminális esetén azonnali
 * lezárás | aktív esetén delta-figyelés a lezárásig). A route ezt iterálja és
 * SSE-be kódolja; a teszt közvetlenül fogyasztja.
 */
export async function* streamTurnReconnect(
  turn: ReconnectTurnState,
  deps: ReconnectDeps,
): AsyncGenerator<AgentChatStreamEvent, void, unknown> {
  yield snapshotEvent(turn)

  if (isTerminalTurnStatus(turn.status)) {
    yield terminalEventForTurn(turn)
    return
  }

  yield* subscribeOrPoll(turn, deps)
}

function snapshotActivityIds(activities: unknown): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(activities)) return ids
  for (const item of activities) {
    if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
      ids.add(item.id)
    }
  }
  return ids
}

/**
 * Élő busz: a runner nulláról játssza vissza a buffert, a kliens viszont már
 * megkapta a DB-snapshotot. A snapshotban lévő részszöveget / activity-ket
 * elnyeljük (mint a poll-út lastPartial baseline-ja), hogy ne duplázódjanak;
 * a snapshot activity id-k első előfordulása utáni frissítések átmennek.
 */
async function* filterLiveAfterSnapshot(
  turn: ReconnectTurnState,
  live: AsyncGenerator<AgentChatStreamEvent, void, unknown>,
  signal: AbortSignal,
): AsyncGenerator<AgentChatStreamEvent, void, unknown> {
  let skipChars = turn.partialText.length
  const skipActivityIds = snapshotActivityIds(turn.activities)

  for await (const event of live) {
    if (signal.aborted) return
    // A busz belső eseményei (forduló-azonosító, meta, ütközés) nem tartoznak
    // a visszacsatlakozó nézethez — a delta/lezáró eseményeket továbbküldjük.
    if (event.type === 'turn' || event.type === 'meta' || event.type === 'conflict') continue

    if (event.type === 'token' && skipChars > 0) {
      if (event.chunk.length <= skipChars) {
        skipChars -= event.chunk.length
        continue
      }
      const rest = event.chunk.slice(skipChars)
      skipChars = 0
      yield { type: 'token', chunk: rest }
      continue
    }

    if (event.type === 'activity' && skipActivityIds.has(event.activity.id)) {
      skipActivityIds.delete(event.activity.id)
      continue
    }

    yield event
    if (event.type === 'done' || event.type === 'error') return
  }
}

async function* subscribeOrPoll(
  turn: ReconnectTurnState,
  deps: ReconnectDeps,
): AsyncGenerator<AgentChatStreamEvent, void, unknown> {
  const { signal } = deps
  const turnId = turn.id
  const conversationId = turn.conversationId

  const live = deps.subscribe(turnId)
  if (live) {
    let sawTerminal = false
    let lastPartial = turn.partialText
    const snapshotActivities = Array.isArray(turn.activities) ? turn.activities : []
    let lastActivityCount = snapshotActivities.length

    for await (const event of filterLiveAfterSnapshot(turn, live, signal)) {
      if (event.type === 'token') lastPartial += event.chunk
      if (event.type === 'activity') lastActivityCount += 1
      yield event
      if (event.type === 'done' || event.type === 'error') {
        sawTerminal = true
        break
      }
    }

    if (sawTerminal || signal.aborted) return

    // Az élő busz lezárulhat terminális esemény nélkül (pl. a futás a done
    // elküldése előtt kikerült a registryből, vagy a feliratkozás elszakadt).
    // Ilyenkor a DB-poll fallback zárja a streamet — különben a kliens üres
    // buborékkal marad, miközben a válasz már perzisztálva van.
    yield* pollUntilTerminal(
      {
        turnId,
        conversationId,
        lastPartial,
        lastActivityCount,
      },
      deps,
    )
    return
  }

  const snapshotActivities = Array.isArray(turn.activities) ? turn.activities : []
  yield* pollUntilTerminal(
    {
      turnId,
      conversationId,
      lastPartial: turn.partialText,
      lastActivityCount: snapshotActivities.length,
    },
    deps,
  )
}

async function* pollUntilTerminal(
  baseline: {
    turnId: string
    conversationId: string
    lastPartial: string
    lastActivityCount: number
  },
  deps: ReconnectDeps,
): AsyncGenerator<AgentChatStreamEvent, void, unknown> {
  const { signal } = deps
  const pollMs = deps.pollMs ?? resolveReconnectPollMs()
  const sleep = deps.sleep ?? defaultReconnectSleep

  // A poll-delta a MÁR kiküldött pillanatképhez / live-deltához képest számol:
  // a kliens kiindulópontja a lastPartial; a token-eseményeket ő ehhez fűzi. Ha
  // itt üresről indulnánk, az első poll a teljes részszöveget újraküldené, és a
  // kliens megduplázná. Az aktivitások id-alapú upsertje idempotens, de a már
  // látott elemeket sem küldjük újra.
  let lastPartial = baseline.lastPartial
  let lastActivityCount = baseline.lastActivityCount

  while (!signal.aborted) {
    const current = await deps.findById(baseline.turnId)
    if (!current) {
      yield { type: 'error', message: 'Turn disappeared' }
      return
    }

    if (current.partialText !== lastPartial) {
      const delta = current.partialText.slice(lastPartial.length)
      if (delta) yield { type: 'token', chunk: delta }
      lastPartial = current.partialText
    }
    const activities = Array.isArray(current.activities) ? current.activities : []
    if (activities.length > lastActivityCount) {
      for (const activity of activities.slice(lastActivityCount)) {
        yield { type: 'activity', activity: activity as ToolLoopActivityEvent }
      }
      lastActivityCount = activities.length
    }

    if (isTerminalTurnStatus(current.status)) {
      yield terminalEventForTurn({ ...current, conversationId: baseline.conversationId })
      return
    }

    await sleep(pollMs, signal)
  }
}
