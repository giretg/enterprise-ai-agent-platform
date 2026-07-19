/**
 * Workspace resource tenant boundary tests.
 * Run: npm run test:workspace-resource-access
 */
import assert from 'node:assert/strict'
import {
  resolveToolWorkspaceTenantKey,
  resolveWorkspaceTenantKey,
} from '../src/lib/workspace-resource-access'

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

check('tool workspace prefers ticket/conversation tenant over acting and connector', () => {
  assert.equal(
    resolveToolWorkspaceTenantKey({
      resourceTenantId: 'tenant-ticket',
      actingTenantId: 'tenant-acting',
      connectorTenantId: 'tenant-connector',
    }),
    'tenant-ticket',
  )
})

check('tool workspace uses acting tenant when resource tenant is missing', () => {
  assert.equal(
    resolveToolWorkspaceTenantKey({
      resourceTenantId: null,
      actingTenantId: 'tenant-acting',
      connectorTenantId: 'tenant-connector',
    }),
    'tenant-acting',
  )
})

check('board task without acting user still hits ticket tenant, not global', () => {
  assert.equal(
    resolveToolWorkspaceTenantKey({
      resourceTenantId: 'tenant-ticket',
      actingTenantId: null,
      connectorTenantId: null,
    }),
    'tenant-ticket',
  )
})

check('tool workspace falls back to global only when every tenant key is missing', () => {
  assert.equal(
    resolveToolWorkspaceTenantKey({
      resourceTenantId: null,
      actingTenantId: null,
      connectorTenantId: null,
    }),
    'global',
  )
})

if (failures > 0) {
  console.error(`\n${failures} workspace resource access test(s) failed`)
  process.exit(1)
}

console.log('\nworkspace-resource-access tests passed')
