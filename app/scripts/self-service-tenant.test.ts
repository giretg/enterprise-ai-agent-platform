/**
 * #830 Self-service cégindítás — SS-1…SS-10.
 *
 * Futtatás: npm run test:self-service-tenant
 *
 * A `TenantService.provisionSelfService` egy in-memory `SelfServiceTenantStore`-ral fut
 * (a tranzakció itt egyszerű callback); a routing- és slug-döntések tiszta függvények.
 * A Postgres-tároló ugyanezt az interfészt valósítja meg, advisory lockkal.
 */
import assert from 'node:assert/strict'
import type { Tenant, TenantMembership, TenantStatus, UserRole, UserStatus } from '@prisma/client'
import { SelfServiceTenantError, TenantService } from '../src/domain/tenant/tenant-service'
import type { SelfServiceTenantStore } from '../src/domain/tenant/self-service-store'
import { REGISTERED_AUDIT_ACTIONS, assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import { assertAuditMetadataSafe } from '../src/lib/audit/payload-guard'
import {
  ONBOARDING_PATH,
  CONTROL_PLANE_PENDING_PATH,
  homePathForAuthContext,
  signUpForceRedirectUrl,
} from '../src/lib/control-plane-entry'
import {
  SELF_SERVICE_TENANT_CAP,
  canStartSelfServiceTenant,
  isValidTenantSlug,
  normalizeTaxId,
  selfServiceFallbackSlug,
  selfServiceSlugBase,
  selfServiceSlugCandidate,
  transliterateHungarian,
} from '../src/lib/tenant-policy'
import { onboardingErrorKey } from '../src/lib/onboarding-errors'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e: unknown) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

async function assertSelfServiceError(fn: () => Promise<unknown>, code: string) {
  try {
    await fn()
  } catch (e) {
    assert.ok(e instanceof SelfServiceTenantError, `expected SelfServiceTenantError, got ${String(e)}`)
    assert.equal(e.code, code)
    return
  }
  throw new Error(`expected self_service:${code}`)
}

// ── In-memory világ ─────────────────────────────────────────────────────────

type MockUser = { id: string; status: UserStatus; role: UserRole | null }
type AuditEvent = { action: string; actorId?: string | null; tenantId?: string | null; metadata?: unknown }

