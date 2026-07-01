/**
 * IAM / RBAC — tiszta logika negatív/invariáns tesztek
 * (Feature-spec IAM-RBAC §4, §6, §8; N-IAM-1…7).
 *
 * Futtatás: npx tsx scripts/iam-policy.test.ts
 *
 * Nincs DB-függőség — a `src/lib/iam-policy.ts` tiszta függvényeit teszteli
 * (agent-registry-lifecycle.test.ts mintájára). A DB-t is érintő IAM-folyamatokat
 * (invite/redeem/lock-out/tenant-izoláció/audit-lánc) a scripts/acceptance-e2e.ts
 * scenario9_iam fedi.
 */
import assert from 'node:assert/strict'
import {
  ROLE_RANK,
  meetsMinRole,
  hasMinimumRole,
  isActiveWithRole,
  checkLastAdminLock,
  isSelfModification,
  checkInvitationRedeemable,
  isEmailDomainAllowed,
  decideAuthz,
} from '../src/lib/iam-policy'

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

async function main() {
  // ── Szerep-rangsor ─────────────────────────────────────────────────────
  await check('rank sorrend: viewer < operator < approver < admin', () => {
    assert.ok(ROLE_RANK.viewer < ROLE_RANK.operator)
    assert.ok(ROLE_RANK.operator < ROLE_RANK.approver)
    assert.ok(ROLE_RANK.approver < ROLE_RANK.admin)
  })

  await check('meetsMinRole: NULL role soha nem elégséges (N-IAM-2)', () => {
    assert.equal(meetsMinRole(null, 'viewer'), false)
    assert.equal(meetsMinRole(undefined, 'viewer'), false)
  })

  await check('meetsMinRole: magasabb rang elégíti a alacsonyabb minimumot', () => {
    assert.equal(meetsMinRole('admin', 'viewer'), true)
    assert.equal(meetsMinRole('operator', 'approver'), false)
  })

  await check('hasMinimumRole: any-of lista, NULL role mindig false', () => {
    assert.equal(hasMinimumRole('operator', ['approver', 'admin']), false)
    assert.equal(hasMinimumRole('approver', ['approver', 'admin']), true)
    assert.equal(hasMinimumRole(null, ['viewer']), false)
  })

  // ── Kettős kapu (N-IAM-3) ────────────────────────────────────────────────
  await check('isActiveWithRole: pending/role=NULL nem aktív-jogosult', () => {
    assert.equal(isActiveWithRole({ status: 'pending', role: null }), false)
    assert.equal(isActiveWithRole({ status: 'active', role: null }), false)
    assert.equal(isActiveWithRole({ status: 'suspended', role: 'admin' }), false)
    assert.equal(isActiveWithRole({ status: 'active', role: 'viewer' }), true)
  })

  // ── Lock-out (N-IAM-5) ───────────────────────────────────────────────────
  await check('checkLastAdminLock: utolsó aktív admin blokkolt', () => {
    const result = checkLastAdminLock(0, true)
    assert.equal(result.blocked, true)
    if (result.blocked) assert.equal(result.reason, 'LAST_ADMIN_LOCK')
  })

  await check('checkLastAdminLock: van másik aktív admin ⇒ engedett', () => {
    assert.equal(checkLastAdminLock(1, true).blocked, false)
  })

  await check('checkLastAdminLock: nem-admin célpontra sosem blokkol', () => {
    assert.equal(checkLastAdminLock(0, false).blocked, false)
  })

  await check('isSelfModification: azonos id ⇒ true', () => {
    assert.equal(isSelfModification('u1', 'u1'), true)
    assert.equal(isSelfModification('u1', 'u2'), false)
  })

  // ── Meghívó-érvényesség (N-IAM-4) ────────────────────────────────────────
  const now = new Date('2026-01-01T12:00:00Z')
  const baseInvitation = {
    status: 'pending' as const,
    expiresAt: new Date('2026-01-08T12:00:00Z'),
    email: 'invitee@example.com',
  }

  await check('checkInvitationRedeemable: érvényes meghívó elfogadva', () => {
    const result = checkInvitationRedeemable(baseInvitation, { email: 'invitee@example.com', now })
    assert.equal(result.ok, true)
  })

  await check('checkInvitationRedeemable: már beváltott token elutasítva (replay, spec §9/4)', () => {
    const result = checkInvitationRedeemable(
      { ...baseInvitation, status: 'redeemed' },
      { email: 'invitee@example.com', now },
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'ALREADY_REDEEMED')
  })

  await check('checkInvitationRedeemable: visszavont meghívó elutasítva', () => {
    const result = checkInvitationRedeemable(
      { ...baseInvitation, status: 'revoked' },
      { email: 'invitee@example.com', now },
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'REVOKED')
  })

  await check('checkInvitationRedeemable: lejárt token elutasítva (spec §9/5)', () => {
    const result = checkInvitationRedeemable(baseInvitation, {
      email: 'invitee@example.com',
      now: new Date('2026-02-01T00:00:00Z'),
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'EXPIRED')
  })

  await check('checkInvitationRedeemable: expired-re jelölt token is elutasítva', () => {
    const result = checkInvitationRedeemable({ ...baseInvitation, status: 'expired' }, { email: 'invitee@example.com', now })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'EXPIRED')
  })

  await check('checkInvitationRedeemable: email-mismatch elutasítva (spec §9/6)', () => {
    const result = checkInvitationRedeemable(baseInvitation, { email: 'attacker@evil.example', now })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'EMAIL_MISMATCH')
  })

  await check('checkInvitationRedeemable: email-egyezés case-insensitive', () => {
    const result = checkInvitationRedeemable(baseInvitation, { email: 'INVITEE@EXAMPLE.COM', now })
    assert.equal(result.ok, true)
  })

  // ── Domain-allowlist (§7/B) ──────────────────────────────────────────────
  await check('isEmailDomainAllowed: üres allowlist ⇒ minden domain engedett', () => {
    assert.equal(isEmailDomainAllowed('a@anything.example', undefined), true)
    assert.equal(isEmailDomainAllowed('a@anything.example', ''), true)
  })

  await check('isEmailDomainAllowed: konfigurált allowlist szűr (spec §9/11)', () => {
    assert.equal(isEmailDomainAllowed('a@allowed.example', 'allowed.example,other.example'), true)
    assert.equal(isEmailDomainAllowed('a@evil.example', 'allowed.example,other.example'), false)
  })

  // ── Deny-by-default authz-döntés (N-IAM-2/3, spec §6 4-7. lépés) ────────
  await check('decideAuthz: inactive/pending/suspended ⇒ INACTIVE (spec §9/2,3)', () => {
    assert.deepEqual(decideAuthz({ status: 'pending', role: null }, 'admin'), {
      allow: false,
      reason: 'INACTIVE',
    })
    assert.deepEqual(decideAuthz({ status: 'suspended', role: 'admin' }, 'viewer'), {
      allow: false,
      reason: 'INACTIVE',
    })
  })

  await check('decideAuthz: active de role=NULL ⇒ NO_ROLE', () => {
    assert.deepEqual(decideAuthz({ status: 'active', role: null }, 'viewer'), {
      allow: false,
      reason: 'NO_ROLE',
    })
  })

  await check('decideAuthz: ismeretlen permission_key (minRole=null) ⇒ UNKNOWN_PERMISSION (spec §9/1)', () => {
    assert.deepEqual(decideAuthz({ status: 'active', role: 'admin' }, null), {
      allow: false,
      reason: 'UNKNOWN_PERMISSION',
    })
  })

  await check('decideAuthz: elégtelen szerep ⇒ INSUFFICIENT_ROLE (N-IAM-1: a DB-role dönt, nem egy claim)', () => {
    assert.deepEqual(decideAuthz({ status: 'active', role: 'viewer' }, 'admin'), {
      allow: false,
      reason: 'INSUFFICIENT_ROLE',
    })
  })

  await check('decideAuthz: minden feltétel teljesül ⇒ allow', () => {
    assert.deepEqual(decideAuthz({ status: 'active', role: 'admin' }, 'viewer'), { allow: true })
  })

  console.log(`\n${failures === 0 ? 'Minden teszt zöld.' : `${failures} teszt bukott.`}`)
  if (failures > 0) process.exit(1)
}

main()
