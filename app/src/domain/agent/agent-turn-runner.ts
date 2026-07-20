/**
 * Detached forduló-futtató (chat-agent-turn-resilience-spec.md §5.1/5–6, D2/D3/D5,
 * issue #60).
 *
 * A chat-forduló futása INNENTŐL nem a HTTP-kérés élettartamához kötött: az
 * indító kérés elindít egy futást, majd *feliratkozik* rá. A futás a saját
 * promise-án él tovább akkor is, ha a feliratkozó eltűnik (ablakbezárás,
 * hard-refresh) — a végleges üzenet írása a futás lezárásához tartozik, nem a
 * stream fogyasztásához. A kliens-lecsatlakozás kifejezetten NEM megszakítás
 * (D5); arra a Stop való.
 *
 * A busz szándékosan buffereli az összes eseményt: a feliratkozó nulláról
 * játssza vissza a sort, így az indítás és a `subscribe()` közötti mikroszkopikus
 * ablakban keletkező eseményeket sem veszíti el.
 *
 * Ez a Tier-1 (in-process) réteg (§10): a futás addig él, amíg a Node-process.
 * A DB-ből visszaolvasható snapshot és a más instance-ről való visszacsatlakozás
 * a lánc további tiketjeié (#63/#66); a lock-tulajdonjog viszont már itt a
 * perzisztált forduló-rekordé.
 */
import type { ToolLoopActivityEvent, ToolLoopMemoryCandidateEvent } from './chat-tool-loop'

/** A chat-stream eseményei — a POST SSE és a nem-streamelő út közös nyelve. */
export type AgentChatStreamEvent =
  /** Mindig a legelső esemény: a forduló azonosítója (Stop + visszacsatlakozás, §6.1). */
  | { type: 'turn'; turnId: string }
  /** Reconnect első eseménye (spec §6.3): perzisztált snapshot a DB-ből. */
  | {
      type: 'snapshot'
      turnId: string
      status: string
      partialText: string
      activities: unknown
      conversationId: string
      userMessageId: string | null
    }
  | { type: 'meta'; conversationId: string; userMessageId: string }
  | { type: 'activity'; activity: ToolLoopActivityEvent }
  | { type: 'memory_candidate'; candidate: ToolLoopMemoryCandidateEvent }
  | { type: 'thinking'; turnId: string; delta: string }
  | { type: 'token'; chunk: string }
  | { type: 'done'; conversationId: string; messageId: string; ticketRefId?: string | null }
  | { type: 'cancelled'; conversationId: string; messageId: string }
  | { type: 'error'; message: string }
  /**
   * Már fut forduló a beszélgetésre (D7). Kizárólag a `sendMessageStream` első
   * eseményeként fordulhat elő, és a kérés-út `409`-re fordítja — SSE-be SOSEM
   * kerül ki, ezért a futás eseményei közt nem is keletkezik.
   */
  | { type: 'conflict'; conversationId: string; activeTurnId: string | null }

export type AgentTurnEmit = (event: AgentChatStreamEvent) => void

export type AgentTurnRunHandle = {
  turnId: string
  /**
   * Feliratkozás a futás eseményeire. Nulláról játssza vissza a buffert, majd
   * élőben követi a futást a lezárásig. A generátor eldobása CSAK a feliratkozást
   * szünteti meg — a futás megy tovább (D5).
   */
  subscribe: () => AsyncGenerator<AgentChatStreamEvent, void, unknown>
  /** A futás lezárultára váró promise (tesztekhez és a nem-streamelő úthoz). */
  completion: Promise<void>
}

type RunState = {
  events: AgentChatStreamEvent[]
  waiters: Array<() => void>
  finished: boolean
  completion: Promise<void>
  cancelRequested: boolean
}

export class AgentTurnRunner {
  private runs = new Map<string, RunState>()

  /** Fut-e éppen az adott forduló ebben a processben? */
  isRunning(turnId: string): boolean {
    return this.runs.has(turnId)
  }

