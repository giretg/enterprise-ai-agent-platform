/**
 * Ticket workspace-lista újratöltési szabály.
 * Run: npx tsx scripts/ticket-workspace-files.test.ts
 *
 * A vimpex-riport futáson a docx_create sikerült, a fájl a lemezen volt,
 * a panel mégis üres maradt: a lista csak mountkor töltődött, in_progress → done
 * után nem. A backtickelt fájlnév ettől nem lett kattintható.
 */
import assert from 'node:assert/strict'
import { shouldPollTicketWorkspaceFiles } from '../src/lib/ticket-workspace-files-client'

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

check('élő futásnál pollol, hogy a docx a válasz előtt is megjelenjen', () => {
  assert.equal(shouldPollTicketWorkspaceFiles('in_progress'), true)
})

check('kész / várakozó ticketnél nem pollol — az állapotváltás tölti újra', () => {
  assert.equal(shouldPollTicketWorkspaceFiles('done'), false)
  assert.equal(shouldPollTicketWorkspaceFiles('awaiting_human'), false)
  assert.equal(shouldPollTicketWorkspaceFiles('ready'), false)
  assert.equal(shouldPollTicketWorkspaceFiles('backlog'), false)
})

if (failures > 0) process.exit(1)
console.log('\nticket workspace files tests passed')
