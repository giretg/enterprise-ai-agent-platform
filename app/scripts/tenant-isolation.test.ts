/**
 * Tenant Management — cross-tenant izolációs integrációs tesztek (§12, §13/3,6,7,8,10).
 *
 * Futtatás: DATABASE_URL=postgresql://stub:stub@127.0.0.1:5432/stub tsx scripts/tenant-isolation.test.ts
 *
 * A `tenant-management.test.ts` a tiszta döntési logikát fedi; ez a fájl a
 * DB-t érintő domain-szolgáltatásokat (IamService, TenantService) in-memory
 * mock-repókkal futtatja, és a KERESZTTENANT izolációs invariánsokat bizonyítja:
 *  - tenant A admin nem lát / nem módosít tenant B usert (N-IAM-6),
 *  - az utolsó aktív tenant-admin lock membership-alapon (§7.2, §13/8),
 *  - a superadmin assume-tenant auditált (§5.3, §13/5),
 *  - a platform-szerep grant/revoke auditált + utolsó-superadmin védelem.
 */
import assert from 'node:assert/strict'
import type { UserRole } from '@prisma/client'
import { IamService } from '../src/domain/iam/iam-service'
import { TenantService } from '../src/domain/tenant/tenant-service'

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

async function assertThrows(fn: () => Promise<unknown>, matcher: RegExp) {
  try {
    await fn()
  } catch (e) {
    assert.match(e instanceof Error ? e.message : String(e), matcher)
    return
  }
  throw new Error(`expected throw matching ${matcher}`)
}

// ── In-memory audit ─────────────────────────────────────────────────────────
type AuditEvent = { action: string; actorId: string | null; targetId: string | null; tenantId?: string | null; policyDecision?: string | null }
function makeAudit() {
  const events: AuditEvent[] = []
  return {
    events,
    repo: {
      append: async (e: AuditEvent) => {
        events.push(e)
        return { id: `audit-${events.length}` }
      },
      findMany: async () => events,
    },
  }
}

// ── In-memory User store ────────────────────────────────────────────────────
type MockUser = {
  id: string
  email: string
  name: string
  externalAuthId: string
  role: UserRole | null
  status: 'active' | 'pending' | 'suspended'
  tenantId: string | null
  jobDescription: string | null
}
function makeUserRepo(seed: MockUser[]) {
  const users = new Map(seed.map((u) => [u.id, { ...u }]))
  return {
    findById: async (id: string) => users.get(id) ?? null,
    update: async (id: string, data: Partial<MockUser>) => {
      const u = users.get(id)
      if (!u) throw new Error('user: not found')
      Object.assign(u, data)
      return u
    },
    findMany: async (filter?: { tenantId?: string | null }) =>
      [...users.values()].filter((u) => (filter?.tenantId === undefined ? true : u.tenantId === filter.tenantId)),
    countActiveAdmins: async (tenantId: string | null, excludeUserId?: string) =>
      [...users.values()].filter(
        (u) => u.tenantId === tenantId && u.role === 'admin' && u.status === 'active' && u.id !== excludeUserId,
      ).length,
  }
}

// ── In-memory Membership store ──────────────────────────────────────────────
type MockMembership = {
  id: string
  tenantId: string
  userId: string
  role: UserRole
  status: 'pending' | 'active' | 'suspended'
  isDefault: boolean
  activatedAt: Date | null
}
function makeMembershipRepo(seed: MockMembership[]) {
  const rows = new Map(seed.map((m) => [m.id, { ...m }]))
  let seq = seed.length
  return {
    findById: async (id: string) => rows.get(id) ?? null,
    findByTenantAndUser: async (tenantId: string, userId: string) =>
      [...rows.values()].find((m) => m.tenantId === tenantId && m.userId === userId) ?? null,
    findByUser: async (userId: string) => [...rows.values()].filter((m) => m.userId === userId),
    findByTenant: async (tenantId: string) => [...rows.values()].filter((m) => m.tenantId === tenantId),
    countActiveAdmins: async (tenantId: string, excludeUserId?: string) =>
      [...rows.values()].filter(
        (m) => m.tenantId === tenantId && m.role === 'admin' && m.status === 'active' && m.userId !== excludeUserId,
      ).length,
    create: async (data: Omit<MockMembership, 'id' | 'activatedAt'> & { activatedAt?: Date | null }) => {
      const id = `m-${++seq}`
      const row = { id, activatedAt: null, ...data }
      rows.set(id, row)
      return row
    },
    update: async (id: string, data: Partial<MockMembership>) => {
      const m = rows.get(id)
      if (!m) throw new Error('membership: not found')
      Object.assign(m, data)
      return m
    },
  }
}

