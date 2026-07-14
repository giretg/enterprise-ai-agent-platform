/**
 * Clerk invitation binding regression tests.
 *
 * These tests keep the security-critical acceptance rule DB-free: a signed
 * Clerk event may activate only its exact local invitation, never every
 * invitation that happens to share an e-mail address.
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
    clerkInvitationId: 'inv_clerk_a',
    email: 'person@example.com',
    role: 'operator',
    tokenHash: 'hash',
    status: 'pending',
    expiresAt: new Date(now.getTime() + 60_000),
    redeemedAt: null,
    revokedAt: null,
    createdById: 'admin-a',
    createdAt: now,
    ...overrides,
  }) as never

const user = {
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

function fixture(initialInvitation = invitation()) {
  let currentInvitation = initialInvitation as { status: string; redeemedAt: Date | null }
  const membershipCalls: unknown[] = []
  const auditEvents: unknown[] = []
  const service = new IamService(
    {
      async update(_id: string, update: Record<string, unknown>) {
        return { ...user, ...update }
      },
    } as never,
    {
      async findById() {
        return currentInvitation
      },
      async claimPendingRedemption(_id: string, _email: string, redeemedAt: Date) {
        if (currentInvitation.status !== 'pending') return null
        currentInvitation = { ...currentInvitation, status: 'redeemed', redeemedAt }
        return currentInvitation as never
      },
      async update(_id: string, update: { status?: string; redeemedAt?: Date }) {
        currentInvitation = { ...currentInvitation, ...update }
        return currentInvitation as never
      },
    } as never,
    {} as never,
    {
      async append(event: unknown) {
        auditEvents.push(event)
        return event as never
      },
    } as never,
    undefined,
    {
      async upsert(input: unknown) {
        membershipCalls.push(input)
        return { id: 'membership-a' } as never
      },
    } as never,
  )
  return { service, membershipCalls, auditEvents, getInvitation: () => currentInvitation }
}

async function main() {
  await check('exact Clerk binding activates one tenant membership and writes tenant audit', async () => {
    const { service, membershipCalls, auditEvents, getInvitation } = fixture()
    await service.redeemClerkInvitation({ invitationId: 'invite-a', user })

    assert.deepEqual(membershipCalls, [
      {
        tenantId: 'tenant-a',
        userId: 'user-a',
        role: 'operator',
        status: 'active',
        invitedById: 'admin-a',
      },
    ])
    assert.equal(getInvitation().status, 'redeemed')
    assert.equal(auditEvents.length, 2)
    assert.equal((auditEvents[0] as { tenantId?: string }).tenantId, 'tenant-a')
    assert.equal((auditEvents[1] as { action?: string }).action, 'user.invite.redeem')
  })

  await check('duplicate signed delivery is a no-op', async () => {
    const { service, membershipCalls, auditEvents } = fixture()
    await service.redeemClerkInvitation({ invitationId: 'invite-a', user })
    await service.redeemClerkInvitation({ invitationId: 'invite-a', user })
    assert.equal(membershipCalls.length, 1)
    assert.equal(auditEvents.length, 2)
  })

  await check('mismatched verified e-mail cannot claim the local invitation', async () => {
    const { service, membershipCalls, auditEvents, getInvitation } = fixture()
    await assert.rejects(() =>
      service.redeemClerkInvitation({ invitationId: 'invite-a', user: { ...user, email: 'other@example.com' } }),
    )
    assert.equal(getInvitation().status, 'pending')
    assert.equal(membershipCalls.length, 0)
    assert.equal(auditEvents.length, 0)
  })

  await check('expired invitation never activates a tenant membership', async () => {
    const { service, membershipCalls, auditEvents, getInvitation } = fixture(
      invitation({ expiresAt: new Date(now.getTime() - 60_000) }),
    )
    await assert.rejects(() => service.redeemClerkInvitation({ invitationId: 'invite-a', user }))
    assert.equal(getInvitation().status, 'expired')
    assert.equal(membershipCalls.length, 0)
    assert.equal(auditEvents.length, 0)
  })

  console.log(`\n${failures === 0 ? 'Minden teszt zöld.' : `${failures} teszt bukott.`}`)
  if (failures > 0) process.exit(1)
}

main()
