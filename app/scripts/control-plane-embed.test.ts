/**
 * Control-plane embed (modal iframe) kérésfelismerés.
 * Futtatás: npx tsx scripts/control-plane-embed.test.ts
 */
import assert from 'node:assert/strict'
import { embedHrefForPanel, isControlPlaneEmbedRequest } from '../src/lib/control-plane-embed'

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

console.log('control-plane-embed')

check('rewrite fejléc → embed', () => {
  assert.equal(
    isControlPlaneEmbedRequest({ get: (n) => (n === 'x-cp-embed' ? '1' : null) }),
    true,
  )
})

check('iframe dokumentum-betöltés (ticket a modálban) → embed', () => {
  assert.equal(
    isControlPlaneEmbedRequest({ get: (n) => (n === 'sec-fetch-dest' ? 'iframe' : null) }),
    true,
  )
})

check('szülőablak navigáció → nem embed', () => {
  assert.equal(
    isControlPlaneEmbedRequest({ get: (n) => (n === 'sec-fetch-dest' ? 'document' : null) }),
    false,
  )
  assert.equal(isControlPlaneEmbedRequest({ get: () => null }), false)
})

check('ismert panel kulcsnak van href-je', () => {
  assert.equal(embedHrefForPanel('board'), '/control-plane/board')
  assert.equal(embedHrefForPanel('ticket.missing'), null)
})

if (failed > 0) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('All passed')
