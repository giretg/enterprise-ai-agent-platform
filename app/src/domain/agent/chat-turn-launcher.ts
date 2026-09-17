/**
 * `ChatTurnLauncher` — a tartósan felvett forduló INDÍTÁSÁNAK határa
 * (#516 / #508 §4, §9).
 *
 * A kérés-út a rekordot és a bemenetet már perzisztálta; a launcher csak azt
 * mondja meg, HOL fusson a közös mag (`runReservedTurn`). A `launchId` az
 * indítás korrelációs azonosítója — NEM a futás tulajdonos-tokenje: azt a mag
 * maga váltja a claimkor, így két azonos indításból csak egy szerezhet jogot.
 *
 * v1-ben egy adapter van (in-process, a Tier-1 runneren). A Cloud Run Job
 * adapter későbbi ticket; nem támogatott mód HIBA, nem csendes visszaesés.
 */
import { randomUUID } from 'node:crypto'
import { agentTurnRunner, type AgentTurnEmit } from './agent-turn-runner'

export type ChatTurnLaunchRequest = { turnId: string }

export type ChatTurnLauncher = {
  /** `null`, ha az indítás nem történt meg (pl. ugyanerre a fordulóra már fut helyi futás). */
  launch(request: ChatTurnLaunchRequest): Promise<{ launchId: string } | null>
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
    async launch({ turnId }) {
      const launchId = randomUUID()
      const handle = agentTurnRunner.start(turnId, (emit) => run({ turnId, launchId }, emit))
      return handle ? { launchId } : null
    },
  }
}
