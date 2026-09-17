/**
 * Ticket-lap háttérfülön ne pollozzon.
 * Run: npx tsx scripts/ticket-poll-visibility.test.ts
 *
 * Health-check lelet (2026-09-17): egy `awaiting_human` állapotban rekedt
 * ticket 8+ órán át, háttérfülön hagyva ~2750 kérést generált 24 óra alatt
 * (ticket-activity-history 2s, connector-grants + consequence-approvals 8s
 * `router.refresh()`-e — mindhárom fülláthatóságtól függetlenül futott).
 */
import assert from 'node:assert/strict'
import { shouldFireVisibilityGatedPoll } from '../src/lib/visibility-gated-poll'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures++
    console.error(`  ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

check('látható fülön mindig pollol', () => {
  assert.equal(shouldFireVisibilityGatedPoll(false, true), true)
  assert.equal(shouldFireVisibilityGatedPoll(false, false), true)
})

check('rejtett fülön szünetel, ha a szüneteltetés be van kapcsolva', () => {
  assert.equal(shouldFireVisibilityGatedPoll(true, true), false)
})

check('rejtett fülön is pollol, ha NEXT_PUBLIC_TICKET_POLL_PAUSE_ON_HIDDEN_TAB=false', () => {
  assert.equal(shouldFireVisibilityGatedPoll(true, false), true)
})

if (failures > 0) process.exit(1)
console.log('\nticket poll visibility tests passed')
