/**
 * Control-plane embed (modal iframe) kérésfelismerés.
 * Futtatás: npx tsx scripts/control-plane-embed.test.ts
 */
import assert from 'node:assert/strict'
import { embedHrefForPanel, isClerkClientEnabledForRequest, isControlPlaneEmbedRequest } from '../src/lib/control-plane-embed'
import { isClerkEnabled } from '../src/lib/clerk-config'

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

check('embed iframe → Clerk kliens ki (szerver auth elég)', () => {
  const saved = process.env.AUTH_DISABLED
  delete process.env.AUTH_DISABLED
  process.env.CLERK_SECRET_KEY = 'sk_test'
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test'
  try {
    assert.equal(isClerkEnabled(), true)
    assert.equal(
      isClerkClientEnabledForRequest({ get: (n) => (n === 'x-cp-embed' ? '1' : null) }),
      false,
    )
    assert.equal(
      isClerkClientEnabledForRequest({ get: () => null }),
      true,
    )
  } finally {
    if (saved === undefined) delete process.env.AUTH_DISABLED
    else process.env.AUTH_DISABLED = saved
  }
})

if (failed > 0) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('All passed')
