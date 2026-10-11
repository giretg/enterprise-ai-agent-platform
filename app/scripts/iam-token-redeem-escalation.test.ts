/**
 * Token-based invitation redeem (`/control-plane/iam/redeem`) regression tests.
 *
 * The Clerk/session redeem path (#838) refuses to overwrite an active tenant
 * membership role and keeps the global `User.role` raise-only. The token path
 * (`IamService.redeemInvitation`) is a separate entry point that #838 does not
 * touch; these tests pin the same two invariants for it:
 *   1. A stale higher-role invite must not escalate an already-active membership.
 *   2. Redeeming an invite must never DEMOTE the global `User.role`.
 */
import assert from 'node:assert/strict'
import type { User } from '@prisma/client'
import { IamService } from '../src/domain/iam/iam-service'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.error(`  FAIL ${name}:`, error)
  }
}

const now = new Date()

const invitation = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'invite-a',
    tenantId: 'tenant-a',
    clerkInvitationId: null,
    email: 'person@example.com',
    role: 'admin',
    tokenHash: 'hash',
    status: 'pending',
    expiresAt: new Date(now.getTime() + 60_000),
    redeemedAt: null,
    revokedAt: null,
    createdById: 'admin-a',
    createdAt: now,
    ...overrides,
  }) as never

const baseUser = {
  id: 'user-a',
  externalAuthId: 'user_clerk_a',
  email: 'person@example.com',
  name: 'Person',
  role: null,
  status: 'pending',
  tenantId: null,
  invitedById: null,
  activatedAt: null,
  suspendedAt: null,
  suspendedById: null,
  suspendedReason: null,
  createdAt: now,
  updatedAt: now,
} as unknown as User

function fixture(opts: {
  invitation?: ReturnType<typeof invitation>
  existingUser?: User | null
  membership?: { status: string; role: string } | null
  // Simulates a TOCTOU race: no membership on the pre-claim check, but an active
  // one appears by the post-claim check (e.g. a concurrent provision).
  appearsAfterClaim?: { status: string; role: string } | null
}) {
  let currentInvitation = (opts.invitation ?? invitation()) as { id: string; status: string; tenantId: string | null; redeemedAt: Date | null }
  const existingUser = opts.existingUser ?? null
  let currentUser: User | null = existingUser ? { ...existingUser } : null
  let membership = opts.membership
    ? { id: 'membership-a', tenantId: 'tenant-a', userId: 'user-a', ...opts.membership }
    : null
  let membershipLookups = 0
  const userUpdates: Record<string, unknown>[] = []
  const membershipUpserts: { role: string; status: string }[] = []
  const auditEvents: { policyDecision?: string }[] = []

  const service = new IamService(
    {
      async findByExternalAuthId() {
        return existingUser
      },
      async upsertByExternalAuthId(input: {
        create: Record<string, unknown>
        update: Record<string, unknown>
      }) {
        if (currentUser) {
          userUpdates.push(input.update)
          currentUser = { ...currentUser, ...input.update }
        } else {
          currentUser = { id: 'user-a', ...input.create } as unknown as User
        }
        return currentUser
      },
      async update(_id: string, update: Record<string, unknown>) {
        userUpdates.push(update)
        currentUser = { ...(currentUser as User), ...update }
        return currentUser
      },
    } as never,
    {
      async findByTokenHash() {
        return currentInvitation
      },
      async claimPendingRedemption(_id: string, _email: string, redeemedAt: Date) {
        if (currentInvitation.status !== 'pending') return null
        currentInvitation = { ...currentInvitation, status: 'redeemed', redeemedAt }
        return currentInvitation as never
      },
      async update(_id: string, update: Record<string, unknown>) {
        currentInvitation = { ...currentInvitation, ...update }
        return currentInvitation as never
      },
    } as never,
    {} as never,
    undefined,
    {
      async findByTenantAndUser() {
        membershipLookups += 1
        // First lookup = pre-claim guard; a race membership only shows up afterwards.
        if (opts.appearsAfterClaim && membershipLookups >= 2) {
          return { id: 'membership-a', tenantId: 'tenant-a', userId: 'user-a', ...opts.appearsAfterClaim } as never
        }
        return membership as never
      },
      async upsert(input: { role: string; status: string }) {
        membershipUpserts.push(input)
        membership = { id: 'membership-a', tenantId: 'tenant-a', userId: 'user-a', role: input.role, status: input.status }
        return membership as never
      },
    } as never,
    {
      async append(event: { policyDecision?: string }) {
        auditEvents.push(event)
        return event as never
      },
    } as never,
  )

  return {
    service,
    userUpdates,
    membershipUpserts,
    auditEvents,
    getInvitation: () => currentInvitation,
    getUser: () => currentUser,
    getMembership: () => membership,
  }
}

