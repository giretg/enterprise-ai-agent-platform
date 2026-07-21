/**
 * Control Plane nav role-szűrés.
 *
 * Futtatás: npx tsx scripts/control-plane-nav.test.ts
 */
import assert from 'node:assert/strict'
import { buildControlPlaneNav, flattenNavHrefs } from '../src/lib/control-plane-nav'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.error(`  FAIL ${name}:`, error)
  }
}

function main() {
  check('operator sees Fiókok under Adminisztráció, not IAM/Platform/Rendszer', () => {
    const nav = buildControlPlaneNav({
      tenantRole: 'operator',
      platformRoles: [],
    })
    const hrefs = flattenNavHrefs(nav)
    assert.ok(hrefs.includes('/control-plane/connectors'))
    assert.ok(!hrefs.includes('/control-plane/iam'))
    assert.ok(!hrefs.includes('/control-plane/provisioning'))
    assert.ok(!hrefs.includes('/control-plane/system'))
    assert.ok(!hrefs.includes('/control-plane/governance'))
    assert.ok(!hrefs.includes('/control-plane/audit'))
    assert.ok(!hrefs.includes('/control-plane/platform/tenants'))
  })

  check('admin sees tenant admin pages but not platform pages without platform role', () => {
    const hrefs = flattenNavHrefs(
      buildControlPlaneNav({ tenantRole: 'admin', platformRoles: [] }),
    )
    assert.ok(hrefs.includes('/control-plane/iam'))
    assert.ok(hrefs.includes('/control-plane/provisioning'))
    assert.ok(hrefs.includes('/control-plane/system'))
    assert.ok(hrefs.includes('/control-plane/governance'))
    assert.ok(hrefs.includes('/control-plane/audit'))
    assert.ok(!hrefs.includes('/control-plane/platform/tenants'))
  })

  check('approver sees Audit but not IAM', () => {
    const hrefs = flattenNavHrefs(
      buildControlPlaneNav({ tenantRole: 'approver', platformRoles: [] }),
    )
    assert.ok(hrefs.includes('/control-plane/audit'))
    assert.ok(hrefs.includes('/control-plane/connectors'))
    assert.ok(!hrefs.includes('/control-plane/iam'))
    assert.ok(!hrefs.includes('/control-plane/system'))
  })

  check('platform role reveals Platform menu items', () => {
    const hrefs = flattenNavHrefs(
      buildControlPlaneNav({
        tenantRole: 'operator',
        platformRoles: ['platform_auditor'],
      }),
    )
    assert.ok(hrefs.includes('/control-plane/platform/tenants'))
    assert.ok(hrefs.includes('/control-plane/platform/iam'))
    assert.ok(hrefs.includes('/control-plane/platform/settings'))
  })

  check('viewer with no admin children still sees core nav', () => {
    const nav = buildControlPlaneNav({ tenantRole: 'viewer', platformRoles: [] })
    const hrefs = flattenNavHrefs(nav)
    assert.ok(hrefs.includes('/control-plane/board'))
    assert.ok(hrefs.includes('/control-plane/connectors'))
    const adminGroup = nav.find((entry) => 'children' in entry && entry.label === 'Adminisztráció')
    assert.ok(adminGroup && 'children' in adminGroup)
    assert.equal(adminGroup.children.length, 1)
  })

  console.log(`\n${failures === 0 ? 'Minden teszt zöld.' : `${failures} teszt bukott.`}`)
  if (failures > 0) process.exit(1)
}

main()
