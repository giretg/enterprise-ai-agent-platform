/**
 * chat-agent-turn-resilience-spec.md §5.3 / D9 / Q4 — forduló-snapshot
 * fojtás és tartalom-őr (issue #63).
 *
 * Élő DB nélkül: injektált órával és a tiszta flusher API-n keresztül
 * igazolja a küszöböket és azt, hogy szűrendő tartalom nem kerül nyersen
 * a kiírandó részszövegbe.
 *
 * Futtatás: npm run test:agent-turn-snapshot
 */
import assert from 'node:assert/strict'
import {
  PARTIAL_TEXT_FLUSH_CHARS,
  PARTIAL_TEXT_FLUSH_INTERVAL_MS,
  TurnSnapshotFlusher,
  guardTurnPartialText,
} from '../src/domain/agent/agent-turn-snapshot'
import type { ToolLoopActivityEvent } from '../src/domain/agent/chat-tool-loop'

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

const activity = (id: string, status: ToolLoopActivityEvent['status'] = 'running'): ToolLoopActivityEvent => ({
  id,
  kind: 'tool',
  title: `Tool ${id}`,
  status,
})

async function main() {
  console.log('=== Forduló-snapshot flusher (#63) ===')

  await check('dokumentált alapértékek: 1 mp / 200 karakter', () => {
    assert.equal(PARTIAL_TEXT_FLUSH_INTERVAL_MS, 1_000)
    assert.equal(PARTIAL_TEXT_FLUSH_CHARS, 200)
  })

  await check('token: küszöb alatt nincs flush', () => {
    let now = 1_000
    const flusher = new TurnSnapshotFlusher({ now: () => now })
    assert.equal(flusher.pushToken('hello'), null)
    assert.equal(flusher.pushToken(' world'), null)
  })

  await check('token: karakter-küszöb felett flushol, redaktált szöveggel', () => {
    let now = 1_000
    const flusher = new TurnSnapshotFlusher({ now: () => now })
    const chunk = 'a'.repeat(PARTIAL_TEXT_FLUSH_CHARS)
    const flush = flusher.pushToken(chunk)
    assert.ok(flush, 'karakter-küszöbnél flush kell')
    assert.equal(flush.partialText, chunk)
    assert.equal(flush.activities, undefined, 'token-flush nem ír aktivitást')
  })

  await check('token: idő-küszöb felett flushol', () => {
    let now = 1_000
    const flusher = new TurnSnapshotFlusher({ now: () => now })
    assert.equal(flusher.pushToken('rész'), null)
    now += PARTIAL_TEXT_FLUSH_INTERVAL_MS
    const flush = flusher.pushToken(' szöveg')
    assert.ok(flush)
    assert.equal(flush.partialText, 'rész szöveg')
  })

  await check('aktivitás: eseményenként flushol (teljes lista)', () => {
    const flusher = new TurnSnapshotFlusher({ now: () => 0 })
    const a1 = activity('t1')
    const flush1 = flusher.pushActivity(a1)
    assert.deepEqual(flush1.activities, [a1])
    assert.equal(flush1.partialText, undefined)

    const a1Done = activity('t1', 'done')
    const flush2 = flusher.pushActivity(a1Done)
    assert.deepEqual(flush2.activities, [a1Done], 'azonos id felülíródik')

    const a2 = activity('t2')
    const flush3 = flusher.pushActivity(a2)
    assert.deepEqual(flush3.activities, [a1Done, a2])
  })

  await check('tartalom-őr: PAN nem kerül nyersen a flusholt részszövegbe', () => {
    let now = 1_000
    const flusher = new TurnSnapshotFlusher({ now: () => now })
    const raw = `A kártyaszám 4111 1111 1111 1111 — ${'x'.repeat(PARTIAL_TEXT_FLUSH_CHARS)}`
    const flush = flusher.pushToken(raw)
    assert.ok(flush)
    assert.equal(flush.partialText?.includes('4111 1111 1111 1111'), false)
    assert.ok(flush.partialText?.includes('«redaktált:'), 'redakciós jelölő kell')
  })

  await check('guardTurnPartialText: ugyanaz az őr, mint a végleges outbound', () => {
    const { text } = { text: guardTurnPartialText('api_key: sk-abcdefghijklmnopqrstuvwxyz012345') }
    assert.equal(text.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), false)
    assert.ok(text.includes('«redaktált:titok»'))
  })

  await check('flushFinal: a teljes aktuális részszöveget kiírja (őrizve)', () => {
    let now = 1_000
    const flusher = new TurnSnapshotFlusher({ now: () => now })
    flusher.pushToken('rövid')
    flusher.pushActivity(activity('t1', 'done'))
    const final = flusher.flushFinal()
    assert.equal(final.partialText, 'rövid')
    assert.deepEqual(final.activities, [activity('t1', 'done')])
  })

  await check('hosszú válasz: az írások száma a küszöb nagyságrendje', () => {
    let now = 1_000
    const flusher = new TurnSnapshotFlusher({ now: () => now })
    // A chunk pontosan osztja a küszöböt → minden N. tokennél flush, idő nélkül.
    const chunkSize = 40
    const expectedWrites = 20
    const totalChars = PARTIAL_TEXT_FLUSH_CHARS * expectedWrites
    let writes = 0
    for (let i = 0; i < totalChars / chunkSize; i++) {
      if (flusher.pushToken('a'.repeat(chunkSize))) writes += 1
    }
    assert.equal(writes, expectedWrites, `writes=${writes}, várt ${expectedWrites}`)
  })

  if (failures > 0) {
    console.error(`\n${failures} sikertelen`)
    process.exit(1)
  }
  console.log('\nMind OK')
}

main()