  /**
   * Megszakítás-kérés jelzése a HELYBEN futó fordulónak (#65). Ez csak
   * *gyorsítás*: az igazság forrása a perzisztált rekord `cancelRequested`
   * mezője, amit a loop a DB-ből is olvas. Ha a Stop-kérés másik instance-re
   * érkezett, itt `false`-t kapunk — a futás akkor a DB-jelen keresztül áll le.
   *
   * `false` = ebben a processben nem fut ez a forduló (nem hiba).
   */
  requestCancel(turnId: string): boolean {
    const state = this.runs.get(turnId)
    if (!state) return false
    state.cancelRequested = true
    return true
  }

  /** A helyi megszakítás-jel olvasása a loop checkpointjain. */
  isCancelRequested(turnId: string): boolean {
    return this.runs.get(turnId)?.cancelRequested ?? false
  }

  /**
   * A futás lezárultára váró promise, ha még fut ebben a processben — különben
   * `null`. A kérés-kezelő ezzel tudja a futást a válasz lezárása UTÁN is
   * életben tartani (Next `after`), hogy a menedzselt futtatókörnyezet ne fagyassza
   * be az instance-t a válasz elküldése után.
   */
  completionOf(turnId: string): Promise<void> | null {
    return this.runs.get(turnId)?.completion ?? null
  }

  /**
   * Futás indítása. Ha az adott fordulóra már fut egy — azaz a hívó nem
   * kizárólagos tulajdonos —, `null`-t ad: **nem indul második futtatás**.
   */
  start(
    turnId: string,
    body: (emit: AgentTurnEmit) => Promise<void>,
  ): AgentTurnRunHandle | null {
    if (this.runs.has(turnId)) return null

    const state: RunState = {
      events: [],
      waiters: [],
      finished: false,
      // A tényleges promise-t alább kötjük be — a beállítás és az indítás között
      // nincs await, tehát kívülről nem figyelhető meg a köztes állapot.
      completion: Promise.resolve(),
      cancelRequested: false,
    }
    this.runs.set(turnId, state)

    const wake = () => {
      const waiters = state.waiters
      state.waiters = []
      for (const resolve of waiters) resolve()
    }
    const emit: AgentTurnEmit = (event) => {
      if (state.finished) return
      state.events.push(event)
      wake()
    }

    const completion = (async () => {
      try {
        await body(emit)
      } catch (error) {
        // A futtató törzs maga kezeli a várt hibákat; ide csak programozói hiba
        // juthat. Nem szabad unhandled rejectionként elszállnia, és a nyitott
        // feliratkozó se maradjon lógva.
        console.error('[agent-turn-runner] a forduló futtatása váratlan hibával állt le', error)
        const message = error instanceof Error ? error.message : 'Agent turn failed'
        state.events.push({ type: 'error', message })
      } finally {
        state.finished = true
        // A registryből azonnal kikerül; a MÁR feliratkozottak a state-objektumon
        // keresztül végig tudják olvasni a maradék eseményt.
        this.runs.delete(turnId)
        wake()
      }
    })()
    state.completion = completion

    return {
      turnId,
      completion,
      subscribe: () => this.subscribeToState(state),
    }
  }

  /**
   * Feliratkozás egy már futó fordulóra (reconnect, Tier-1).
   * `null`, ha ebben a processben nem fut.
   */
  subscribe(turnId: string): AsyncGenerator<AgentChatStreamEvent, void, unknown> | null {
    const state = this.runs.get(turnId)
    if (!state) return null
    return this.subscribeToState(state)
  }

  private subscribeToState(
    state: RunState,
  ): AsyncGenerator<AgentChatStreamEvent, void, unknown> {
    return (async function* () {
      let index = 0
      for (;;) {
        while (index < state.events.length) {
          yield state.events[index]
          index += 1
        }
        if (state.finished) return
        await new Promise<void>((resolve) => {
          state.waiters.push(resolve)
        })
      }
    })()
  }
}

/** Process-szintű registry (Tier-1). */
export const agentTurnRunner = new AgentTurnRunner()
