/**
 * Workspace resource tenant boundary tests.
 * Run: npm run test:workspace-resource-access
 */
import assert from 'node:assert/strict'
import { resolveWorkspaceTenantKey } from '../src/lib/workspace-resource-access'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

check('same-tenant resource resolves to the active tenant storage key', () => {
  assert.equal(resolveWorkspaceTenantKey({ tenantId: 'tenant-a' }, 'tenant-a'), 'tenant-a')
})

check('cross-tenant resource is denied opaquely', () => {
  assert.throws(
    () => resolveWorkspaceTenantKey({ tenantId: 'tenant-b' }, 'tenant-a'),
    /Workspace resource not found/,
  )
})

check('tenantless legacy resource is denied from tenant HTTP access', () => {
  assert.throws(
    () => resolveWorkspaceTenantKey({ tenantId: null }, 'tenant-a'),
    /Workspace resource not found/,
  )
})

if (failures > 0) {
  console.error(`\n${failures} workspace resource access test(s) failed`)
  process.exit(1)
}

console.log('\nworkspace-resource-access tests passed')
