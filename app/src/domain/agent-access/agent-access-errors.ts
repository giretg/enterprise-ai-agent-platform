/**
 * Az agent-hozzáférési gráf tipizált domain-hibái (Access-Policy §agent-scope).
 *
 * A route- és tool-adapterek EZEKBŐL képeznek HTTP- vagy tool-választ; nyers `Error`
 * szöveg nem lehet a policy szerződése. A két kód a felfedési szintet is hordozza:
 *
 *  - `AGENT_ACCESS_FORBIDDEN` — a subject LÁTHATJA a célt, de nem szólíthatja meg →
 *    403 / tanulságos, nem újrapróbálkozó tool-hiba;
 *  - `AGENT_NOT_FOUND` — a subject `view` joga sem engedi → 404-jellegű válasz, hogy a
 *    cél LÉTEZÉSE ne szivárogjon ki.
 */
import type { AgentAccessDenyReason } from '@/lib/agent-access-graph'

export type AgentAccessErrorCode = 'AGENT_ACCESS_FORBIDDEN' | 'AGENT_NOT_FOUND'

/**
 * A tool-válaszban megjelenő, HÉTKÖZNAPI magyar hibaszöveg. Szándékosan tanulságos és
 * NEM újrapróbálkozásra hívó: a modellnek azt kell megtanulnia, hogy vissza kell adnia
 * a feladatot, nem azt, hogy más azonosítóval próbálkozzon.
 */
export const AGENT_ACCESS_FORBIDDEN_MESSAGE =
  'Ehhez az agenthez nincs megszólítási jogod. Kérj adminisztrátori segítséget vagy add vissza a feladatot a felhasználónak.'

export const AGENT_NOT_FOUND_MESSAGE = 'Agent nem található'

export class AgentAccessError extends Error {
  constructor(
    public readonly code: AgentAccessErrorCode,
    message: string,
    public readonly reason?: AgentAccessDenyReason,
  ) {
    super(message)
    this.name = 'AgentAccessError'
  }

  static forbidden(reason?: AgentAccessDenyReason): AgentAccessError {
    return new AgentAccessError('AGENT_ACCESS_FORBIDDEN', AGENT_ACCESS_FORBIDDEN_MESSAGE, reason)
  }

  static notFound(reason?: AgentAccessDenyReason): AgentAccessError {
    return new AgentAccessError('AGENT_NOT_FOUND', AGENT_NOT_FOUND_MESSAGE, reason)
  }

  /** A HTTP-adapterhez: `view` engedett → 403, egyébként 404. */
  get httpStatus(): number {
    return this.code === 'AGENT_ACCESS_FORBIDDEN' ? 403 : 404
  }
}

export function isAgentAccessError(e: unknown): e is AgentAccessError {
  return e instanceof AgentAccessError
}
