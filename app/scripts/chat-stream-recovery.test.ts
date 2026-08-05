/**
 * A megszakadt chat-stream visszaszerzésének regressziója.
 *
 * Éles eset: a forduló elérte a 180s-os falióra-korlátot, a felhasználó
 * „Folytasd"-ot küldött, majd a mobilháló elvágta a válasz-törzset. A
 * `reader.read()` ilyenkor DOB (`TypeError: network error`), nem lezáró
 * eseményt ad — a kliens korábban eldobta a buborékot és nyers hibaszöveget
 * írt ki, miközben a forduló a szerveren tovább futott és az eredménye a DB-be
 * került. A felhasználó számára ez úgy nézett ki, hogy „nem született
 * eredmény". A dobott olvasás ezért ugyanazt a visszacsatlakozást kapja, mint
 * a lezáró esemény nélküli tiszta lezárás.
 *
 * Futtatás: npm run test:chat-stream-recovery
 */
import assert from 'node:assert/strict'
import {
  decideChatStreamRecovery,
  resolveChatStreamConflict,
  STREAM_INTERRUPTED_MESSAGE,
  STREAM_TASK_ONLY_BLOCKED_MESSAGE,
  type ChatStreamEnding,
} from '../src/lib/chat-stream-recovery'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

const persisted = (ending: ChatStreamEnding) =>
  decideChatStreamRecovery({
    ending,
    userMessagePersisted: true,
    conversationId: 'conv-1',
  })

console.log('chat-stream-recovery')

check('dobott olvasás perzisztált forduló után visszacsatlakozik, nem dob el', () => {
  const action = persisted('read_threw')
  assert.equal(action.kind, 'reattach')
  assert.equal(action.kind === 'reattach' ? action.conversationId : null, 'conv-1')
})

check('lezáró esemény nélküli lezárás ugyanazt a visszacsatlakozást kapja', () => {
  assert.deepEqual(persisted('read_threw'), persisted('closed_without_terminal'))
})

check('lezáró esemény után nincs teendő', () => {
  assert.equal(persisted('terminal_event').kind, 'none')
})

check('felhasználói megszakítás nem hiba — nincs visszaszerzés', () => {
  assert.equal(persisted('aborted').kind, 'none')
})

check('perzisztálás előtti szakadás eldobja a félkész buborékot', () => {
  const action = decideChatStreamRecovery({
    ending: 'read_threw',
    userMessagePersisted: false,
    conversationId: 'conv-1',
  })
  assert.equal(action.kind, 'discard')
  assert.equal(action.kind === 'discard' ? action.message : null, STREAM_INTERRUPTED_MESSAGE)
})

check('beszélgetés-azonosító nélkül nincs mihez visszacsatlakozni', () => {
  const action = decideChatStreamRecovery({
    ending: 'closed_without_terminal',
    userMessagePersisted: true,
    conversationId: null,
  })
  assert.equal(action.kind, 'discard')
})

check('409 agent_task_only: nem „már készül a válasz”, hanem tiltás', () => {
  const action = resolveChatStreamConflict(
    { error: 'agent_task_only', message: STREAM_TASK_ONLY_BLOCKED_MESSAGE },
    'conv-1',
  )
  assert.equal(action.kind, 'blocked')
  assert.equal(action.kind === 'blocked' ? action.message : null, STREAM_TASK_ONLY_BLOCKED_MESSAGE)
})

check('409 active_turn_exists: reattach-üzenet, turnId-vel', () => {
  const action = resolveChatStreamConflict(
    { error: 'active_turn_exists', activeTurnId: 'turn-1', conversationId: 'conv-9' },
    'conv-1',
  )
  assert.equal(action.kind, 'active_turn')
  if (action.kind !== 'active_turn') throw new Error('expected active_turn')
  assert.equal(action.activeTurnId, 'turn-1')
  assert.equal(action.conversationId, 'conv-9')
  assert.match(action.message, /már készül egy válasz/)
  assert.doesNotMatch(action.message, /korlátozott feladatkör/)
})

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
