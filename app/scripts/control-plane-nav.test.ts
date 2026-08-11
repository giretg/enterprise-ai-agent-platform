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
    assert.ok(!hrefs.includes('/control-plane/menu-access'))
  })

  check('admin sees tenant admin pages but not platform pages without platform role', () => {
    const hrefs = flattenNavHrefs(
      buildControlPlaneNav({ tenantRole: 'admin', platformRoles: [] }),
    )
    assert.ok(hrefs.includes('/control-plane/iam'))
    assert.ok(hrefs.includes('/control-plane/menu-access'))
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
    assert.ok(hrefs.includes('/control-plane/platform/system-agents'))
  })

  check('viewer with no admin children still sees core nav', () => {
    const nav = buildControlPlaneNav({ tenantRole: 'viewer', platformRoles: [] })
    const hrefs = flattenNavHrefs(nav)
    assert.ok(hrefs.includes('/control-plane/board'))
    assert.ok(hrefs.includes('/control-plane/connectors'))
    const adminGroup = nav.find((entry) => 'children' in entry && entry.label === 'Adminisztráció')
    assert.ok(adminGroup && 'children' in adminGroup)
    // Fiókom + Fiókok — a viewer a SAJÁT fiókkötéseit látja, más admin oldalt nem.
    assert.deepEqual(
      adminGroup.children.map((child) => child.href),
      ['/control-plane/account', '/control-plane/connectors'],
    )
  })

  // ── Menü-láthatósági policy ───────────────────────────────────────────────

  check('nav keys are unique across the catalog', () => {
    const keys = allNavKeys()
    assert.equal(new Set(keys).size, keys.length)
    assert.ok(keys.includes('admin.menu-access'))
  })

  check('hiding a leaf removes it only for the targeted role', () => {
    const navVisibility = policyWith({ operator: ['automation.playbooks'] })
    const operator = flattenNavHrefs(
      buildControlPlaneNav({ tenantRole: 'operator', platformRoles: [], navVisibility }),
    )
    const approver = flattenNavHrefs(
      buildControlPlaneNav({ tenantRole: 'approver', platformRoles: [], navVisibility }),
    )
    assert.ok(!operator.includes('/control-plane/playbooks'))
    assert.ok(operator.includes('/control-plane/processes'))
    assert.ok(approver.includes('/control-plane/playbooks'))
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
          'automation.scheduled-tasks',
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
    assert.ok(hrefs.includes('/control-plane/board'))
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
