/**
 * chat-agent-turn-resilience-spec.md §6.3–6.4 — mi történjen, ha a chat SSE
 * olvasása a forduló lezárása ELŐTT ér véget.
 *
 * A stream háromféleképpen érhet véget: lezáró eseménnyel (`done` / `cancelled`
 * / `error`), lezáró esemény nélküli tiszta lezárással, vagy a `reader.read()`
 * hibájával — ez utóbbi a valóságban a leggyakoribb (mobilháló elvágja a
 * válasz-törzset, a böngésző `TypeError: network error`-t dob; proxy timeout).
 *
 * A két megszakadás-fajta ugyanaz az eset: a `meta` esemény után a user-üzenet
 * a szerveren már perzisztált, a forduló tovább futhat, és az eredménye a DB-be
 * kerül. Ilyenkor a kliensnek vissza kell csatlakoznia, NEM eldobnia a
 * buborékot — különben a felhasználó nyers hibaszöveget lát üres válasszal, és
 * úgy tűnik, „nem született eredmény", pedig a válasz megvan.
 *
 * A függvény szándékosan tiszta (nincs I/O, nincs React-állapot), hogy a
 * döntés a UI nélkül is tesztelhető legyen.
 */

/** Hogyan ért véget az olvasás. */
export type ChatStreamEnding =
  /** Megérkezett a lezáró esemény (`done` / `cancelled` / `error`) — nincs teendő. */
  | 'terminal_event'
  /** A törzs lezáró esemény nélkül zárult (tiszta EOF). */
  | 'closed_without_terminal'
  /** A `reader.read()` dobott (elvágott kapcsolat, proxy timeout). */
  | 'read_threw'
  /** A felhasználó szakította meg (Stop / navigáció) — szándékos, nem hiba. */
  | 'aborted'

export type ChatStreamRecoveryState = {
  ending: ChatStreamEnding
  /**
   * A szerver `meta` eseménye visszaigazolta-e a user-üzenet perzisztálását.
   * Enélkül nincs szerveroldali forduló, amihez vissza lehetne csatlakozni.
   */
  userMessagePersisted: boolean
  /** Az ismert beszélgetés-azonosító (stream `meta` vagy a panel állapota). */
  conversationId: string | null
}

export type ChatStreamRecoveryAction =
  /** Nincs teendő: a forduló rendben lezárult, vagy a felhasználó állította le. */
  | { kind: 'none' }
  /** Nincs szerveroldali nyom: a félkész buborékokat eldobjuk, és jelezzük a hibát. */
  | { kind: 'discard'; message: string }
  /** Van perzisztált forduló: visszacsatlakozunk, a buborékot megtartjuk. */
  | { kind: 'reattach'; conversationId: string }

/** A megszakadás után szükséges lépés — a chat-panel egyetlen döntési pontja. */
export function decideChatStreamRecovery(
  state: ChatStreamRecoveryState,
): ChatStreamRecoveryAction {
  if (state.ending === 'terminal_event' || state.ending === 'aborted') {
    return { kind: 'none' }
  }
  if (!state.userMessagePersisted || !state.conversationId) {
    return { kind: 'discard', message: STREAM_INTERRUPTED_MESSAGE }
  }
  return { kind: 'reattach', conversationId: state.conversationId }
}

/** Nem indult el szerveroldali forduló — a küldést meg kell ismételni. */
export const STREAM_INTERRUPTED_MESSAGE = 'A válaszfolyam váratlanul megszakadt'

/** Visszacsatlakozás után a forduló már lezárult: a mentett válasz visszatöltve. */
export const STREAM_RECOVERED_MESSAGE = 'Megszakadt a kapcsolat — a mentett választ visszatöltöttem.'

/** A visszaszerzés is elbukott (tartós hálózatkiesés) — a munka attól még megvan. */
export const STREAM_RECOVERY_FAILED_MESSAGE =
  'Megszakadt a kapcsolat. A forduló a szerveren fut tovább — nyisd meg újra a beszélgetést a folytatáshoz.'

/** #199 — korlátozott feladatkörű agent webes chat-tiltása. */
export const STREAM_TASK_ONLY_BLOCKED_MESSAGE =
  'Ez az agent korlátozott feladatkörű — feladatot az agent oldalán lévő feladat-gombbal indíthatsz.'

export type ChatStreamConflictBody = {
  error?: string
  message?: string
  activeTurnId?: string | null
  conversationId?: string
}

export type ChatStreamConflictAction =
  | {
      kind: 'active_turn'
      conversationId: string | null
      activeTurnId: string | null
      message: string
    }
  | { kind: 'blocked'; message: string }
  | { kind: 'other'; message: string }

/**
 * A stream `409` válaszának értelmezése. A taskOnly tiltás (#199) és az aktív
 * forduló ütközés (D7) ugyanazt a státuszkódot használja — összekeverésük
 * eltünteti a user üzenetét, és hamis „már készül a válasz” állapotot hagy.
 */
export function resolveChatStreamConflict(
  body: ChatStreamConflictBody,
  fallbackConversationId: string | null,
): ChatStreamConflictAction {
  if (body.error === 'agent_task_only') {
    return {
      kind: 'blocked',
      message: body.message?.trim() || STREAM_TASK_ONLY_BLOCKED_MESSAGE,
    }
  }
  if (body.error === 'active_turn_exists' || body.activeTurnId) {
    const activeTurnId = body.activeTurnId ?? null
    return {
      kind: 'active_turn',
      conversationId: body.conversationId ?? fallbackConversationId,
      activeTurnId,
      message: activeTurnId
        ? 'Ebben a beszélgetésben már készül egy válasz. Próbáld újra a megnyitást, vagy állítsd le.'
        : 'Ebben a beszélgetésben már készül egy válasz. Várd meg, amíg elkészül, vagy állítsd le a Stop gombbal.',
    }
  }
  return {
    kind: 'other',
    message: body.message?.trim() || `Küldés sikertelen (409)`,
  }
}