function makeWorld(users: MockUser[]) {
  const tenants: Tenant[] = []
  const memberships: TenantMembership[] = []
  const audit: AuditEvent[] = []
  const userMap = new Map(users.map((u) => [u.id, { ...u }]))
  let seq = 0
  const now = new Date()

  const newTenant = (data: Partial<Tenant> & { slug: string; displayName: string }): Tenant => ({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    legalName: null,
    taxId: null,
    status: 'active',
    domainAllowlist: [],
    settings: {},
    createdById: null,
    selfService: false,
    createdAt: now,
    updatedAt: now,
    ...data,
  })

  const store: SelfServiceTenantStore = {
    transaction: (run) =>
      run({
        findUser: async (id) => userMap.get(id) ?? null,
        countSelfServiceTenants: async (userId) =>
          tenants.filter((t) => t.createdById === userId && t.selfService && t.status !== 'archived').length,
        slugExists: async (slug) => tenants.some((t) => t.slug === slug),
        createTenant: async (data) => {
          const tenant = newTenant({ ...data, selfService: true })
          tenants.push(tenant)
          return tenant
        },
        clearDefaultMemberships: async (userId) => {
          for (const m of memberships) if (m.userId === userId) m.isDefault = false
        },
        createAdminMembership: async ({ tenantId, userId }) => {
          const membership: TenantMembership = {
            id: `m-${++seq}`,
            tenantId,
            userId,
            role: 'admin',
            status: 'active',
            isDefault: true,
            invitedById: userId,
            activatedAt: now,
            createdAt: now,
            updatedAt: now,
          } as TenantMembership
          memberships.push(membership)
          return membership
        },
        activateUser: async (userId, role) => {
          const user = userMap.get(userId)!
          user.status = 'active'
          user.role = role
        },
        audit: async (event) => {
          // A Postgres-tároló ugyanezt a két kaput futtatja (appendAuditInTransaction).
          assertAuditActionRegistered(event.action)
          assertAuditMetadataSafe(event.metadata)
          audit.push(event)
          return event
        },
      }),
  }

  // A superadmin-út (createTenant) a sima repókon fut — selfService=false sorokat ír.
  const tenantRepo = {
    findById: async (id: string) => tenants.find((t) => t.id === id) ?? null,
    findBySlug: async (slug: string) => tenants.find((t) => t.slug === slug) ?? null,
    create: async (data: { slug: string; displayName: string; createdById?: string | null }) => {
      const tenant = newTenant({ slug: data.slug, displayName: data.displayName, createdById: data.createdById ?? null })
      tenants.push(tenant)
      return tenant
    },
    update: async (id: string, data: { status?: TenantStatus }) => {
      const tenant = tenants.find((t) => t.id === id)!
      Object.assign(tenant, data)
      return tenant
    },
  }
  const membershipRepo = {
    findByTenantAndUser: async (tenantId: string, userId: string) =>
      memberships.find((m) => m.tenantId === tenantId && m.userId === userId) ?? null,
    findByUser: async (userId: string) => memberships.filter((m) => m.userId === userId),
    update: async (id: string, data: Partial<TenantMembership>) => {
      const m = memberships.find((row) => row.id === id)!
      Object.assign(m, data)
      return m
    },
    create: async (data: Partial<TenantMembership> & { tenantId: string; userId: string; role: UserRole }) => {
      const m = { id: `m-${++seq}`, status: 'pending', isDefault: false, ...data } as TenantMembership
      memberships.push(m)
      return m
    },
  }
  const auditSink = { append: async (event: AuditEvent) => audit.push(event) }

  const svc = new TenantService(
    tenantRepo as never,
    membershipRepo as never,
    {} as never,
    auditSink as never,
    store,
  )
  return { svc, tenants, memberships, audit, users: userMap }
}

const PENDING_USER: MockUser = { id: 'u-pending', status: 'pending', role: null }
const ACTIVE_OPERATOR: MockUser = { id: 'u-op', status: 'active', role: 'operator' }
const SUSPENDED_USER: MockUser = { id: 'u-susp', status: 'suspended', role: 'admin' }
const ROOT: MockUser = { id: 'u-root', status: 'active', role: 'admin' }

const provision = (svc: TenantService, userId: string, displayName: string, extra: Record<string, unknown> = {}) =>
  svc.provisionSelfService({ userId, displayName, termsAccepted: true, ...extra })

