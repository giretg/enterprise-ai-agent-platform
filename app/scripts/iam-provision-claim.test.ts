/**
 * Pre-provisionált user (csendes előkészítés) + első login claim.
 *
 * Futtatás: npx tsx scripts/iam-provision-claim.test.ts
 *
 * DB nélkül: in-memory User + TenantMembership mockokkal ellenőrzi
 * provisionUser / claimPreProvisionedUser / email conflict szabályokat.
 * A syncClerkUser email-ág a claimPreProvisionedUser-t hívja — azt itt fedjük.
 */
import assert from 'node:assert/strict'
import type { User } from '@prisma/client'
import { IamService } from '../src/domain/iam/iam-service'
import {
  isPreProvisionedAuthId,
  makePreProvisionedAuthId,
  PREPROVISIONED_AUTH_PREFIX,
} from '../src/lib/iam-policy'

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

type StoredUser = User & { externalAuthId: string }
type StoredMembership = {
  id: string
  tenantId: string
  userId: string
  role: string
  status: string
  invitedById: string | null
  activatedAt: Date | null
}

function fixture(seedUsers: StoredUser[] = []) {
  const users = [...seedUsers]
  const memberships: StoredMembership[] = []
  const auditEvents: Array<{ action: string; policyDecision?: string | null }> = []
  let userSeq = 0
  let membershipSeq = 0

  const service = new IamService(
    {
      async findManyByEmail(email: string) {
        const needle = email.trim().toLowerCase()
        return users.filter((u) => u.email.toLowerCase() === needle)
      },
      async findByExternalAuthId(externalAuthId: string) {
        return users.find((u) => u.externalAuthId === externalAuthId) ?? null
      },
      async create(data: {
        externalAuthId: string
        email: string
        name: string
        role?: string | null
        status?: string
        tenantId?: string | null
        invitedById?: string | null
      }) {
        const created = {
          id: `user-${++userSeq}`,
          externalAuthId: data.externalAuthId,
          email: data.email,
          name: data.name,
          role: data.role ?? null,
          status: data.status ?? 'pending',
          tenantId: data.tenantId ?? null,
          invitedById: data.invitedById ?? null,
          jobDescription: null,
          activatedAt: null,
          suspendedAt: null,
          suspendedById: null,
          suspendedReason: null,
          lastLoginAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as StoredUser
        users.push(created)
        return created
      },
      async update(id: string, data: Record<string, unknown>) {
        const idx = users.findIndex((u) => u.id === id)
        assert.ok(idx >= 0, `user ${id} missing`)
        users[idx] = { ...users[idx], ...data, updatedAt: new Date() } as StoredUser
        return users[idx]
      },
    } as never,
    {} as never,
    {} as never,
    {
      async append(event: { action: string; policyDecision?: string | null }) {
        auditEvents.push(event)
        return event as never
      },
    } as never,
    undefined,
    {
      async findByTenantAndUser(tenantId: string, userId: string) {
        return memberships.find((m) => m.tenantId === tenantId && m.userId === userId) ?? null
      },
      async findByUser(userId: string) {
        return memberships.filter((m) => m.userId === userId)
      },
      async create(data: {
        tenantId: string
        userId: string
        role: string
        status?: string
        invitedById?: string | null
      }) {
        const created: StoredMembership = {
          id: `membership-${++membershipSeq}`,
          tenantId: data.tenantId,
          userId: data.userId,
          role: data.role,
          status: data.status ?? 'pending',
          invitedById: data.invitedById ?? null,
          activatedAt: null,
        }
        memberships.push(created)
        return created as never
      },
      async update(id: string, data: Partial<StoredMembership>) {
        const idx = memberships.findIndex((m) => m.id === id)
        assert.ok(idx >= 0)
        memberships[idx] = { ...memberships[idx], ...data }
        return memberships[idx] as never
      },
    } as never,
  )

  return {
    service,
    auditEvents,
    getUsers: () => users,
    getMemberships: () => memberships,
  }
}

async function main() {
  await check('preprovisioned auth id prefix helpers', () => {
    const id = makePreProvisionedAuthId()
    assert.ok(id.startsWith(PREPROVISIONED_AUTH_PREFIX))
    assert.equal(isPreProvisionedAuthId(id), true)
    assert.equal(isPreProvisionedAuthId('user_clerk_abc'), false)
  })

  await check('provisionUser creates pending user + pending membership', async () => {
    const { service, auditEvents, getUsers, getMemberships } = fixture()
    const result = await service.provisionUser({
      email: '  New.Colleague@Example.com ',
      role: 'operator',
      createdById: 'admin-1',
      tenantId: 'tenant-a',
    })

    assert.equal(result.user.email, 'new.colleague@example.com')
    assert.equal(result.user.role, 'operator')
    assert.equal(result.user.status, 'pending')
    assert.ok(isPreProvisionedAuthId(result.user.externalAuthId))
    assert.equal(result.membership.status, 'pending')
    assert.equal(result.membership.role, 'operator')
    assert.equal(getUsers().length, 1)
    assert.equal(getMemberships().length, 1)
    assert.equal(auditEvents.some((e) => e.action === 'user.provision.create'), true)
  })

  await check('claimPreProvisionedUser activates user + memberships and links Clerk id', async () => {
    const { service, auditEvents, getUsers, getMemberships } = fixture()
    const { user } = await service.provisionUser({
      email: 'claim.me@example.com',
      role: 'approver',
      createdById: 'admin-1',
      tenantId: 'tenant-a',
    })

    const claimed = await service.claimPreProvisionedUser({
      user,
      externalAuthId: 'user_clerk_claim_me',
      name: 'Claim Me',
    })

    assert.equal(claimed.externalAuthId, 'user_clerk_claim_me')
    assert.equal(claimed.status, 'active')
    assert.equal(claimed.name, 'Claim Me')
    assert.equal(claimed.role, 'approver')
    assert.equal(isPreProvisionedAuthId(claimed.externalAuthId), false)
    assert.equal(getMemberships()[0]?.status, 'active')
    assert.ok(getMemberships()[0]?.activatedAt)
    assert.equal(getUsers()[0]?.status, 'active')
    assert.equal(auditEvents.some((e) => e.action === 'user.provision.claim'), true)
  })

  await check('claim is no-op for already-linked (non-preprovisioned) users', async () => {
    const linked = {
      id: 'user-linked',
      externalAuthId: 'user_clerk_linked',
      email: 'linked@example.com',
      name: 'Linked',
      role: 'viewer',
      status: 'active',
      tenantId: 'tenant-a',
      invitedById: null,
      jobDescription: null,
      activatedAt: new Date(),
      suspendedAt: null,
      suspendedById: null,
      suspendedReason: null,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as StoredUser
    const { service, auditEvents } = fixture([linked])
    const result = await service.claimPreProvisionedUser({
      user: linked,
      externalAuthId: 'user_clerk_other',
      name: 'Nope',
    })
    assert.equal(result.externalAuthId, 'user_clerk_linked')
    assert.equal(auditEvents.length, 0)
  })

  await check('provisionUser activates pending Clerk-linked user + active membership', async () => {
    const existing = {
      id: 'user-self-reg',
      externalAuthId: 'user_clerk_self_reg',
      email: 'selfreg@example.com',
      name: 'Self Reg',
      role: null,
      status: 'pending',
      tenantId: null,
      invitedById: null,
      jobDescription: null,
      activatedAt: null,
      suspendedAt: null,
      suspendedById: null,
      suspendedReason: null,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as StoredUser
    const { service, getUsers, getMemberships } = fixture([existing])
    const result = await service.provisionUser({
      email: 'selfreg@example.com',
      role: 'operator',
      createdById: 'admin-1',
      tenantId: 'tenant-a',
    })

    assert.equal(getUsers().length, 1)
    assert.equal(result.user.status, 'active')
    assert.equal(result.user.role, 'operator')
    assert.equal(result.membership.status, 'active')
    assert.equal(getMemberships().length, 1)
  })

  await check('activateProvisionedUser activates pending user with role on login', async () => {
    const stuck = {
      id: 'user-stuck',
      externalAuthId: 'user_clerk_stuck',
      email: 'stuck@example.com',
      name: 'Stuck',
      role: 'operator',
      status: 'pending',
      tenantId: 'tenant-a',
      invitedById: 'admin-1',
      jobDescription: null,
      activatedAt: null,
      suspendedAt: null,
      suspendedById: null,
      suspendedReason: null,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as StoredUser
    const { service, auditEvents, getUsers, getMemberships } = fixture([stuck])
    getMemberships().push({
      id: 'membership-stuck',
      tenantId: 'tenant-a',
      userId: 'user-stuck',
      role: 'operator',
      status: 'pending',
      invitedById: 'admin-1',
      activatedAt: null,
    })

    const activated = await service.activateProvisionedUser({
      user: stuck,
      name: 'Stuck User',
    })

    assert.equal(activated.status, 'active')
    assert.equal(activated.name, 'Stuck User')
    assert.equal(getMemberships()[0]?.status, 'active')
    assert.equal(auditEvents.some((e) => e.action === 'user.provision.claim'), true)
  })

  await check('provisionUser adds active membership when user already active in another tenant', async () => {
    const existing = {
      id: 'user-existing',
      externalAuthId: 'user_clerk_existing',
      email: 'taken@example.com',
      name: 'Taken',
      role: 'viewer',
      status: 'active',
      tenantId: 'tenant-a',
      invitedById: null,
      jobDescription: null,
      activatedAt: new Date(),
      suspendedAt: null,
      suspendedById: null,
      suspendedReason: null,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as StoredUser
    const { service, getUsers, getMemberships } = fixture([existing])
    const result = await service.provisionUser({
      email: 'taken@example.com',
      role: 'operator',
      createdById: 'admin-1',
      tenantId: 'tenant-b',
    })

    assert.equal(getUsers().length, 1)
    assert.equal(result.user.id, 'user-existing')
    assert.equal(result.membership.tenantId, 'tenant-b')
    assert.equal(result.membership.role, 'operator')
    assert.equal(result.membership.status, 'active')
    assert.equal(getMemberships().length, 1)
  })

  await check('provisionUser rejects duplicate provision for same tenant (active user)', async () => {
    const existing = {
      id: 'user-existing',
      externalAuthId: 'user_clerk_existing',
      email: 'taken@example.com',
      name: 'Taken',
      role: 'viewer',
      status: 'active',
      tenantId: 'tenant-a',
      invitedById: null,
      jobDescription: null,
      activatedAt: new Date(),
      suspendedAt: null,
      suspendedById: null,
      suspendedReason: null,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as StoredUser
    const { service } = fixture([existing])
    await service.provisionUser({
      email: 'taken@example.com',
      role: 'operator',
      createdById: 'admin-1',
      tenantId: 'tenant-a',
    })
    await assert.rejects(
      () =>
        service.provisionUser({
          email: 'taken@example.com',
          role: 'admin',
          createdById: 'admin-1',
          tenantId: 'tenant-a',
        }),
      /already provisioned for this tenant/,
    )
  })

  await check('provisionUser rejects duplicate pending provision for same tenant', async () => {
    const { service } = fixture()
    await service.provisionUser({
      email: 'dup@example.com',
      role: 'operator',
      createdById: 'admin-1',
      tenantId: 'tenant-a',
    })
    await assert.rejects(
      () =>
        service.provisionUser({
          email: 'dup@example.com',
          role: 'admin',
          createdById: 'admin-1',
          tenantId: 'tenant-a',
        }),
      /already provisioned for this tenant/,
    )
  })

  await check('re-provision to another tenant elevates global role, never demotes', async () => {
    const { service, getUsers, getMemberships } = fixture()
    await service.provisionUser({
      email: 'multi@example.com',
      role: 'approver',
      createdById: 'admin-1',
      tenantId: 'tenant-a',
    })
    await service.provisionUser({
      email: 'multi@example.com',
      role: 'viewer',
      createdById: 'admin-2',
      tenantId: 'tenant-b',
    })
    assert.equal(getUsers()[0]?.role, 'approver')
    assert.equal(getMemberships().length, 2)
    assert.equal(getMemberships()[1]?.role, 'viewer')

    await service.provisionUser({
      email: 'multi@example.com',
      role: 'admin',
      createdById: 'admin-3',
      tenantId: 'tenant-c',
    })
    assert.equal(getUsers()[0]?.role, 'admin')
    assert.equal(getMemberships().length, 3)
  })

  await check('self-reg style pending (role=null) is unchanged by claim helpers', async () => {
    const selfReg = {
      id: 'user-self',
      externalAuthId: 'user_clerk_self',
      email: 'self@example.com',
      name: 'Self',
      role: null,
      status: 'pending',
      tenantId: null,
      invitedById: null,
      jobDescription: null,
      activatedAt: null,
      suspendedAt: null,
      suspendedById: null,
      suspendedReason: null,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as StoredUser
    const { service } = fixture([selfReg])
    const result = await service.claimPreProvisionedUser({
      user: selfReg,
      externalAuthId: 'user_clerk_self',
      name: 'Self Updated',
    })
    assert.equal(result.status, 'pending')
    assert.equal(result.role, null)
    assert.equal(result.externalAuthId, 'user_clerk_self')
  })

  console.log(`\n${failures === 0 ? 'Minden teszt zöld.' : `${failures} teszt bukott.`}`)
  if (failures > 0) process.exit(1)
}

main()
