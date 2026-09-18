/**
 * Control Plane nav role-szűrés + szerepkörönkénti menü-láthatóság.
 *
 * Futtatás: npx tsx scripts/control-plane-nav.test.ts
 */
import assert from 'node:assert/strict'
import {
  allNavKeys,
  buildControlPlaneNav,
  flattenNavHrefs,
  CONTROL_PLANE_NAV_CATALOG,
} from '../src/lib/control-plane-nav'
import {
  NAV_KEYS_LOCKED_FOR_ADMIN,
  emptyNavVisibilityPolicy,
  readNavVisibilityPolicy,
  sanitizeNavVisibilityPolicy,
  withNavVisibilityPolicy,
  type NavVisibilityPolicy,
} from '../src/lib/nav-visibility'

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

function policyWith(patch: Partial<NavVisibilityPolicy>): NavVisibilityPolicy {
  return { ...emptyNavVisibilityPolicy(), ...patch }
}

function main() {
  check('operator sees Kapcsolt fiókok in the main nav, not under Adminisztráció', () => {
    const nav = buildControlPlaneNav({
      tenantRole: 'operator',
      platformRoles: [],
    })
    const hrefs = flattenNavHrefs(nav)
    assert.ok(hrefs.includes('/control-plane/account'))
    assert.ok(hrefs.includes('/control-plane/agents'))
    assert.ok(!hrefs.includes('/control-plane/connectors'))
    assert.ok(!hrefs.includes('/control-plane/iam'))
    assert.ok(!hrefs.includes('/control-plane/provisioning'))
    assert.ok(!hrefs.includes('/control-plane/system'))
    assert.ok(!hrefs.includes('/control-plane/governance'))
    assert.ok(!hrefs.includes('/control-plane/audit'))
    assert.ok(!hrefs.includes('/control-plane/platform/tenants'))
    assert.ok(!hrefs.includes('/control-plane/menu-access'))
    assert.ok(!hrefs.includes('/control-plane/operations'))
    const account = nav.find((entry) => !('children' in entry) && entry.key === 'account')
    assert.ok(account && !('children' in account))
    assert.equal(account.label, 'Kapcsolt fiókok')
    assert.ok(!nav.some((entry) => 'children' in entry && entry.label === 'Adminisztráció'))
  })

  check('admin sees tenant admin pages but not platform pages without platform role', () => {
    const hrefs = flattenNavHrefs(
      buildControlPlaneNav({ tenantRole: 'admin', platformRoles: [] }),
    )
    assert.ok(hrefs.includes('/control-plane/iam'))
    assert.ok(hrefs.includes('/control-plane/settings'))
    assert.ok(hrefs.includes('/control-plane/menu-access'))
    assert.ok(hrefs.includes('/control-plane/provisioning'))
    assert.ok(hrefs.includes('/control-plane/operations'))
    assert.ok(!hrefs.includes('/control-plane/system'))
    assert.ok(!hrefs.includes('/control-plane/governance'))
    assert.ok(!hrefs.includes('/control-plane/audit'))
    assert.ok(!hrefs.includes('/control-plane/platform/tenants'))
  })

  check('approver does not see IAM or Audit', () => {
    const hrefs = flattenNavHrefs(
      buildControlPlaneNav({ tenantRole: 'approver', platformRoles: [] }),
    )
    assert.ok(!hrefs.includes('/control-plane/audit'))
    assert.ok(hrefs.includes('/control-plane/account'))
    assert.ok(hrefs.includes('/control-plane/operations'))
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
    assert.ok(!hrefs.includes('/control-plane/platform/system-agents'))
  })

  check('viewer sees Kapcsolt fiókok and no Adminisztráció group', () => {
    const nav = buildControlPlaneNav({ tenantRole: 'viewer', platformRoles: [] })
    const hrefs = flattenNavHrefs(nav)
    assert.ok(hrefs.includes('/control-plane/agents'))
    assert.ok(hrefs.includes('/control-plane/account'))
    assert.ok(!nav.some((entry) => 'children' in entry && entry.label === 'Adminisztráció'))
    const account = nav.find((entry) => !('children' in entry) && entry.key === 'account')
    assert.ok(account && !('children' in account))
    assert.equal(account.label, 'Kapcsolt fiókok')
  })

  check('header keeps Munkatársak tools after the roster moved to the rail', () => {
    const nav = buildControlPlaneNav({ tenantRole: 'operator', platformRoles: [] })
    const staff = nav.find((entry) => 'children' in entry && entry.key === 'staff')
    assert.ok(staff && 'children' in staff)
    assert.equal(staff.label, 'Katalógus')
    const hrefs = staff.children.map((child) => child.href)
    assert.ok(!hrefs.includes('/control-plane/training'))
    assert.ok(hrefs.includes('/control-plane/skills'))
    assert.ok(!hrefs.includes('/control-plane/behavior-profiles'))
    assert.ok(!hrefs.includes('/control-plane/apps'))
    assert.ok(!hrefs.includes('/control-plane/sandbox-versions'))
    assert.ok(!hrefs.includes('/control-plane/agents'))
    assert.ok(!hrefs.includes('/control-plane/agent-access'))
  })

  // ── Menü-láthatósági policy ───────────────────────────────────────────────

  check('nav keys are unique across the catalog', () => {
    const keys = allNavKeys()
    assert.equal(new Set(keys).size, keys.length)
    assert.ok(keys.includes('admin.menu-access'))
  })

  check('hiding legacy admin.connectors still hides Kapcsolt fiókok', () => {
    const hrefs = flattenNavHrefs(
      buildControlPlaneNav({
        tenantRole: 'operator',
        platformRoles: [],
        navVisibility: policyWith({ operator: ['admin.connectors'] }),
      }),
    )
    assert.ok(!hrefs.includes('/control-plane/account'))
    assert.ok(hrefs.includes('/control-plane/agents'))
  })

  check('hiding the Adminisztráció group does not hide Kapcsolt fiókok', () => {
    const hrefs = flattenNavHrefs(
      buildControlPlaneNav({
        tenantRole: 'operator',
        platformRoles: [],
        navVisibility: policyWith({ operator: ['admin'] }),
      }),
    )
    assert.ok(hrefs.includes('/control-plane/account'))
    assert.ok(!hrefs.includes('/control-plane/iam'))
  })

  check('hiding a leaf removes it only for the targeted role', () => {
    const navVisibility = policyWith({ operator: ['automation.playbooks'] })
    const operator = flattenNavHrefs(
      buildControlPlaneNav({ tenantRole: 'operator', platformRoles: [], navVisibility }),
    )
    const approver = flattenNavHrefs(
      buildControlPlaneNav({ tenantRole: 'approver', platformRoles: [], navVisibility }),
    )
    assert.ok(operator.includes('/control-plane/skills'))
    assert.ok(operator.includes('/control-plane/agents'))
    assert.ok(approver.includes('/control-plane/skills'))
  })

  check('hiding a group removes the whole dropdown', () => {
    const nav = buildControlPlaneNav({
      tenantRole: 'operator',
      platformRoles: [],
      navVisibility: policyWith({ operator: ['automation'] }),
    })
    assert.ok(!nav.some((entry) => 'children' in entry && entry.label === 'Automatizálás'))
    assert.ok(!flattenNavHrefs(nav).includes('/control-plane/monitors'))
  })

  check('a group whose children are all hidden disappears', () => {
    const nav = buildControlPlaneNav({
      tenantRole: 'operator',
      platformRoles: [],
      navVisibility: policyWith({
        operator: [
          'automation.playbooks',
          'automation.step-templates',
          'automation.processes',
          'automation.monitors',
        ],
      }),
    })
    assert.ok(!nav.some((entry) => 'children' in entry && entry.label === 'Automatizálás'))
  })

  check('policy cannot widen access beyond the role gate', () => {
    // Az operátor menüjéből "elrejtjük" az IAM-ot, amit amúgy sem lát: a művelet
    // nem lehet mellékhatásos, és a másik szerepkörnél sem szivároghat át.
    const hrefs = flattenNavHrefs(
      buildControlPlaneNav({
        tenantRole: 'operator',
        platformRoles: [],
        navVisibility: policyWith({ viewer: ['board'] }),
      }),
    )
    assert.ok(!hrefs.includes('/control-plane/iam'))
    assert.ok(hrefs.includes('/control-plane/agents'))
  })

  check('admin lockout is impossible — menu-access stays visible', () => {
    const nav = buildControlPlaneNav({
      tenantRole: 'admin',
      platformRoles: [],
      navVisibility: sanitizeNavVisibilityPolicy({
        admin: [...NAV_KEYS_LOCKED_FOR_ADMIN, 'admin.iam'],
      }),
    })
    const hrefs = flattenNavHrefs(nav)
    assert.ok(hrefs.includes('/control-plane/menu-access'))
    assert.ok(!hrefs.includes('/control-plane/iam'))
  })

  check('sanitize normalizes junk input and strips admin-locked keys', () => {
    const policy = sanitizeNavVisibilityPolicy({
      viewer: ['board', 'board', '  ', 42, 'admin.iam'],
      admin: ['admin', 'admin.menu-access', 'admin.system'],
      nonsense: ['board'],
    })
    assert.deepEqual(policy.viewer, ['admin.iam', 'board'])
    assert.deepEqual(policy.admin, ['admin.system'])
    assert.deepEqual(policy.operator, [])
    assert.deepEqual(policy.approver, [])
  })

  check('settings round-trip keeps other tenant settings intact', () => {
    const settings = { language: 'hu', navVisibility: { viewer: ['board'] } }
    const next = withNavVisibilityPolicy(settings, policyWith({ operator: ['staff.skills'] })) as Record<
      string,
      unknown
    >
    assert.equal(next.language, 'hu')
    const roundTrip = readNavVisibilityPolicy(next)
    assert.deepEqual(roundTrip.operator, ['staff.skills'])
    assert.deepEqual(roundTrip.viewer, [])
  })

  check('missing / malformed settings fall back to the empty policy', () => {
    assert.deepEqual(readNavVisibilityPolicy(undefined), emptyNavVisibilityPolicy())
    assert.deepEqual(readNavVisibilityPolicy({ navVisibility: 'nope' }), emptyNavVisibilityPolicy())
    assert.deepEqual(readNavVisibilityPolicy([1, 2, 3]), emptyNavVisibilityPolicy())
  })

  check('empty policy reproduces the legacy nav exactly', () => {
    for (const tenantRole of ['viewer', 'operator', 'approver', 'admin'] as const) {
      const withPolicy = flattenNavHrefs(
        buildControlPlaneNav({
          tenantRole,
          platformRoles: [],
          navVisibility: emptyNavVisibilityPolicy(),
        }),
      )
      const without = flattenNavHrefs(buildControlPlaneNav({ tenantRole, platformRoles: [] }))
      assert.deepEqual(withPolicy, without)
    }
  })

  check('catalog leaves all carry a href and a stable key', () => {
    for (const entry of CONTROL_PLANE_NAV_CATALOG) {
      assert.ok(entry.key.length > 0, `${entry.label} has no key`)
      if ('children' in entry) {
        for (const child of entry.children) {
          assert.ok(child.key.startsWith(`${entry.key}.`), `${child.key} is not scoped to ${entry.key}`)
          assert.ok(child.href.startsWith('/control-plane'), `${child.key} has a foreign href`)
        }
      }
    }
  })

  console.log(`\n${failures === 0 ? 'Minden teszt zöld.' : `${failures} teszt bukott.`}`)
  if (failures > 0) process.exit(1)
}

main()
