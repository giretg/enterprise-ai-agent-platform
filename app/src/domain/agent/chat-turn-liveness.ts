/**
 * Chat-forduló élőség a UI számára — a ticket `assessTicketRunLiveness` párja.
 *
 * A forduló `status` önmagában nem elég: crash / elhalt modellhívás után a rekord
 * `running` maradhat, miközben a `heartbeatAt` már percek óta nem frissül. A
 * watchdog (D10) ilyenkor lezárja — a UI viszont ne mutassa „éppen dolgozik".
 */
import type { ToolLoopActivityEvent } from '@/domain/agent/chat-tool-loop'
import { resolveStaleTurnMs } from '@/domain/agent/agent-turn-watchdog'
import { formatTicketProgressAge } from '@/domain/agent/ticket-runtime-progress'

/** Ennyi ideig „élőnek” számít a heartbeat (modell-hívás közben is). */
export const CHAT_TURN_PROGRESS_ACTIVE_MS = 45_000

const ACTIVE_CHAT_STATUSES = new Set(['queued', 'running', 'streaming'])

export type ChatTurnLiveness =
  | { kind: 'idle' }
  | { kind: 'cancelling' }
  /** #518 — kapacitásra vár: nincs futtatási hely; nem „elhalt", bármeddig várhat. */
  | { kind: 'queued'; ageMs: number }
  /** #518 — indításra lefoglalva, még nincs futó tulajdonos. Nem `starting`: az a claimelt, tool nélküli futás. */
  | { kind: 'launching'; ageMs: number }
  | { kind: 'starting'; ageMs: number }
  | { kind: 'active'; ageMs: number; currentStep: string | null }
  | { kind: 'quiet'; ageMs: number; currentStep: string | null }
  | { kind: 'stalled'; ageMs: number; currentStep: string | null }

export function isChatTurnLive(liveness: ChatTurnLiveness): boolean {
  switch (liveness.kind) {
    case 'queued':
    case 'launching':
    case 'starting':
    case 'active':
    case 'quiet':
    case 'cancelling':
      return true
    case 'idle':
    case 'stalled':
      return false
  }
}

export function describeChatTurnLiveness(liveness: ChatTurnLiveness): {
  label: string
  detail: string
} {
  switch (liveness.kind) {
    case 'cancelling':
      return {
        label: 'Leállítás folyamatban',
        detail: 'A stop kérés megérkezett; a válasz a következő biztonságos ponton zárul.',
      }
    case 'queued':
      return {
        label: 'Sorban áll',
        detail: `Vár a szabad futtatási helyre · ${formatTicketProgressAge(liveness.ageMs)}. Amint felszabadul egy hely, automatikusan elindul.`,
      }
    case 'launching':
      return {
        label: 'Indul…',
        detail: `A futtatási hely lefoglalva, a worker indulására várunk · ${formatTicketProgressAge(liveness.ageMs)}`,
      }
    case 'starting':
      return {
        label: 'Indul…',
        detail:
          liveness.ageMs > 0
            ? `Még nincs tool-hívás · ${formatTicketProgressAge(liveness.ageMs)}`
            : 'A forduló elindult, az első lépésre várunk.',
      }
    case 'active':
      return {
        label: 'Feldolgozás folyamatban',
        detail: liveness.currentStep
          ? `Most ezen dolgozik: ${liveness.currentStep}`
          : `Utolsó jelzés ${formatTicketProgressAge(liveness.ageMs)}`,
      }
    case 'quiet':
      return {
        label: 'Dolgozik — lassabb szakasz',
        detail: liveness.currentStep
          ? `Utolsó lépés: ${liveness.currentStep} · ${formatTicketProgressAge(liveness.ageMs)}`
          : `Nincs friss jelzés ${formatTicketProgressAge(liveness.ageMs)} — hosszú modell-hívás is lehet.`,
      }
    case 'stalled':
      return {
        label: 'Úgy tűnik megállt',
        detail: liveness.currentStep
          ? `Beragadt itt: ${liveness.currentStep} · nincs friss jelzés ${formatTicketProgressAge(liveness.ageMs)}`
          : `Nincs friss aktivitás ${formatTicketProgressAge(liveness.ageMs)}. Ha így marad, küldd újra a kérdést.`,
      }
    case 'idle':
      return {
        label: 'Kész',
        detail: 'Most nem fut válasz-generálás.',
      }
  }
}

function activityStepLabel(activity: ToolLoopActivityEvent | undefined): string | null {
  if (!activity) return null
  return activity.title?.trim() || activity.kind || null
}

function latestActivityStep(activities: ToolLoopActivityEvent[]): string | null {
  const running = activities.find((activity) => activity.status === 'running')
  return activityStepLabel(running ?? activities[activities.length - 1])
}

function parseReferenceMs(value: string | Date | null | undefined): number | null {
  if (!value) return null
  const t = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(t) ? t : null
}

function parseActivities(raw: unknown): ToolLoopActivityEvent[] {
  return Array.isArray(raw) ? (raw as ToolLoopActivityEvent[]) : []
}

/**
 * Aktív chat-forduló élősége: `heartbeatAt` (D10) + opcionális lépéslista.
 * Nem zárja le a fordulót — csak jelzi, hogy van-e friss életjel.
 */
export function assessChatTurnLiveness(input: {
  status: string
  cancelRequested?: boolean
  heartbeatAt?: string | Date | null
  startedAt?: string | Date | null
  /** #518 — a kapacitás-hely foglalásának ideje; queued + null = sorban áll. */
  launchReservedAt?: string | Date | null
  createdAt?: string | Date | null
  activities?: unknown
  staleAfterMs?: number
  nowMs?: number
}): ChatTurnLiveness {
  if (!ACTIVE_CHAT_STATUSES.has(input.status)) return { kind: 'idle' }
  if (input.cancelRequested) return { kind: 'cancelling' }

  const staleAfterMs = input.staleAfterMs ?? resolveStaleTurnMs()
  const now = input.nowMs ?? Date.now()

  if (input.status === 'queued') {
    // Nincs futó tulajdonos, a heartbeat nem életjel: a sorban állást nem a
    // 120 mp-es watchdog, az indítást a 10 perces indítási határ (#517) figyeli.
    const reservedMs = parseReferenceMs(input.launchReservedAt)
    if (reservedMs !== null) return { kind: 'launching', ageMs: Math.max(0, now - reservedMs) }
    const acceptedMs = parseReferenceMs(input.createdAt) ?? parseReferenceMs(input.startedAt)
    return { kind: 'queued', ageMs: acceptedMs === null ? 0 : Math.max(0, now - acceptedMs) }
  }
  const activities = parseActivities(input.activities)
  const currentStep = latestActivityStep(activities)

  const referenceMs =
    parseReferenceMs(input.heartbeatAt) ?? parseReferenceMs(input.startedAt)

  if (referenceMs === null) {
    return { kind: 'starting', ageMs: 0 }
  }

  const ageMs = Math.max(0, now - referenceMs)

  if (activities.length === 0) {
    return ageMs >= staleAfterMs
      ? { kind: 'stalled', ageMs, currentStep: null }
      : { kind: 'starting', ageMs }
  }

  if (ageMs < CHAT_TURN_PROGRESS_ACTIVE_MS) {
    return { kind: 'active', ageMs, currentStep }
  }
  if (ageMs < staleAfterMs) {
    return { kind: 'quiet', ageMs, currentStep }
  }
  return { kind: 'stalled', ageMs, currentStep }
}
