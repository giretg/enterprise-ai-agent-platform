/**
 * #739 UI: írási jóváhagyások az agent adatlap Írások szekciójában.
 * Futtatás: node --import tsx scripts/agent-write-approval-ui.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const form = readFileSync(
  resolve(import.meta.dirname, '../src/components/agents/update-write-approval-form.tsx'),
  'utf8',
)
const agentPage = readFileSync(
  resolve(import.meta.dirname, '../src/app/control-plane/agents/[agentId]/page.tsx'),
  'utf8',
)

assert.match(form, /updateAgentWriteApprovalModes/)
assert.match(form, /Céges API/)
assert.match(form, /Gmail/)
assert.match(form, /Drive és táblázat/)
assert.match(form, /Memória/)
assert.match(form, /role="switch"/)
assert.match(agentPage, /UpdateWriteApprovalForm/)
assert.doesNotMatch(agentPage, /UpdateMemoryWriteModeForm/)
console.log('agent-write-approval-ui.test.ts: ok')
