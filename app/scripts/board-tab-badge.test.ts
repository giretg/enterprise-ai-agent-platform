/**
 * Munkaterület Feladatok-fül badge: kapu előzi a futót, 0-n nincs jelzés.
 * Futtatás: npm run test:board-tab-badge
 */
import assert from 'node:assert/strict'
import { boardTabBadge } from '../src/lib/board-tab-badge'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}`)
    console.error(error)
  }
}

test('jóváhagyás/pontosítás coral számmal, „rád vár”', () => {
  const badge = boardTabBadge({ attention: 2, running: 5 })
  assert.deepEqual(badge, {
    count: 2,
    tone: 'wait',
    spoken: 'rád vár',
    hint: 'Emberi jóváhagyásra vagy pontosításra várnak — nélküled nem haladnak.',
  })
})

test('egy kapu is attention, a futó szám nem adódik hozzá', () => {
  const badge = boardTabBadge({ attention: 1, running: 4 })
  assert.equal(badge?.count, 1)
  assert.equal(badge?.tone, 'wait')
  assert.equal(badge?.spoken, 'rád vár')
})

test('ha nincs kapu, a futó munka halk sky számmal jelenik meg', () => {
  const badge = boardTabBadge({ attention: 0, running: 3 })
  assert.deepEqual(badge, {
    count: 3,
    tone: 'run',
    spoken: 'fut',
    hint: 'Az AI munkatárs éppen dolgozik ezeken.',
  })
})

test('nullánál, ready/backlog nélkül nincs badge', () => {
  assert.equal(boardTabBadge({ attention: 0, running: 0 }), null)
})

test('negatív vagy NaN számot nullának vesz', () => {
  assert.equal(boardTabBadge({ attention: -2, running: Number.NaN }), null)
  const badge = boardTabBadge({ attention: -1, running: 2 })
  assert.equal(badge?.tone, 'run')
  assert.equal(badge?.count, 2)
})

if (failures > 0) {
  console.error(`\n${failures} teszt elbukott`)
  process.exit(1)
}
console.log('\nboard-tab-badge: ok')
