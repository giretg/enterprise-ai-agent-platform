/**
 * Konnektoronkénti jóváhagyó az agent Kapcsolatok paneljén.
 * Futtatás: node --import tsx scripts/connector-approver-binding-ui.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const form = readFileSync(
  resolve(import.meta.dirname, '../src/components/agents/agent-connector-binding-form.tsx'),
  'utf8',
)
const page = readFileSync(
  resolve(import.meta.dirname, '../src/app/control-plane/agents/[agentId]/page.tsx'),
  'utf8',
)

assert.match(form, /canManageApprovers/)
assert.match(form, /kind: 'connector'/)
assert.match(page, /canManageApprovers=\{canManage\}/)
console.log('connector-approver-binding-ui.test.ts: ok')
