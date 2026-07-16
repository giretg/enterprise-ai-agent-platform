/**
 * Konstans idejű megosztott-titok összehasonlítás — DB nélküli, tiszta logikai tesztek.
 *
 * A `safeSecretEquals` a privilegizált belső végpontok (dispatcher control token, harness
 * completion callback, metrics scrape) egyetlen megosztott titkát hasonlítja. Az invariáns:
 * (1) csak a pontosan egyező titok ad `true`-t, (2) minden hiányzó/üres/eltérő eset fail-closed
 * `false`, (3) az eltérő hosszú bemenet nem dob (a `timingSafeEqual` egyenlő hosszú bufferekre
 * fut). Ha ez elromlana, egy titkos-kapu vagy megnyílna (biztonsági rés), vagy hamis 401-et adna.
 *
 * Futtatás: npm run test:timing-safe-token
 */
import assert from 'node:assert/strict'
import { safeSecretEquals } from '../src/lib/crypto/timing-safe'

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
    failed += 1
  }
}

const SECRET = 'dispatcher-control-Xz9k2p7q-abcdef0123456789'

check('pontos egyezés → true', () => {
  assert.equal(safeSecretEquals(SECRET, SECRET), true)
})

check('eltérő azonos hosszú titok → false', () => {
  const almost = SECRET.slice(0, -1) + (SECRET.endsWith('9') ? '8' : '9')
  assert.equal(almost.length, SECRET.length)
  assert.equal(safeSecretEquals(almost, SECRET), false)
})

check('eltérő hosszú (prefix) → false, nem dob', () => {
  assert.equal(safeSecretEquals(SECRET.slice(0, 10), SECRET), false)
})

check('hosszabb bemenet → false, nem dob', () => {
  assert.equal(safeSecretEquals(SECRET + 'extra', SECRET), false)
})

check('üres provided → false', () => {
  assert.equal(safeSecretEquals('', SECRET), false)
})

check('null / undefined provided → false (fail-closed)', () => {
  assert.equal(safeSecretEquals(null, SECRET), false)
  assert.equal(safeSecretEquals(undefined, SECRET), false)
})

check('hiányzó expected → false (nincs beállított titok = nincs átjutás)', () => {
  assert.equal(safeSecretEquals(SECRET, ''), false)
  assert.equal(safeSecretEquals(SECRET, null), false)
  assert.equal(safeSecretEquals(SECRET, undefined), false)
})

check('mindkét oldal hiányzik → false', () => {
  assert.equal(safeSecretEquals(null, null), false)
  assert.equal(safeSecretEquals('', ''), false)
})

check('unicode/multibyte titok pontos egyezése → true', () => {
  const s = 'tökéletes-🔐-titok'
  assert.equal(safeSecretEquals(s, s), true)
  assert.equal(safeSecretEquals('tökéletes-🔓-titok', s), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