// hashOpaqueToken treats the raw token as hex, so use a valid hex string.
const redeem = { token: 'abcdef0123456789', email: 'person@example.com', externalAuthId: 'user_clerk_a' }

async function main() {
  await check('active operator cannot token-redeem a stale admin invite to escalate membership', async () => {
    const existingUser = { ...baseUser, role: 'operator', status: 'active', activatedAt: now } as unknown as User
    const f = fixture({
      invitation: invitation({ role: 'admin' }),
      existingUser,
      membership: { status: 'active', role: 'operator' },
    })
    await assert.rejects(() => f.service.redeemInvitation(redeem), /already_a_member/)
    assert.equal(f.getInvitation().status, 'pending', 'invite stays pending (claim never happened)')
    assert.equal(f.membershipUpserts.length, 0, 'membership not touched')
    assert.equal(f.userUpdates.length, 0, 'user not touched')
    assert.equal(f.getMembership()?.role, 'operator')
  })

  await check('token redeem of a lower-role invite must not DEMOTE the global User.role', async () => {
    // Cross-tenant: user is a global admin (active in another tenant), redeems a
    // viewer invite to this tenant where they have no membership yet.
    const existingUser = { ...baseUser, role: 'admin', status: 'active', activatedAt: now } as unknown as User
    const f = fixture({
      invitation: invitation({ role: 'viewer' }),
      existingUser,
      membership: null,
    })
    await f.service.redeemInvitation(redeem)
    assert.equal(f.getUser()?.role, 'admin', 'global role preserved (raise-only, never demoted)')
    assert.equal(f.getMembership()?.role, 'viewer', 'new-tenant membership gets the invited role')
    assert.equal(f.getMembership()?.status, 'active')
    assert.equal(f.getInvitation().status, 'redeemed')
  })

  await check('suspended membership is still reactivated by a token redeem', async () => {
    const existingUser = { ...baseUser, role: 'operator', status: 'active', activatedAt: now } as unknown as User
    const f = fixture({
      invitation: invitation({ role: 'admin' }),
      existingUser,
      membership: { status: 'suspended', role: 'operator' },
    })
    await f.service.redeemInvitation(redeem)
    assert.equal(f.getMembership()?.status, 'active', 'suspended membership reactivated')
    assert.equal(f.getMembership()?.role, 'admin')
    assert.equal(f.getInvitation().status, 'redeemed')
  })

  await check('post-claim race: active membership appearing after claim must not escalate', async () => {
    const existingUser = { ...baseUser, role: 'operator', status: 'active', activatedAt: now } as unknown as User
    const f = fixture({
      invitation: invitation({ role: 'admin' }),
      existingUser,
      membership: null, // pre-claim: no membership → pre-claim guard passes, claim proceeds
      appearsAfterClaim: { status: 'active', role: 'operator' }, // provision landed mid-redeem
    })
    await f.service.redeemInvitation(redeem)
    assert.equal(f.getInvitation().status, 'redeemed', 'claim happened')
    assert.equal(f.membershipUpserts.length, 0, 'membership role not overwritten by the race')
    assert.equal(f.getUser()?.role, 'operator', 'global role not escalated by the race')
    assert.equal(
      f.auditEvents.some((e) => e.policyDecision === 'already_a_member'),
      true,
      'post-claim guard audited the refusal',
    )
  })

  await check('brand-new user token redeem activates with the invited role', async () => {
    const f = fixture({ invitation: invitation({ role: 'operator' }), existingUser: null, membership: null })
    await f.service.redeemInvitation(redeem)
    assert.equal(f.getUser()?.role, 'operator')
    assert.equal(f.getMembership()?.role, 'operator')
    assert.equal(f.getMembership()?.status, 'active')
  })

  console.log(`\n${failures === 0 ? 'Minden teszt zöld.' : `${failures} teszt bukott.`}`)
  if (failures > 0) process.exit(1)
}

void main()