async function main() {
  // ── SS-1 ─────────────────────────────────────────────────────────────────
  await check('SS-1 pending + szerep nélküli user ⇒ aktív admin + admin/active/default membership', async () => {
    const w = makeWorld([PENDING_USER])
    const res = await provision(w.svc, PENDING_USER.id, 'Acme', { legalName: 'Acme Kft.', taxId: ' 12345678-2-42 ' })
    assert.equal(res.userActivated, true)
    assert.deepEqual(w.users.get(PENDING_USER.id), { id: PENDING_USER.id, status: 'active', role: 'admin' })
    assert.equal(res.tenant.status, 'active')
    assert.deepEqual(res.tenant.domainAllowlist, [])
    assert.equal(res.tenant.legalName, 'Acme Kft.')
    assert.equal(res.tenant.taxId, '12345678-2-42')
    assert.equal(res.tenant.createdById, PENDING_USER.id)
    assert.equal(res.membership.role, 'admin')
    assert.equal(res.membership.status, 'active')
    assert.equal(res.membership.isDefault, true)
  })

  await check('SS-1b második saját cég: új default membership, a meglévő szerep NEM íródik felül', async () => {
    const w = makeWorld([ACTIVE_OPERATOR])
    const first = await provision(w.svc, ACTIVE_OPERATOR.id, 'Első')
    assert.equal(first.userActivated, false)
    assert.equal(w.users.get(ACTIVE_OPERATOR.id)?.role, 'operator')
    const second = await provision(w.svc, ACTIVE_OPERATOR.id, 'Második')
    const mine = w.memberships.filter((m) => m.userId === ACTIVE_OPERATOR.id)
    assert.equal(mine.length, 2)
    assert.deepEqual(
      mine.filter((m) => m.isDefault).map((m) => m.tenantId),
      [second.tenant.id],
    )
  })

  await check('SS-1c adószám nélkül is létrejön (null), üres adószám ⇒ null', async () => {
    const w = makeWorld([PENDING_USER])
    const res = await provision(w.svc, PENDING_USER.id, 'Adószám Nélkül', { taxId: '   ' })
    assert.equal(res.tenant.taxId, null)
    assert.equal(res.tenant.legalName, null)
  })

  // ── SS-2 ─────────────────────────────────────────────────────────────────
  await check(`SS-2 ${SELF_SERVICE_TENANT_CAP}. siker, ${SELF_SERVICE_TENANT_CAP + 1}. elutasítva (cap_reached)`, async () => {
    const w = makeWorld([PENDING_USER])
    for (let i = 1; i <= SELF_SERVICE_TENANT_CAP; i++) await provision(w.svc, PENDING_USER.id, `Cég ${i}`)
    await assertSelfServiceError(() => provision(w.svc, PENDING_USER.id, 'Hatodik'), 'cap_reached')
    assert.equal(w.tenants.length, SELF_SERVICE_TENANT_CAP)
  })

  // ── SS-3 ─────────────────────────────────────────────────────────────────
  await check('SS-3 archivált cég felszabadítja a kvótát; suspended/offboarding nem', async () => {
    const w = makeWorld([PENDING_USER])
    for (let i = 1; i <= SELF_SERVICE_TENANT_CAP; i++) await provision(w.svc, PENDING_USER.id, `Cég ${i}`)
    w.tenants[0].status = 'suspended'
    w.tenants[1].status = 'offboarding'
    await assertSelfServiceError(() => provision(w.svc, PENDING_USER.id, 'Még egy'), 'cap_reached')
    w.tenants[2].status = 'archived'
    await provision(w.svc, PENDING_USER.id, 'Még egy')
  })

  // ── SS-4 ─────────────────────────────────────────────────────────────────
  await check('SS-4 superadmin createTenant nem számít a kvótába (a sajátjába sem)', async () => {
    const w = makeWorld([ROOT, PENDING_USER])
    for (let i = 1; i <= SELF_SERVICE_TENANT_CAP; i++) {
      await w.svc.createTenant({ slug: `platform-${i}`, displayName: `Platform ${i}`, createdById: ROOT.id })
      await w.svc.createTenant({
        slug: `ugyfel-${i}`,
        displayName: `Ügyfél ${i}`,
        createdById: ROOT.id,
        initialAdminUserId: PENDING_USER.id,
      })
    }
    await provision(w.svc, ROOT.id, 'Root saját cége')
    await provision(w.svc, PENDING_USER.id, 'Ügyfél saját cége')
  })

  // ── SS-5 ─────────────────────────────────────────────────────────────────
  await check('SS-5 felfüggesztett user nem indíthat céget', async () => {
    const w = makeWorld([SUSPENDED_USER])
    await assertSelfServiceError(() => provision(w.svc, SUSPENDED_USER.id, 'Tiltott'), 'user_suspended')
    assert.equal(w.tenants.length, 0)
  })

  await check('SS-5b superadmin assume-módban fail closed', async () => {
    const w = makeWorld([ROOT])
    await assertSelfServiceError(() => provision(w.svc, ROOT.id, 'Assume', { assumed: true }), 'assumed_context')
    assert.equal(w.tenants.length, 0)
  })

  await check('SS-5c canStartSelfServiceTenant: suspended / assume / limit ⇒ nincs „Új cég"', () => {
    assert.equal(canStartSelfServiceTenant({ userStatus: 'pending', assumed: false, ownedSelfServiceCount: 0 }), true)
    assert.equal(canStartSelfServiceTenant({ userStatus: 'active', assumed: false, ownedSelfServiceCount: 4 }), true)
    assert.equal(canStartSelfServiceTenant({ userStatus: 'active', assumed: false, ownedSelfServiceCount: 5 }), false)
    assert.equal(canStartSelfServiceTenant({ userStatus: 'suspended', assumed: false, ownedSelfServiceCount: 0 }), false)
    assert.equal(canStartSelfServiceTenant({ userStatus: 'active', assumed: true, ownedSelfServiceCount: 0 }), false)
  })

  // ── SS-6 ─────────────────────────────────────────────────────────────────
  await check('SS-6 termsAccepted=false ⇒ elutasítva, semmi nem íródik', async () => {
    const w = makeWorld([PENDING_USER])
    await assertSelfServiceError(
      () => w.svc.provisionSelfService({ userId: PENDING_USER.id, displayName: 'X', termsAccepted: false }),
      'terms_required',
    )
    assert.equal(w.tenants.length, 0)
    assert.equal(w.users.get(PENDING_USER.id)?.status, 'pending')
  })

  await check('SS-6b üres cégnév / túl hosszú adószám üzleti hibakóddal', async () => {
    const w = makeWorld([PENDING_USER])
    await assertSelfServiceError(() => provision(w.svc, PENDING_USER.id, '   '), 'name_required')
    await assertSelfServiceError(
      () => provision(w.svc, PENDING_USER.id, 'Jó Név', { taxId: 'x'.repeat(33) }),
      'tax_id_too_long',
    )
    assert.equal(normalizeTaxId('x'.repeat(32)), 'x'.repeat(32))
  })

  // ── SS-7 ─────────────────────────────────────────────────────────────────
  await check('SS-7 magyar név ⇒ olvasható slug: „Őstermelő Kft" → ostermelo-kft', () => {
    assert.equal(transliterateHungarian('ÁÉÍÓÖŐÚÜŰ áéíóöőúüű'), 'AEIOOOUUU aeiooouuu')
    assert.equal(selfServiceSlugBase('Őstermelő Kft'), 'ostermelo-kft')
    assert.equal(selfServiceSlugBase('Őstermelő Kft.'), 'ostermelo-kft')
    assert.equal(selfServiceSlugBase('Árvíztűrő Tükörfúrógép Zrt.'), 'arvizturo-tukorfurogep-zrt')
  })

  await check('SS-7b ütközés ⇒ -2, -3; érvénytelen név ⇒ t-xxxxxxxx', async () => {
    const w = makeWorld([PENDING_USER, ACTIVE_OPERATOR])
    const a = await provision(w.svc, PENDING_USER.id, 'Őstermelő Kft')
    const b = await provision(w.svc, ACTIVE_OPERATOR.id, 'Őstermelő Kft.')
    const c = await provision(w.svc, ACTIVE_OPERATOR.id, 'ŐSTERMELŐ KFT')
    assert.deepEqual([a.tenant.slug, b.tenant.slug, c.tenant.slug], ['ostermelo-kft', 'ostermelo-kft-2', 'ostermelo-kft-3'])
    assert.equal(selfServiceSlugBase('!!!'), null)
    assert.equal(selfServiceSlugBase('漢字'), null)
    const d = await provision(w.svc, PENDING_USER.id, '漢字')
    assert.match(d.tenant.slug, /^t-[a-z0-9]{8}$/)
    assert.equal(d.tenant.displayName, '漢字')
  })

  await check('SS-7c hosszú név: a slug (toldalékkal is) érvényes és ≤ 63 karakter', () => {
    const base = selfServiceSlugBase('Nagyon '.repeat(20) + 'hosszú cégnév')!
    assert.ok(isValidTenantSlug(base) && base.length <= 63)
    const suffixed = selfServiceSlugCandidate(base, 12)
    assert.ok(isValidTenantSlug(suffixed) && suffixed.length <= 63 && suffixed.endsWith('-12'))
    assert.equal(selfServiceFallbackSlug('ABCDEF12-3456-7890'), 't-abcdef12')
  })

  // ── SS-8 ─────────────────────────────────────────────────────────────────
  await check('SS-8 audit: tenant.create source=self_service + legal.terms.accept (regisztrált)', async () => {
    assert.ok(REGISTERED_AUDIT_ACTIONS.has('legal.terms.accept'))
    const w = makeWorld([PENDING_USER])
    const res = await provision(w.svc, PENDING_USER.id, 'Audit Kft')
    const create = w.audit.find((e) => e.action === 'tenant.create')
    assert.ok(create, 'tenant.create hiányzik')
    assert.equal((create.metadata as { source?: string }).source, 'self_service')
    assert.equal(create.tenantId, res.tenant.id)
    const terms = w.audit.find((e) => e.action === 'legal.terms.accept')
    assert.ok(terms, 'legal.terms.accept hiányzik')
    assert.deepEqual(terms.metadata, { tenantId: res.tenant.id, gtcPath: '/gtc', privacyPath: '/privacy' })
    assert.equal(terms.actorId, PENDING_USER.id)
    assert.ok(w.audit.some((e) => e.action === 'tenant.member.add'))
  })

  // ── SS-9 ─────────────────────────────────────────────────────────────────
  await check('SS-9 meghívó-ticketes regisztráció NEM a varázslóba visz', () => {
    assert.equal(signUpForceRedirectUrl({ __clerk_ticket: 'tkt' }), undefined)
    assert.equal(signUpForceRedirectUrl({ ticket: 'tkt' }), undefined)
    assert.equal(signUpForceRedirectUrl({}), ONBOARDING_PATH)
    assert.equal(ONBOARDING_PATH, '/onboarding')
  })

  // ── SS-10 ────────────────────────────────────────────────────────────────
  await check('SS-10 homePathForAuthContext: none+pending → onboarding; suspended → pending; tenant → null', () => {
    assert.equal(homePathForAuthContext({ kind: 'none', user: { status: 'pending', role: null } }), ONBOARDING_PATH)
    assert.equal(homePathForAuthContext({ kind: 'none', user: { status: 'active', role: 'admin' } }), ONBOARDING_PATH)
    assert.equal(
      homePathForAuthContext({ kind: 'none', user: { status: 'suspended', role: null } }),
      CONTROL_PLANE_PENDING_PATH,
    )
    assert.equal(
      homePathForAuthContext({ kind: 'tenant', user: { status: 'suspended', role: 'admin' } }),
      CONTROL_PLANE_PENDING_PATH,
    )
    assert.equal(homePathForAuthContext({ kind: 'tenant', user: { status: 'active', role: 'admin' } }), null)
  })

  // ── UI hibakód-fordítás ─────────────────────────────────────────────────
  await check('onboardingErrorKey: ismert kód → saját kulcs, egyéb → generic', () => {
    assert.equal(onboardingErrorKey('self_service:cap_reached'), 'cap_reached')
    assert.equal(onboardingErrorKey('invitation: expired'), 'invitation')
    assert.equal(onboardingErrorKey('self_service:unknown'), 'generic')
    assert.equal(onboardingErrorKey('boom'), 'generic')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt megbukott`)
    process.exit(1)
  }
  console.log('\nMinden teszt rendben.')
}

main()
