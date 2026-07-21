/**
 * Agent operator-láthatóság — admin elrejtheti az agentet az operátorok elől
 * anélkül, hogy a futást/dispatch-et megállítaná.
 *
 * Futtatás: npx tsx scripts/agent-operator-visibility.test.ts
 *
 * AOV-1: admin látja a rejtett agentet is.
 * AOV-2: operator / approver / viewer nem látja a rejtett agentet.
 * AOV-3: nem rejtett agent minden szerepnek látszik.
 * AOV-4: a láthatóság NEM befolyásolja a dispatchelhetőséget (status marad a kapu).
 */

import assert from 'node:assert/strict'
import { isDispatchable } from '../src/lib/agent-lifecycle'
import {
  canViewAgent,
  shouldExcludeHiddenAgents,
} from '../src/lib/agent-operator-visibility'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  OK  ${name}`))
    .catch((e: unknown) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

async function main() {
  await check('AOV-1 admin látja a rejtett agentet', () => {
    assert.equal(canViewAgent('admin', { hiddenFromOperators: true }), true)
  })

  await check('AOV-2 operator / approver / viewer nem látja a rejtettet', () => {
    assert.equal(canViewAgent('operator', { hiddenFromOperators: true }), false)
    assert.equal(canViewAgent('approver', { hiddenFromOperators: true }), false)
    assert.equal(canViewAgent('viewer', { hiddenFromOperators: true }), false)
  })

  await check('AOV-3 nem rejtett agent minden szerepnek látszik', () => {
    for (const role of ['admin', 'approver', 'operator', 'viewer'] as const) {
      assert.equal(canViewAgent(role, { hiddenFromOperators: false }), true)
    }
  })

  await check('AOV-2b listázáskor csak admin kapja a rejtetteket', () => {
    assert.equal(shouldExcludeHiddenAgents('admin'), false)
    assert.equal(shouldExcludeHiddenAgents('operator'), true)
    assert.equal(shouldExcludeHiddenAgents('approver'), true)
    assert.equal(shouldExcludeHiddenAgents('viewer'), true)
  })

  await check('AOV-4 rejtett active agent továbbra is dispatchelhető', () => {
    // A láthatóság és a futás külön tengely: status === active → dispatch ok.
    assert.ok(isDispatchable('active'))
    assert.ok(!isDispatchable('suspended'))
  })

  if (failures > 0) {
    console.error(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nAll agent-operator-visibility checks passed')
}

main()
