/**
 * IAM lista / cél-műveletek membership-scope regresszió.
 *
 * Futtatás: npx tsx scripts/iam-membership-scope.test.ts
 *
 * A belépés membership-alapú, a Felhasználók lista eddig User.tenantId-re szűrt —
 * ez a teszt azt rögzíti, hogy membership-only tagok is megjelennek, és a
 * role/suspend a tagságon érvényesül.
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

type StoredUser = User
type StoredMembership = {
  id: string
  tenantId: string
  userId: string
  role: 'viewer' | 'operator' | 'approver' | 'admin'
  status: 'pending' | 'active' | 'suspended'
  invitedById: string | null
  activatedAt: Date | null
}

function fixture(seedUsers: StoredUser[] = [], seedMemberships: StoredMembership[] = []) {
  const users = [...seedUsers]
  const memberships = [...seedMemberships]
  let membershipSeq = seedMemberships.length

  const service = new IamService(
    {
      async findById(id: string) {
        return users.find((u) => u.id === id) ?? null
      },
      async findManyByIds(ids: string[]) {
        const set = new Set(ids)
        return users.filter((u) => set.has(u.id))
      },
      async findMany(filter?: { tenantId?: string | null }) {
        return users.filter((u) =>
          filter?.tenantId !== undefined ? u.tenantId === filter.tenantId : true,
        )
      },
      async countActiveAdmins(tenantId: string | null, excludeUserId?: string) {
        return users.filter(
          (u) =>
            u.tenantId === tenantId &&
            u.role === 'admin' &&
            u.status === 'active' &&
            u.id !== excludeUserId,
        ).length
      },
      async update(id: string, data: Record<string, unknown>) {
        const idx = users.findIndex((u) => u.id === id)
        assert.ok(idx >= 0)
        users[idx] = { ...users[idx], ...data, updatedAt: new Date() } as StoredUser
        return users[idx]
      },
    } as never,
    {} as never,
    {} as never,
    undefined,
    {
      async findByTenantAndUser(tenantId: string, userId: string) {
        return memberships.find((m) => m.tenantId === tenantId && m.userId === userId) ?? null
      },
      async findByUser(userId: string) {
        return memberships.filter((m) => m.userId === userId)
      },
      async findByTenant(tenantId: string) {
        return memberships.filter((m) => m.tenantId === tenantId)
      },
      async countActiveAdmins(tenantId: string, excludeUserId?: string) {
        return memberships.filter(
          (m) =>
            m.tenantId === tenantId &&
            m.role === 'admin' &&
            m.status === 'active' &&
            m.userId !== excludeUserId,
        ).length
      },
      async update(id: string, data: Partial<StoredMembership>) {
        const idx = memberships.findIndex((m) => m.id === id)
        assert.ok(idx >= 0)
        memberships[idx] = { ...memberships[idx], ...data }
        return memberships[idx] as never
      },
      async create(data: {
        tenantId: string
        userId: string
        role: StoredMembership['role']
        status?: StoredMembership['status']
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
    } as never,
  )

  return {
    service,
    getUsers: () => users,
    getMemberships: () => memberships,
  }
}

function makeUser(partial: Partial<StoredUser> & Pick<StoredUser, 'id' | 'email'>): StoredUser {
  return {
    externalAuthId: `auth-${partial.id}`,
    name: partial.email,
    role: 'operator',
    status: 'active',
    tenantId: null,
    invitedById: null,
    jobDescription: null,
    activatedAt: new Date(),
    suspendedAt: null,
    suspendedById: null,
    suspendedReason: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as StoredUser
}

async function main() {
  await check('listUsers returns membership members even when User.tenantId is null', async () => {
    const colleague = makeUser({
      id: 'user-colleague',
      email: 'kollega@ceg.hu',
      role: 'operator',
      status: 'active',
      tenantId: null,
    })
    const { service } = fixture(
      [colleague],
      [
        {
          id: 'm-1',
          tenantId: 'tenant-a',
          userId: 'user-colleague',
          role: 'operator',
          status: 'active',
          invitedById: 'admin-1',
          activatedAt: new Date(),
        },
      ],
    )

    const listed = await service.listUsers('tenant-a')
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.id, 'user-colleague')
    assert.equal(listed[0]?.role, 'operator')
    assert.equal(listed[0]?.status, 'active')
  })

  await check('listUsers overlays membership role/status over legacy User fields', async () => {
    const user = makeUser({
      id: 'user-multi',
      email: 'multi@ceg.hu',
      role: 'admin',
      status: 'active',
      tenantId: 'tenant-other',
    })
    const { service } = fixture(
      [user],
      [
        {
          id: 'm-b',
          tenantId: 'tenant-b',
          userId: 'user-multi',
          role: 'viewer',
          status: 'pending',
          invitedById: null,
          activatedAt: null,
        },
      ],
    )

    const listed = await service.listUsers('tenant-b')
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.role, 'viewer')
    assert.equal(listed[0]?.status, 'pending')
  })

  await check('changeRole updates membership role without mutating global User.role', async () => {
    const user = makeUser({
      id: 'user-op',
      email: 'op@ceg.hu',
      tenantId: null,
      role: 'viewer',
    })
    const { service, getMemberships, getUsers } = fixture(
      [user],
      [
        {
          id: 'm-op',
          tenantId: 'tenant-a',
          userId: 'user-op',
          role: 'operator',
          status: 'active',
          invitedById: null,
          activatedAt: new Date(),
        },
      ],
    )

    const updated = await service.changeRole({
      targetUserId: 'user-op',
      newRole: 'approver',
      actorId: 'admin-1',
      actorTenantId: 'tenant-a',
    })

    assert.equal(updated.role, 'approver')
    assert.equal(getMemberships()[0]?.role, 'approver')
    // Multi-tenant: a legacy User.role érintetlen marad.
    assert.equal(getUsers()[0]?.role, 'viewer')
  })

  await check('suspendUser suspends membership without requiring User.tenantId', async () => {
    const user = makeUser({
      id: 'user-suspend',
      email: 'suspend@ceg.hu',
      tenantId: null,
    })
    const { service, getMemberships, getUsers } = fixture(
      [user],
      [
        {
          id: 'm-suspend',
          tenantId: 'tenant-a',
          userId: 'user-suspend',
          role: 'operator',
          status: 'active',
          invitedById: null,
          activatedAt: new Date(),
        },
      ],
    )

    const updated = await service.suspendUser({
      targetUserId: 'user-suspend',
      reason: 'teszt',
      actorId: 'admin-1',
      actorTenantId: 'tenant-a',
    })

    assert.equal(updated.status, 'suspended')
    assert.equal(getMemberships()[0]?.status, 'suspended')
    assert.equal(getUsers()[0]?.status, 'suspended')
  })

  await check('suspend+reactivate keeps User.active when another membership stays active', async () => {
    const user = makeUser({
      id: 'user-multi',
      email: 'multi2@ceg.hu',
      tenantId: null,
      status: 'active',
    })
    const { service, getMemberships, getUsers } = fixture(
      [user],
      [
        {
          id: 'm-a',
          tenantId: 'tenant-a',
          userId: 'user-multi',
          role: 'operator',
          status: 'active',
          invitedById: null,
          activatedAt: new Date(),
        },
        {
          id: 'm-b',
          tenantId: 'tenant-b',
          userId: 'user-multi',
          role: 'viewer',
          status: 'active',
          invitedById: null,
          activatedAt: new Date(),
        },
      ],
    )

    const suspended = await service.suspendUser({
      targetUserId: 'user-multi',
      reason: 'tenant-a off',
      actorId: 'admin-1',
      actorTenantId: 'tenant-a',
    })
    assert.equal(suspended.status, 'suspended')
    assert.equal(getMemberships().find((m) => m.id === 'm-a')?.status, 'suspended')
    assert.equal(getMemberships().find((m) => m.id === 'm-b')?.status, 'active')
    assert.equal(getUsers()[0]?.status, 'active')

    const reactivated = await service.reactivateUser({
      targetUserId: 'user-multi',
      actorId: 'admin-1',
      actorTenantId: 'tenant-a',
    })
    assert.equal(reactivated.status, 'active')
    assert.equal(getMemberships().find((m) => m.id === 'm-a')?.status, 'active')
    assert.equal(getUsers()[0]?.status, 'active')
  })

  await check('loadTenantScopedTarget rejects users without membership in actor tenant', async () => {
    const outsider = makeUser({
      id: 'user-out',
      email: 'out@ceg.hu',
      tenantId: 'tenant-other',
    })
    const { service } = fixture([outsider], [])

    await assert.rejects(
      () =>
        service.changeRole({
          targetUserId: 'user-out',
          newRole: 'admin',
          actorId: 'admin-1',
          actorTenantId: 'tenant-a',
        }),
      /user: not found/,
    )
  })

  console.log(`\n${failures === 0 ? 'Minden teszt zöld.' : `${failures} teszt bukott.`}`)
  if (failures > 0) process.exit(1)
}

main()
