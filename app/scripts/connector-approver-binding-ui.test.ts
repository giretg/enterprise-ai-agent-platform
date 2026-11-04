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
assert.match(form, /ConnectorTemplateIcon/)
assert.match(form, /ConnectorListIcon/)
assert.match(form, /kind: 'connector'/)
assert.match(page, /canManageApprovers=\{canManage\}/)

// A közös postafiók nem „Régi kapcsolat”, és be nem kötve nem látszik csatlakoztatottnak.
const panel = readFileSync(
  resolve(import.meta.dirname, '../src/app/control-plane/provisioning/provisioning-panel.tsx'),
  'utf8',
)
assert.match(panel, /!listed\.has\(row\.id\) && !row\.tenantMailbox/)
assert.match(panel, /tenantMailboxRows\.filter\(\(row\) => row\.tenantMailbox\?\.connected\)/)
assert.match(panel, /tenantMailboxRows\.filter\(\(row\) => !row\.tenantMailbox\?\.connected\)[\s\S]{0,220}hubStatusNotConnected/)
console.log('connector-approver-binding-ui.test.ts: ok')
