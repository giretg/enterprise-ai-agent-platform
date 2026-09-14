/**
 * robots.txt — a control-plane zárt, a Google OAuth branding-oldalak nyitottak.
 * Futtatás: npx tsx scripts/robots.test.ts
 */
import assert from 'node:assert/strict'
import robots from '../src/app/robots'

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

check('alapból a branding-oldalak engedélyezettek, a többi tiltott', () => {
  const prev = process.env.ALLOW_SEARCH_INDEXING
  try {
    delete process.env.ALLOW_SEARCH_INDEXING
    const result = robots()
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules
    assert.deepEqual(rules.allow, ['/$', '/privacy', '/gtc'])
    assert.equal(rules.disallow, '/')
  } finally {
    if (prev === undefined) delete process.env.ALLOW_SEARCH_INDEXING
    else process.env.ALLOW_SEARCH_INDEXING = prev
  }
})

check('ALLOW_SEARCH_INDEXING=true mindent megnyit', () => {
  const prev = process.env.ALLOW_SEARCH_INDEXING
  try {
    process.env.ALLOW_SEARCH_INDEXING = 'true'
    const result = robots()
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules
    assert.equal(rules.allow, '/')
    assert.equal(rules.disallow, undefined)
  } finally {
    if (prev === undefined) delete process.env.ALLOW_SEARCH_INDEXING
    else process.env.ALLOW_SEARCH_INDEXING = prev
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
