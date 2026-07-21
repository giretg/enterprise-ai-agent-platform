/**
 * chat-agent-turn-resilience-spec.md §6.3–6.4 / E2 / E8 / E10 (issue #66) —
 * a visszacsatlakozó stream magja élő DB és HTTP nélkül.
 *
 * Poll-út (subscribe → null = E10) és élő busz-út (Tier-1) mellett igazolja,
 * hogy a snapshot után a helyes delták, majd a lezáró esemény érkezik (E2), a
 * terminális forduló azonnal zár (E8), és hogy a snapshot tartalma nem
 * duplázódik az első token-/activity-deltában. Az E9 (403) a route auth
 * rétegében él — ez a mag-teszt azt nem fedi.
 *
 * Futtatás: npm run test:agent-turn-reconnect
 */
import assert from 'node:assert/strict'
import type { AgentChatStreamEvent } from '../src/domain/agent/agent-turn-runner'
import {
  AGENT_TURN_RECONNECT_POLL_DEFAULT_MS,
  AGENT_TURN_RECONNECT_POLL_ENV,
  resolveReconnectPollMs,
  snapshotEvent,
  streamTurnReconnect,
  terminalEventForTurn,
  type ReconnectTurnState,
} from '../src/domain/agent/agent-turn-reconnect'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  OK ${name}`))
    .catch((e) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

function makeTurn(overrides: Partial<ReconnectTurnState> = {}): ReconnectTurnState {
  return {
    id: 'turn-1',
    status: 'streaming',
    partialText: '',
    activities: [],
    conversationId: 'conv-1',
    userMessageId: 'umsg-1',
    assistantMessageId: null,
    error: null,
    reason: null,
    ...overrides,
  }
}

const activity = (id: string) => ({ id, kind: 'tool', title: `Tool ${id}`, status: 'running' })

/** A generátor teljes kimenete — a sleep azonnal old, a subscribe null (E10). */
async function collect(
  turn: ReconnectTurnState,
  states: (ReconnectTurnState | null)[],
  opts: { signal?: AbortSignal } = {},
): Promise<AgentChatStreamEvent[]> {
  let call = 0
  const findById = async () => {
    // Az utolsó ismert állapotnál ragadunk, hogy a poll ne fusson ki a tömbből.
    const next = states[Math.min(call, states.length - 1)] ?? null
    call += 1
    return next
  }
  const events: AgentChatStreamEvent[] = []
  const gen = streamTurnReconnect(turn, {
    findById,
    subscribe: () => null,
    signal: opts.signal ?? new AbortController().signal,
    sleep: async () => {},
  })
  for await (const event of gen) events.push(event)
  return events
}

async function main() {
  console.log('=== Visszacsatlakozó stream mag (#66) ===')

  await check('resolveReconnectPollMs: dokumentált alapérték ~750 ms', () => {
    assert.equal(AGENT_TURN_RECONNECT_POLL_DEFAULT_MS, 750)
    assert.equal(resolveReconnectPollMs({}), 750)
  })

  await check('resolveReconnectPollMs: env felülírja, érvénytelen → alapérték', () => {
    assert.equal(resolveReconnectPollMs({ [AGENT_TURN_RECONNECT_POLL_ENV]: '250' }), 250)
    assert.equal(resolveReconnectPollMs({ [AGENT_TURN_RECONNECT_POLL_ENV]: '0' }), 750)
    assert.equal(resolveReconnectPollMs({ [AGENT_TURN_RECONNECT_POLL_ENV]: '-5' }), 750)
    assert.equal(resolveReconnectPollMs({ [AGENT_TURN_RECONNECT_POLL_ENV]: 'abc' }), 750)
  })

  await check('E2: snapshot → delták → lezáró esemény (poll-út, E10)', async () => {
    const snapshot = makeTurn({ partialText: 'Hello', activities: [] })
    const events = await collect(snapshot, [
      makeTurn({ partialText: 'Hello world', activities: [activity('a1')], status: 'streaming' }),
      makeTurn({
        partialText: 'Hello world!',
        activities: [activity('a1'), activity('a2')],
        status: 'succeeded',
        assistantMessageId: 'msg-1',
      }),
    ])

    assert.deepEqual(
      events.map((e) => e.type),
      ['snapshot', 'token', 'activity', 'token', 'activity', 'done'],
    )
    // A snapshot a pillanatképet hozza…
    assert.equal((events[0] as { partialText: string }).partialText, 'Hello')
    // …és az első token CSAK az új suffix, nincs duplikáció (a fix lényege).
    assert.equal((events[1] as { chunk: string }).chunk, ' world')
    assert.equal((events[2] as { activity: { id: string } }).activity.id, 'a1')
    assert.equal((events[3] as { chunk: string }).chunk, '!')
    assert.equal((events[4] as { activity: { id: string } }).activity.id, 'a2')
    assert.deepEqual(events[5], {
      type: 'done',
      conversationId: 'conv-1',
      messageId: 'msg-1',
    })
  })

  await check('E8: terminális forduló → snapshot + lezáró, nincs poll', async () => {
    const done = makeTurn({
      status: 'succeeded',
      partialText: 'kész',
      assistantMessageId: 'msg-9',
    })
    let polled = false
    const events: AgentChatStreamEvent[] = []
    const gen = streamTurnReconnect(done, {
      findById: async () => {
        polled = true
        return done
      },
      subscribe: () => null,
      signal: new AbortController().signal,
      sleep: async () => {},
    })
    for await (const event of gen) events.push(event)

    assert.equal(polled, false, 'terminális fordulónál nem szabad DB-t pollozni')
    assert.deepEqual(
      events.map((e) => e.type),
      ['snapshot', 'done'],
    )
  })

  await check('terminalEventForTurn: failed → error; cancelled → done reason', () => {
    const failed = terminalEventForTurn(makeTurn({ status: 'failed', error: 'boom' }))
    assert.deepEqual(failed, { type: 'error', message: 'boom' })

    const cancelled = terminalEventForTurn(
      makeTurn({ status: 'cancelled', assistantMessageId: 'msg-c' }),
    )
    assert.deepEqual(cancelled, {
      type: 'done',
      conversationId: 'conv-1',
      messageId: 'msg-c',
      reason: 'cancelled',
    })
  })

  await check('snapshotEvent: a rekord mezőit tükrözi', () => {
    const evt = snapshotEvent(makeTurn({ partialText: 'x', status: 'running' })) as {
      type: string
      turnId: string
      status: string
      partialText: string
      userMessageId: string | null
    }
    assert.equal(evt.type, 'snapshot')
    assert.equal(evt.turnId, 'turn-1')
    assert.equal(evt.status, 'running')
    assert.equal(evt.partialText, 'x')
    assert.equal(evt.userMessageId, 'umsg-1')
  })

  await check('abort: a poll megáll, a lezáró esemény nem érkezik meg', async () => {
    const controller = new AbortController()
    const snapshot = makeTurn({ partialText: 'a', status: 'streaming' })
    let calls = 0
    const events: AgentChatStreamEvent[] = []
    const gen = streamTurnReconnect(snapshot, {
      findById: async () => {
        calls += 1
        // Második poll előtt megszakítjuk — sosem ér terminális állapotba.
        if (calls >= 1) controller.abort()
        return makeTurn({ partialText: 'ab', status: 'streaming' })
      },
      subscribe: () => null,
      signal: controller.signal,
      sleep: async () => {},
    })
    for await (const event of gen) events.push(event)

    // Snapshot + esetleg egy token, de SOHA nem 'done'/'error'.
    assert.ok(!events.some((e) => e.type === 'done' || e.type === 'error'))
    assert.equal(events[0].type, 'snapshot')
  })

  await check('live-út (Tier-1): busz-eseményeket továbbküld, turn/meta/conflict-ot kiszűr', async () => {
    async function* liveEvents(): AsyncGenerator<AgentChatStreamEvent, void, unknown> {
      yield { type: 'turn', turnId: 'turn-1' }
      yield { type: 'token', chunk: 'hi' }
      yield { type: 'meta', conversationId: 'conv-1', userMessageId: 'umsg-1' }
      yield { type: 'activity', activity: activity('a1') as never }
      yield { type: 'done', conversationId: 'conv-1', messageId: 'msg-live' }
      yield { type: 'token', chunk: 'после' } // 'done' után már nem jöhet ki
    }
    const events: AgentChatStreamEvent[] = []
    const gen = streamTurnReconnect(makeTurn({ status: 'streaming', partialText: '' }), {
      findById: async () => null,
      subscribe: () => liveEvents(),
      signal: new AbortController().signal,
      sleep: async () => {},
    })
    for await (const event of gen) events.push(event)

    assert.deepEqual(
      events.map((e) => e.type),
      ['snapshot', 'token', 'activity', 'done'],
    )
  })

  await check('E2 live-út (Tier-1): snapshot után csak delta, nincs szöveg-/activity-dupla', async () => {
    // A busz nulláról játssza vissza a buffert; a snapshot már tartalmazza a
    // „Hello” + a1 állapotot — ezeket nem szabad újraküldeni.
    async function* liveEvents(): AsyncGenerator<AgentChatStreamEvent, void, unknown> {
      yield { type: 'turn', turnId: 'turn-1' }
      yield { type: 'token', chunk: 'Hel' }
      yield { type: 'token', chunk: 'lo' }
      yield { type: 'activity', activity: activity('a1') as never }
      yield { type: 'token', chunk: ' world' }
      yield { type: 'activity', activity: activity('a2') as never }
      yield { type: 'done', conversationId: 'conv-1', messageId: 'msg-live' }
    }
    const events: AgentChatStreamEvent[] = []
    const gen = streamTurnReconnect(
      makeTurn({ status: 'streaming', partialText: 'Hello', activities: [activity('a1')] }),
      {
        findById: async () => null,
        subscribe: () => liveEvents(),
        signal: new AbortController().signal,
        sleep: async () => {},
      },
    )
    for await (const event of gen) events.push(event)

    assert.deepEqual(
      events.map((e) => e.type),
      ['snapshot', 'token', 'activity', 'done'],
    )
    assert.equal((events[0] as { partialText: string }).partialText, 'Hello')
    assert.equal((events[1] as { chunk: string }).chunk, ' world')
    assert.equal((events[2] as { activity: { id: string } }).activity.id, 'a2')
    assert.deepEqual(events[3], {
      type: 'done',
      conversationId: 'conv-1',
      messageId: 'msg-live',
    })
  })

  await check('E2 live-út: token catch-up részleges chunk határán is helyes', async () => {
    // Snapshot „Hello” — a buszon egyetlen „Hello!” chunk; csak a „!” jöhet ki.
    async function* liveEvents(): AsyncGenerator<AgentChatStreamEvent, void, unknown> {
      yield { type: 'token', chunk: 'Hello!' }
      yield { type: 'done', conversationId: 'conv-1', messageId: 'msg-1' }
    }
    const events: AgentChatStreamEvent[] = []
    const gen = streamTurnReconnect(makeTurn({ partialText: 'Hello' }), {
      findById: async () => null,
      subscribe: () => liveEvents(),
      signal: new AbortController().signal,
      sleep: async () => {},
    })
    for await (const event of gen) events.push(event)

    assert.deepEqual(
      events.map((e) => e.type),
      ['snapshot', 'token', 'done'],
    )
    assert.equal((events[1] as { chunk: string }).chunk, '!')
  })

  await check('E2 live-út: snapshot activity későbbi státusz-frissítése átmegy', async () => {
    const a1Running = activity('a1')
    const a1Done = { ...activity('a1'), status: 'done' as const }
    async function* liveEvents(): AsyncGenerator<AgentChatStreamEvent, void, unknown> {
      yield { type: 'activity', activity: a1Running as never }
      yield { type: 'activity', activity: a1Done as never }
      yield { type: 'done', conversationId: 'conv-1', messageId: 'msg-1' }
    }
    const events: AgentChatStreamEvent[] = []
    const gen = streamTurnReconnect(
      makeTurn({ partialText: '', activities: [a1Running] }),
      {
        findById: async () => null,
        subscribe: () => liveEvents(),
        signal: new AbortController().signal,
        sleep: async () => {},
      },
    )
    for await (const event of gen) events.push(event)

    assert.deepEqual(
      events.map((e) => e.type),
      ['snapshot', 'activity', 'done'],
    )
    assert.equal((events[1] as { activity: { status: string } }).activity.status, 'done')
  })

  console.log(failures === 0 ? '\nAll passed' : `\n${failures} FAILED`)
  if (failures > 0) process.exitCode = 1
}

void main()
