/**
 * Agent munkaterület: a chat-sín / board-fül chrome kikerült a live app-ból (Phase F).
 * Futtatás: npm run test:agent-workspace-board
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e: unknown) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

const gone = [
  'src/lib/agent-workspace-routes.ts',
  'src/lib/ticket-display.ts',
  'src/components/agents/agent-rail-card.tsx',
  'src/lib/agent-rail-compose.ts',
  'src/components/agents/agent-workspace.tsx',
  'src/components/agents/agent-rail.tsx',
  'src/app/api/agents/rail-state/route.ts',
]

check('agent rail / workspace chrome is gone from live app', () => {
  for (const rel of gone) {
    assert.equal(existsSync(resolve(process.cwd(), rel)), false, rel)
  }
})

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott`)
  process.exit(1)
}
console.log('\nMinden teszt rendben.')
