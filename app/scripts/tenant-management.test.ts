/**
 * Tenant Management — tiszta logika negatív/invariáns tesztek
 * (Feature-spec Tenant-Management §5, §6, §7; döntések §3.3).
 *
 * Futtatás: DATABASE_URL=postgresql://stub:stub@127.0.0.1:5432/stub tsx scripts/tenant-management.test.ts
 *
 * Nincs DB-függőség — a `src/lib/tenant-policy.ts` tiszta függvényeit teszteli
 * (iam-policy.test.ts mintájára). A DB-t is érintő tenant-folyamatokat
 * (createTenant / membership / assume-audit / cross-tenant izoláció) a
 * TenantService in-memory teszt + acceptance-e2e fedi.
 */
import assert from 'node:assert/strict'
import {
  PLATFORM_ROLE_RANK,
  hasMinimumPlatformRole,
  isSuperadmin,
  tenantStatusAllowsOperations,
  tenantStatusAllowsLogin,
  resolveActiveTenant,
  decideSwitch,
  checkLastTenantAdminLock,
  isTenantDomainAllowed,
  normalizeTenantSlug,
  isValidTenantSlug,
  type MembershipView,
} from '../src/lib/tenant-policy'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  OK  ${name}`))
    .catch((e: unknown) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

const M = (over: Partial<MembershipView> & { tenantId: string }): MembershipView => ({
  role: 'operator',
  status: 'active',
  isDefault: false,
  ...over,
})

async function main() {
  // ── Platform-role rangsor (§6.2) ─────────────────────────────────────────
  await check('platform rang: auditor < operator < superadmin', () => {
    assert.ok(PLATFORM_ROLE_RANK.platform_auditor < PLATFORM_ROLE_RANK.platform_operator)
    assert.ok(PLATFORM_ROLE_RANK.platform_operator < PLATFORM_ROLE_RANK.superadmin)
  })

  await check('hasMinimumPlatformRole: superadmin minden platform-jogot lefed', () => {
    assert.equal(hasMinimumPlatformRole(['superadmin'], 'platform_operator'), true)
    assert.equal(hasMinimumPlatformRole(['superadmin'], 'platform_auditor'), true)
    assert.equal(hasMinimumPlatformRole(['superadmin'], 'superadmin'), true)
  })

  await check('hasMinimumPlatformRole: üres/hiányzó szerep ⇒ false', () => {
    assert.equal(hasMinimumPlatformRole([], 'platform_auditor'), false)
    assert.equal(hasMinimumPlatformRole(null, 'superadmin'), false)
    assert.equal(hasMinimumPlatformRole(undefined, 'platform_operator'), false)
  })

  await check('hasMinimumPlatformRole: auditor nem elég operator-művelethez', () => {
    assert.equal(hasMinimumPlatformRole(['platform_auditor'], 'platform_operator'), false)
    assert.equal(hasMinimumPlatformRole(['platform_auditor'], 'superadmin'), false)
    assert.equal(hasMinimumPlatformRole(['platform_operator'], 'platform_auditor'), true)
  })

  await check('isSuperadmin', () => {
    assert.equal(isSuperadmin(['superadmin']), true)
    assert.equal(isSuperadmin(['platform_operator']), false)
    assert.equal(isSuperadmin([]), false)
  })

  // ── Tenant-státusz kapuk (§7.3) ──────────────────────────────────────────
  await check('tenantStatusAllowsOperations: csak active enged műveletet', () => {
    assert.equal(tenantStatusAllowsOperations('active'), true)
    assert.equal(tenantStatusAllowsOperations('suspended'), false)
    assert.equal(tenantStatusAllowsOperations('offboarding'), false)
    assert.equal(tenantStatusAllowsOperations('archived'), false)
  })

  await check('tenantStatusAllowsLogin: active + suspended beléphet, archived nem', () => {
    assert.equal(tenantStatusAllowsLogin('active'), true)
    assert.equal(tenantStatusAllowsLogin('suspended'), true)
    assert.equal(tenantStatusAllowsLogin('archived'), false)
    assert.equal(tenantStatusAllowsLogin('offboarding'), false)
  })

  // ── Aktív-tenant feloldás (§5.2) ─────────────────────────────────────────
  await check('resolveActiveTenant: nincs membership, nincs platform ⇒ none', () => {
    const r = resolveActiveTenant({ memberships: [], platformRoles: [] })
    assert.equal(r.kind, 'none')
  })

  await check('resolveActiveTenant: nincs tenant de van platform ⇒ platform', () => {
    const r = resolveActiveTenant({ memberships: [], platformRoles: ['superadmin'] })
    assert.equal(r.kind, 'platform')
  })

  await check('resolveActiveTenant: egyetlen active membership ⇒ automatikusan az', () => {
    const r = resolveActiveTenant({ memberships: [M({ tenantId: 't1', role: 'admin' })], platformRoles: [] })
    assert.equal(r.kind, 'tenant')
    if (r.kind === 'tenant') {
      assert.equal(r.tenantId, 't1')
      assert.equal(r.role, 'admin')
    }
  })

  await check('resolveActiveTenant: pending membership nem választható ⇒ none', () => {
    const r = resolveActiveTenant({
      memberships: [M({ tenantId: 't1', status: 'pending' })],
      platformRoles: [],
    })
    assert.equal(r.kind, 'none')
  })

  await check('resolveActiveTenant: explicit választás a saját active membershipre', () => {
    const r = resolveActiveTenant({
      memberships: [M({ tenantId: 't1' }), M({ tenantId: 't2', role: 'viewer' })],
      platformRoles: [],
      requestedTenantId: 't2',
    })
    assert.equal(r.kind, 'tenant')
    if (r.kind === 'tenant') assert.equal(r.tenantId, 't2')
  })

  await check('resolveActiveTenant: érvénytelen választás ⇒ default-útra esik vissza', () => {
    const r = resolveActiveTenant({
      memberships: [M({ tenantId: 't1', isDefault: true }), M({ tenantId: 't2' })],
      platformRoles: [],
      requestedTenantId: 'nonexistent',
    })
    assert.equal(r.kind, 'tenant')
    if (r.kind === 'tenant') assert.equal(r.tenantId, 't1') // a default
  })

  await check('resolveActiveTenant: default active membership elsőbbsége', () => {
    const r = resolveActiveTenant({
      memberships: [M({ tenantId: 't1' }), M({ tenantId: 't2', isDefault: true })],
      platformRoles: [],
    })
    assert.equal(r.kind, 'tenant')
    if (r.kind === 'tenant') assert.equal(r.tenantId, 't2')
  })

  await check('resolveActiveTenant: több active default nélkül ⇒ első (determinisztikus)', () => {
    const r = resolveActiveTenant({
      memberships: [M({ tenantId: 't1' }), M({ tenantId: 't2' })],
      platformRoles: [],
    })
    assert.equal(r.kind, 'tenant')
    if (r.kind === 'tenant') assert.equal(r.tenantId, 't1')
  })

  await check('resolveActiveTenant: nem választhat suspended tenant-membershipre explicit sem', () => {
    const r = resolveActiveTenant({
      memberships: [M({ tenantId: 't1' }), M({ tenantId: 't2', status: 'suspended' })],
      platformRoles: [],
      requestedTenantId: 't2',
    })
    assert.equal(r.kind, 'tenant')
    if (r.kind === 'tenant') assert.equal(r.tenantId, 't1') // t2 suspended ⇒ default-út
  })

  // ── Tenant-váltás / assume (§5.3) ────────────────────────────────────────
  await check('decideSwitch: tag saját active membershipre válthat (member mód)', () => {
    const d = decideSwitch({
      targetTenantId: 't1',
      memberships: [M({ tenantId: 't1' })],
      platformRoles: [],
    })
    assert.deepEqual(d, { allow: true, mode: 'member' })
  })

  await check('decideSwitch: nem-tag, nem-superadmin ⇒ NOT_A_MEMBER', () => {
    const d = decideSwitch({ targetTenantId: 'tX', memberships: [M({ tenantId: 't1' })], platformRoles: [] })
    assert.deepEqual(d, { allow: false, reason: 'NOT_A_MEMBER' })
  })

  await check('decideSwitch: superadmin bármely tenantot assume módban', () => {
    const d = decideSwitch({ targetTenantId: 'tX', memberships: [], platformRoles: ['superadmin'] })
    assert.deepEqual(d, { allow: true, mode: 'assume' })
  })

  await check('decideSwitch: superadmin SAJÁT membershipjére member módban (nem assume)', () => {
    const d = decideSwitch({
      targetTenantId: 't1',
      memberships: [M({ tenantId: 't1' })],
      platformRoles: ['superadmin'],
    })
    assert.deepEqual(d, { allow: true, mode: 'member' })
  })

  await check('decideSwitch: suspended membership ⇒ MEMBERSHIP_NOT_ACTIVE (nem assume)', () => {
    const d = decideSwitch({
      targetTenantId: 't1',
      memberships: [M({ tenantId: 't1', status: 'suspended' })],
      platformRoles: [],
    })
    assert.deepEqual(d, { allow: false, reason: 'MEMBERSHIP_NOT_ACTIVE' })
  })

  // ── Utolsó tenant-admin lock (§7.2, §13/8) ───────────────────────────────
  await check('checkLastTenantAdminLock: utolsó active admin membership blokkolt', () => {
    assert.equal(checkLastTenantAdminLock({ otherActiveAdminCount: 0, targetIsActiveAdmin: true }).blocked, true)
  })

  await check('checkLastTenantAdminLock: van másik active admin ⇒ engedett', () => {
    assert.equal(checkLastTenantAdminLock({ otherActiveAdminCount: 1, targetIsActiveAdmin: true }).blocked, false)
  })

  await check('checkLastTenantAdminLock: nem-admin célpontra sosem blokkol', () => {
    assert.equal(checkLastTenantAdminLock({ otherActiveAdminCount: 0, targetIsActiveAdmin: false }).blocked, false)
  })

  // ── domain_allowlist + slug (§4.1, §7.1) ─────────────────────────────────
  await check('isTenantDomainAllowed: üres allowlist ⇒ minden engedett', () => {
    assert.equal(isTenantDomainAllowed('a@x.example', []), true)
  })

  await check('isTenantDomainAllowed: konfigurált allowlist szűr', () => {
    assert.equal(isTenantDomainAllowed('a@ok.example', ['ok.example']), true)
    assert.equal(isTenantDomainAllowed('a@evil.example', ['ok.example']), false)
  })

  await check('normalizeTenantSlug: ékezet/space/nagybetű normalizálás', () => {
    assert.equal(normalizeTenantSlug('  Ostoros Bor Kft  '), 'ostoros-bor-kft')
    assert.equal(normalizeTenantSlug('ACME__Inc'), 'acme-inc')
  })

  await check('isValidTenantSlug', () => {
    assert.equal(isValidTenantSlug('demo'), true)
    assert.equal(isValidTenantSlug('ostoros-bor'), true)
    assert.equal(isValidTenantSlug('-bad'), false)
    assert.equal(isValidTenantSlug('a'), false) // túl rövid (min 2)
  })

  console.log(`\n${failures === 0 ? 'Minden teszt zöld.' : `${failures} teszt bukott.`}`)
  if (failures > 0) process.exit(1)
}

main()
