/**
 * #663 / #739 UI: jóváhagyó az Írások űrlapon, nem a Kapcsolt fiókok kártyán.
 * Futtatás: node --import tsx scripts/agent-memory-approver-ui.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const form = readFileSync(
  resolve(import.meta.dirname, '../src/components/agents/update-write-approval-form.tsx'),
  'utf8',
)
const connectorCard = readFileSync(
  resolve(import.meta.dirname, '../src/components/account/connector-connection-card.tsx'),
  'utf8',
)
const agentPage = readFileSync(
  resolve(import.meta.dirname, '../src/app/control-plane/agents/[agentId]/page.tsx'),
  'utf8',
)

assert.match(form, /updateAgentWriteApprovalModes/)
assert.match(form, /needsApprover/)
assert.doesNotMatch(agentPage, /UpdateApproverForm/)
assert.doesNotMatch(connectorCard, /UpdateApproverForm/)
console.log('agent-memory-approver-ui.test.ts: ok')
