/**
 * Platform self-registration approval (#invite-only): CAS + auth status gate.
 *
 * Futtatás: npm run test:platform-registration-approve
 *
 * A korábbi sorrend (aktív membership → user activate) fail-open volt: a pending
 * user tenant-kindet kapott, amíg / ha a user update meghiúsult. A párhuzamos
 * jóváhagyás pedig két tenanthoz köthette ugyanazt a pending sort.
 */
import assert from 'node:assert/strict'
import type { User, UserRole } from '@prisma/client'
import { applyUserStatusGate, type AuthContext } from '../src/auth/context'
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
  role: UserRole
  status: string
  isDefault: boolean
  invitedById: string | null
}

function fixture(seed?: StoredUser) {
  const users: StoredUser[] = seed
    ? [seed]
    : [
        {
          id: 'pending-1',
          externalAuthId: 'clerk_pending_1',
          email: 'new@example.com',
          name: 'New User',
          role: null,
          status: 'pending',
          invitedById: null,
          jobDescription: null,
          activatedAt: null,
          suspendedAt: null,
          suspendedById: null,
          suspendedReason: null,
          lastLoginAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as StoredUser,
      ]
  const memberships: StoredMembership[] = []
  const auditEvents: Array<{ action: string }> = []
  let membershipSeq = 0
  let activateCalls = 0

  const service = new IamService(
    {
      async findById(id: string) {
        return users.find((u) => u.id === id) ?? null
      },
      async activatePendingPlatformRegistration(
        id: string,
        data: { role: UserRole; activatedAt: Date; invitedById: string },
      ) {
        activateCalls++
        const idx = users.findIndex((u) => u.id === id)
        if (idx < 0) return null
        const current = users[idx]
        if (current.status !== 'pending' || current.role !== null) return null
        users[idx] = {
          ...current,
          role: data.role,
          status: 'active',
          activatedAt: data.activatedAt,
          invitedById: data.invitedById,
          updatedAt: new Date(),
        } as StoredUser
        return users[idx]
      },
      async update() {
        throw new Error('update must not be used for platform registration activate')
      },
    } as never,
    {} as never,
    {} as never,
    undefined,
    {
      async upsert(data: {
        tenantId: string
        userId: string
        role: UserRole
        status?: string
        isDefault?: boolean
        invitedById?: string | null
      }) {
        const existing = memberships.find(
          (m) => m.tenantId === data.tenantId && m.userId === data.userId,
        )
        if (existing) {
          Object.assign(existing, {
            role: data.role,
            status: data.status ?? 'pending',
            isDefault: data.isDefault ?? false,
            invitedById: data.invitedById ?? null,
          })
          return existing as never
        }
        const created: StoredMembership = {
          id: `membership-${++membershipSeq}`,
          tenantId: data.tenantId,
          userId: data.userId,
          role: data.role,
          status: data.status ?? 'pending',
          isDefault: data.isDefault ?? false,
          invitedById: data.invitedById ?? null,
        }
        memberships.push(created)
        return created as never
      },
    } as never,
    {
      async append(event: { action: string }) {
        auditEvents.push(event)
        return event as never
      },
    } as never,
  )

  return { service, users, memberships, auditEvents, getActivateCalls: () => activateCalls }
}

function authCtx(over: Partial<AuthContext> & Pick<AuthContext, 'user'>): AuthContext {
  return {
    platformRoles: [],
    memberships: [],
    kind: 'none',
    activeTenantId: null,
    activeTenantRole: null,
    assumed: false,
    ...over,
  }
}

async function main() {
  await check('approve activates user via CAS before membership', async () => {
    const { service, users, memberships, auditEvents } = fixture()
    const updated = await service.approvePlatformRegistration({
      targetUserId: 'pending-1',
      tenantId: 'tenant-a',
      role: 'operator',
      actorId: 'admin-1',
    })
    assert.equal(updated.status, 'active')
    assert.equal(updated.role, 'operator')
    assert.equal(users[0].status, 'active')
    assert.equal(memberships.length, 1)
    assert.equal(memberships[0].status, 'active')
    assert.equal(memberships[0].role, 'operator')
    assert.ok(auditEvents.some((e) => e.action === 'user.role.assign'))
  })

  await check('concurrent second approve is rejected (no second membership)', async () => {
    const { service, memberships } = fixture()
    await service.approvePlatformRegistration({
      targetUserId: 'pending-1',
      tenantId: 'tenant-a',
      role: 'viewer',
      actorId: 'admin-1',
    })
    await assert.rejects(
      () =>
        service.approvePlatformRegistration({
          targetUserId: 'pending-1',
          tenantId: 'tenant-b',
          role: 'admin',
          actorId: 'admin-2',
        }),
      /not pending platform registration/,
    )
    assert.equal(memberships.length, 1)
    assert.equal(memberships[0].tenantId, 'tenant-a')
  })

  await check('CAS miss rejects before membership write', async () => {
    const { service, memberships, users } = fixture()
    // Simulate TOCTOU: findById still sees pending, but CAS loses to a parallel approver.
    const usersRepo = (service as unknown as { users: { activatePendingPlatformRegistration: unknown } }).users
    usersRepo.activatePendingPlatformRegistration = async () => null
    await assert.rejects(
      () =>
        service.approvePlatformRegistration({
          targetUserId: 'pending-1',
          tenantId: 'tenant-b',
          role: 'admin',
          actorId: 'admin-2',
        }),
      /not pending platform registration/,
    )
    assert.equal(users[0].status, 'pending')
    assert.equal(memberships.length, 0)
  })

  await check('reject already-active or role-assigned user', async () => {
    const { service } = fixture({
      id: 'active-1',
      externalAuthId: 'clerk_1',
      email: 'a@example.com',
      name: 'A',
      role: 'viewer',
      status: 'active',
      invitedById: null,
      jobDescription: null,
      activatedAt: new Date(),
      suspendedAt: null,
      suspendedById: null,
      suspendedReason: null,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as StoredUser)
    await assert.rejects(
      () =>
        service.approvePlatformRegistration({
          targetUserId: 'active-1',
          tenantId: 'tenant-a',
          role: 'admin',
          actorId: 'admin-1',
        }),
      /not pending platform registration/,
    )
  })

  await check('applyUserStatusGate strips tenant kind for pending user with active membership', () => {
    const gated = applyUserStatusGate(
      authCtx({
        user: {
          id: 'pending-1',
          externalAuthId: 'clerk_pending_1',
          email: 'new@example.com',
          name: 'New User',
          role: null,
          status: 'pending',
          tenantId: null,
        },
        memberships: [{ tenantId: 'tenant-a', role: 'admin', status: 'active', isDefault: true }],
        kind: 'tenant',
        activeTenantId: 'tenant-a',
        activeTenantRole: 'admin',
      }),
    )
    assert.equal(gated.kind, 'none')
    assert.equal(gated.activeTenantId, null)
    assert.equal(gated.activeTenantRole, null)
    assert.equal(gated.memberships.length, 1)
  })

  await check('applyUserStatusGate keeps tenant kind for active user', () => {
    const gated = applyUserStatusGate(
      authCtx({
        user: {
          id: 'u1',
          externalAuthId: 'clerk_1',
          email: 'a@example.com',
          name: 'A',
          role: 'operator',
          status: 'active',
          tenantId: null,
        },
        kind: 'tenant',
        activeTenantId: 'tenant-a',
        activeTenantRole: 'operator',
      }),
    )
    assert.equal(gated.kind, 'tenant')
    assert.equal(gated.activeTenantId, 'tenant-a')
  })

  await check('applyUserStatusGate strips platform kind for suspended user', () => {
    const gated = applyUserStatusGate(
      authCtx({
        user: {
          id: 'u2',
          externalAuthId: 'clerk_2',
          email: 'b@example.com',
          name: 'B',
          role: 'admin',
          status: 'suspended',
          tenantId: null,
        },
        platformRoles: ['superadmin'],
        kind: 'platform',
      }),
    )
    assert.equal(gated.kind, 'none')
    assert.equal(gated.assumed, false)
  })

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  if (failures) process.exit(1)
}

void main()
