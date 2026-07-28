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
  STREAM_INTERRUPTED_MESSAGE,
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

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