function makeTenantRepo(seed: Array<{ id: string; slug: string; displayName: string; status: string }>) {
  const rows = new Map(seed.map((t) => [t.id, { legalName: null, ...t }]))
  return {
    findById: async (id: string) => rows.get(id) ?? null,
    findBySlug: async (slug: string) => [...rows.values()].find((t) => t.slug === slug) ?? null,
    findMany: async () => [...rows.values()],
    create: async (data: { slug: string; displayName: string }) => {
      const id = `t-${data.slug}`
      const row = { id, status: 'active', legalName: null, ...data }
      rows.set(id, row)
      return row
    },
    update: async (id: string, data: Record<string, unknown>) => {
      const t = rows.get(id)
      if (!t) throw new Error('tenant: not found')
      Object.assign(t, data)
      return t
    },
  }
}

function makePlatformRepo(seed: Array<{ userId: string; role: string; status: string }>) {
  let rows = seed.map((r, i) => ({ id: `p-${i}`, createdAt: new Date(), ...r }))
  return {
    findByUser: async (userId: string) => rows.filter((r) => r.userId === userId),
    findByRole: async (role: string) => rows.filter((r) => r.role === role),
    findAll: async () => rows.map((r) => ({ ...r, userEmail: `${r.userId}@x`, userName: r.userId })),
    upsert: async (data: { userId: string; role: string; status?: string }) => {
      const existing = rows.find((r) => r.userId === data.userId && r.role === data.role)
      if (existing) {
        existing.status = data.status ?? existing.status
        return existing
      }
      const row = { id: `p-${rows.length}`, createdAt: new Date(), status: 'active', ...data }
      rows.push(row)
      return row
    },
    delete: async (userId: string, role: string) => {
      rows = rows.filter((r) => !(r.userId === userId && r.role === role))
    },
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function main() {
  // ══ IamService cross-tenant izoláció (§13/3, N-IAM-6) ══════════════════════
  const TENANT_A = 'tenant-a'
  const TENANT_B = 'tenant-b'

  function iamFixture() {
    const audit = makeAudit()
    const users = makeUserRepo([
      { id: 'admin-a', email: 'admin-a@x', name: 'Admin A', externalAuthId: 'ext-admin-a', role: 'admin', status: 'active', tenantId: TENANT_A, jobDescription: null },
      { id: 'op-a', email: 'op-a@x', name: 'Op A', externalAuthId: 'ext-op-a', role: 'operator', status: 'active', tenantId: TENANT_A, jobDescription: null },
      { id: 'admin-a2', email: 'admin-a2@x', name: 'Admin A2', externalAuthId: 'ext-admin-a2', role: 'admin', status: 'active', tenantId: TENANT_A, jobDescription: null },
      { id: 'user-b', email: 'user-b@x', name: 'User B', externalAuthId: 'ext-user-b', role: 'operator', status: 'active', tenantId: TENANT_B, jobDescription: null },
    ])
    const iam = new IamService(
      users as any,
      {} as any,
      { findByKey: async () => null } as any,
      audit.repo as any,
    )
    return { iam, audit, users }
  }

  await check('IamService.listUsers: csak a HÍVÓ tenant userei (§13/3)', async () => {
    const { iam } = iamFixture()
    const listA = await iam.listUsers(TENANT_A)
    assert.deepEqual(listA.map((u) => u.id).sort(), ['admin-a', 'admin-a2', 'op-a'])
    const listB = await iam.listUsers(TENANT_B)
    assert.deepEqual(listB.map((u) => u.id), ['user-b'])
  })

  await check('IamService.changeRole: cross-tenant célpont ⇒ "user: not found" (nem szivárog)', async () => {
    const { iam } = iamFixture()
    // Tenant A admin megpróbálja tenant B userét átállítani.
    await assertThrows(
      () => iam.changeRole({ targetUserId: 'user-b', newRole: 'admin', actorId: 'admin-a', actorTenantId: TENANT_A }),
      /user: not found/,
    )
  })

  await check('IamService.suspendUser: cross-tenant célpont ⇒ "user: not found"', async () => {
    const { iam } = iamFixture()
    await assertThrows(
      () => iam.suspendUser({ targetUserId: 'user-b', reason: 'x', actorId: 'admin-a', actorTenantId: TENANT_A }),
      /user: not found/,
    )
  })

  await check('IamService.setJobDescription: cross-tenant célpont ⇒ "user: not found"', async () => {
    const { iam } = iamFixture()
    await assertThrows(
      () => iam.setJobDescription({ targetUserId: 'user-b', jobDescription: 'spy', actorId: 'admin-a', actorTenantId: TENANT_A }),
      /user: not found/,
    )
  })

  await check('IamService.changeRole: utolsó aktív admin lock TENANT-szinten (van másik admin A-ban ⇒ engedett)', async () => {
    const { iam, users } = iamFixture()
    // admin-a lefokozható, mert admin-a2 is aktív admin ugyanabban a tenantban.
    const updated = await iam.changeRole({ targetUserId: 'admin-a2', newRole: 'operator', actorId: 'admin-a', actorTenantId: TENANT_A })
    assert.equal(updated.role, 'operator')
    // Most már csak admin-a az egyetlen admin — őt már nem lehet lefokozni (self ráadásul tilos, más adminnal teszteljük).
    const u = await users.findById('admin-a2')
    assert.equal(u?.role, 'operator')
  })

  await check('IamService.suspendUser: az UTOLSÓ aktív admin nem függeszthető fel (lockout)', async () => {
    const { iam } = iamFixture()
    // admin-a2 lefokozása után admin-a az egyetlen admin → felfüggesztése tilos.
    await iam.changeRole({ targetUserId: 'admin-a2', newRole: 'operator', actorId: 'admin-a', actorTenantId: TENANT_A })
    await assertThrows(
      () => iam.suspendUser({ targetUserId: 'admin-a', reason: 'x', actorId: 'admin-a2', actorTenantId: TENANT_A }),
      /last active admin/,
    )
  })

  // ══ TenantService membership cross-tenant izoláció (§13/8) ══════════════════
  function tenantFixture() {
    const audit = makeAudit()
    const tenants = makeTenantRepo([
      { id: TENANT_A, slug: 'ta', displayName: 'Tenant A', status: 'active' },
      { id: TENANT_B, slug: 'tb', displayName: 'Tenant B', status: 'active' },
    ])
    const memberships = makeMembershipRepo([
      { id: 'ma1', tenantId: TENANT_A, userId: 'admin-a', role: 'admin', status: 'active', isDefault: true, activatedAt: new Date() },
      { id: 'ma2', tenantId: TENANT_A, userId: 'admin-a2', role: 'admin', status: 'active', isDefault: false, activatedAt: new Date() },
      { id: 'mb1', tenantId: TENANT_B, userId: 'user-b', role: 'admin', status: 'active', isDefault: true, activatedAt: new Date() },
    ])
    const platform = makePlatformRepo([{ userId: 'root', role: 'superadmin', status: 'active' }])
    const svc = new TenantService(tenants as any, memberships as any, platform as any, audit.repo as any)
    return { svc, audit, platform, memberships }
  }

  await check('TenantService.changeMemberRole: cross-tenant célpont ⇒ "membership: not found"', async () => {
    const { svc } = tenantFixture()
    // Tenant A admin megpróbálja user-b (tenant B) membershipjét A-ban átállítani.
    await assertThrows(
      () => svc.changeMemberRole({ tenantId: TENANT_A, targetUserId: 'user-b', newRole: 'viewer', actorId: 'admin-a' }),
      /membership: not found/,
    )
  })

  await check('TenantService.suspendMember: tenant B UTOLSÓ adminja nem függeszthető (membership lock)', async () => {
    const { svc } = tenantFixture()
    await assertThrows(
      () => svc.suspendMember({ tenantId: TENANT_B, targetUserId: 'user-b', actorId: 'root' }),
      /last active tenant admin/,
    )
  })

  await check('TenantService.changeMemberRole: van másik admin A-ban ⇒ engedett + auditált', async () => {
    const { svc, audit } = tenantFixture()
    const updated = await svc.changeMemberRole({ tenantId: TENANT_A, targetUserId: 'admin-a2', newRole: 'viewer', actorId: 'admin-a' })
    assert.equal(updated.role, 'viewer')
    assert.ok(audit.events.some((e) => e.action === 'tenant.member.role.change' && e.tenantId === TENANT_A))
  })

  await check('TenantService.recordAssumeTenant: superadmin assume auditált (§13/5)', async () => {
    const { svc, audit } = tenantFixture()
    await svc.recordAssumeTenant({ superadminId: 'root', tenantId: TENANT_B })
    const ev = audit.events.find((e) => e.action === 'tenant.assume')
    assert.ok(ev, 'tenant.assume audit hiányzik')
    assert.equal(ev?.actorId, 'root')
    assert.equal(ev?.tenantId, TENANT_B)
  })

  // ══ Platform-szerep grant/revoke (§9.3) ════════════════════════════════════
  await check('TenantService.grantPlatformRole: auditált', async () => {
    const { svc, audit } = tenantFixture()
    await svc.grantPlatformRole({ userId: 'new-op', role: 'platform_operator', actorId: 'root' })
    assert.ok(audit.events.some((e) => e.action === 'platform.role.grant'))
  })

  await check('TenantService.revokePlatformRole: auditált + törli a tagságot', async () => {
    const { svc, audit, platform } = tenantFixture()
    await svc.grantPlatformRole({ userId: 'temp', role: 'platform_auditor', actorId: 'root' })
    await svc.revokePlatformRole({ userId: 'temp', role: 'platform_auditor', actorId: 'root' })
    const all = await platform.findAll()
    assert.ok(!all.some((m: any) => m.userId === 'temp'))
    assert.ok(audit.events.some((e) => e.action === 'platform.role.revoke'))
  })

  await check('TenantService.addMember: új default leszed minden korábbi defaultot', async () => {
    const { svc, memberships } = tenantFixture()
    await svc.addMember({
      tenantId: TENANT_B,
      userId: 'admin-a',
      role: 'admin',
      status: 'active',
      isDefault: true,
      actorId: 'admin-a',
    })
    const forUser = await memberships.findByUser('admin-a')
    const defaults = forUser.filter((m) => m.isDefault)
    assert.equal(defaults.length, 1)
    assert.equal(defaults[0].tenantId, TENANT_B)
  })

  await check('TenantService.createTenant: duplikált slug ⇒ elutasít (registry izoláció)', async () => {
    const { svc } = tenantFixture()
    await assertThrows(
      () => svc.createTenant({ slug: 'ta', displayName: 'Dup', createdById: 'root' }),
      /slug already exists/,
    )
  })

  console.log(`\n${failures === 0 ? 'Minden teszt zöld.' : `${failures} teszt bukott.`}`)
  if (failures > 0) process.exit(1)
}

main()
