import assert from 'node:assert/strict'
import { isAgentTurnAccessible } from '../src/lib/agent-turn-access'

const actor = {
  activeTenantId: 'tenant-a',
  user: { id: 'user-1' },
}

assert.equal(
  isAgentTurnAccessible({ tenantId: 'tenant-a', createdById: 'user-1' }, actor),
  true,
)
assert.equal(
  isAgentTurnAccessible({ tenantId: 'tenant-b', createdById: 'user-1' }, actor),
  false,
)
assert.equal(
  isAgentTurnAccessible({ tenantId: 'tenant-a', createdById: 'user-2' }, actor),
  false,
)

console.log('agent-turn-access.test.ts: ok')
