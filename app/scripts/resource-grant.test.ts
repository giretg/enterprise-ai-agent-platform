/**
 * ResourceGrant visibility: admin sees all, operator needs view|operate (#539).
 * Futtatás: npm run test:resource-grant
 */
import assert from 'node:assert/strict'
import {
  canOperateAgent,
  canReadPublishedAgent,
  isPrivilegedAgentReader,
} from '../src/domain/agent-definition'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

check('admin sees all without a grant row', () => {
  assert.equal(canReadPublishedAgent({ role: 'admin', grant: null }), true)
})

check('approver sees all without a grant row', () => {
  assert.equal(canReadPublishedAgent({ role: 'approver', grant: null }), true)
})

check('assumed superadmin is admin and sees all', () => {
  assert.equal(isPrivilegedAgentReader('admin'), true)
  assert.equal(canReadPublishedAgent({ role: 'admin', grant: null }), true)
})

check('operator needs view or operate', () => {
  assert.equal(canReadPublishedAgent({ role: 'operator', grant: null }), false)
  assert.equal(canReadPublishedAgent({ role: 'operator', grant: { accessLevel: 'view' } }), true)
  assert.equal(canReadPublishedAgent({ role: 'operator', grant: { accessLevel: 'operate' } }), true)
  assert.equal(canReadPublishedAgent({ role: 'operator', grant: { accessLevel: 'approve' } }), false)
})

check('viewer needs view or operate', () => {
  assert.equal(canReadPublishedAgent({ role: 'viewer', grant: null }), false)
  assert.equal(canReadPublishedAgent({ role: 'viewer', grant: { accessLevel: 'view' } }), true)
})

check('operate requires operate grant; view is not enough', () => {
  assert.equal(canOperateAgent({ role: 'operator', grant: { accessLevel: 'view' } }), false)
  assert.equal(canOperateAgent({ role: 'operator', grant: { accessLevel: 'operate' } }), true)
  assert.equal(canOperateAgent({ role: 'viewer', grant: { accessLevel: 'operate' } }), true)
  assert.equal(canOperateAgent({ role: 'admin', grant: null }), true)
  assert.equal(canOperateAgent({ role: 'approver', grant: null }), true)
  assert.equal(canOperateAgent({ role: 'operator', grant: null, assumed: true }), true)
})

if (failures > 0) {
  console.error(`resource-grant: ${failures} failure(s)`)
  process.exit(1)
}
console.log('resource-grant: ok')
