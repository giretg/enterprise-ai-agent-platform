/**
 * ResourceGrant visibility: admin sees all, operator needs view|operate (#539).
 * Futtatás: npm run test:resource-grant
 */
import assert from 'node:assert/strict'
import { isPrivilegedAgentReader } from '../src/domain/agent-definition'

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

function canRead(role: string, grant: { accessLevel: string } | null): boolean {
  if (isPrivilegedAgentReader(role)) return true
  return grant?.accessLevel === 'view' || grant?.accessLevel === 'operate'
}

check('admin sees all without a grant row', () => {
  assert.equal(canRead('admin', null), true)
})

check('approver sees all without a grant row', () => {
  assert.equal(canRead('approver', null), true)
})

check('assumed superadmin is admin and sees all', () => {
  assert.equal(isPrivilegedAgentReader('admin'), true)
  assert.equal(canRead('admin', null), true)
})

check('operator needs view or operate', () => {
  assert.equal(canRead('operator', null), false)
  assert.equal(canRead('operator', { accessLevel: 'view' }), true)
  assert.equal(canRead('operator', { accessLevel: 'operate' }), true)
})

check('viewer needs view or operate', () => {
  assert.equal(canRead('viewer', null), false)
  assert.equal(canRead('viewer', { accessLevel: 'view' }), true)
})

if (failures > 0) {
  console.error(`resource-grant: ${failures} failure(s)`)
  process.exit(1)
}
console.log('resource-grant: ok')
