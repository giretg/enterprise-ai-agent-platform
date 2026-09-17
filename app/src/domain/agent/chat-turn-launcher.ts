/**
 * `ChatTurnLauncher` — a tartósan felvett forduló INDÍTÁSÁNAK határa
 * (#516 / #517 / #508 §4–§5).
 *
 * A kérés-út a rekordot és a bemenetet már perzisztálta; a launcher csak azt
 * mondja meg, HOL fusson a közös mag (`runReservedTurn`). A `launchId` az
 * indítás korrelációs azonosítója — NEM a futás tulajdonos-tokenje: azt a mag
 * maga váltja a claimkor, így két azonos indításból csak egy szerezhet jogot.
 *
 * #517: az API-elfogadás nem bizonyítja a loop elindulását. Elveszett /
 * időtúllépett válasznál a `reconcile` dönt a szolgáltatói execution-ref és a
 * helyi futás alapján — nem automatikus végleges hiba.
 *
 * v1-ben egy adapter van (in-process, a Tier-1 runneren). A Cloud Run Job
 * adapter későbbi ticket; nem támogatott mód HIBA, nem csendes visszaesés.
 */
import { agentTurnRunner, type AgentTurnEmit } from './agent-turn-runner'

export type ChatTurnLaunchRequest = { turnId: string; launchId: string }

export type ChatTurnLaunchResult = {
  launchId: string
  /** Szolgáltatói operation/execution azonosító; in-processben a `launchId`. */
  providerRef?: string
  outcome: 'accepted' | 'duplicate'
}

export type ChatTurnReconcileRequest = {
  turnId: string
  launchId: string
  providerRef?: string | null
}

export type ChatTurnReconcileResult = {
  state: 'running' | 'not_found'
  providerRef?: string
}

export type ChatTurnLauncher = {
  launch(request: ChatTurnLaunchRequest): Promise<ChatTurnLaunchResult>
  reconcile(request: ChatTurnReconcileRequest): Promise<ChatTurnReconcileResult>
}

/** Végleges indítási elutasítás — retry nem oldja meg. */
export class ChatTurnLaunchRejectedError extends Error {
  readonly retryable = false as const
  constructor(message: string) {
    super(message)
    this.name = 'ChatTurnLaunchRejectedError'
  }
}

export const CHAT_TURN_LAUNCHER_MODES = ['in-process'] as const
export type ChatTurnLauncherMode = (typeof CHAT_TURN_LAUNCHER_MODES)[number]

export function resolveChatTurnLauncherMode(
  env: Record<string, string | undefined> = process.env,
): ChatTurnLauncherMode {
  const raw = env.CHAT_TURN_LAUNCHER_MODE?.trim()
  if (!raw) return 'in-process'
  if ((CHAT_TURN_LAUNCHER_MODES as readonly string[]).includes(raw)) {
    return raw as ChatTurnLauncherMode
  }
  throw new Error(
    `Nem támogatott CHAT_TURN_LAUNCHER_MODE: "${raw}" (támogatott: ${CHAT_TURN_LAUNCHER_MODES.join(', ')})`,
  )
}

export function createInProcessChatTurnLauncher(
  run: (request: { turnId: string; launchId: string }, emit: AgentTurnEmit) => Promise<void>,
): ChatTurnLauncher {
  return {
    async launch({ turnId, launchId }) {
      const handle = agentTurnRunner.start(turnId, (emit) => run({ turnId, launchId }, emit))
      if (!handle) return { launchId, providerRef: launchId, outcome: 'duplicate' }
      return { launchId, providerRef: launchId, outcome: 'accepted' }
    },
    async reconcile({ turnId, launchId }) {
      if (agentTurnRunner.isRunning(turnId)) {
        return { state: 'running', providerRef: launchId }
      }
      return { state: 'not_found' }
    },
  }
}
