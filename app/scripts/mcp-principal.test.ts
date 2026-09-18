/**
 * MCP principal resolution — DB-free stub-repo tests (#538).
 * Futtatás: npm run test:mcp-principal
 */
import assert from 'node:assert/strict'
import type {
  PlatformMembership,
  Tenant,
  TenantMembership,
  User,
} from '@prisma/client'
import {
  resolveMcpPrincipal,
  tokenClaimsForeignOrigin,
  type McpPrincipalDeps,
} from '../src/auth/mcp-principal'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const CLERK_ID = 'user_clerk_acme'
const ORIGIN = 'https://app.example.com'

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

function user(overrides: Partial<User> = {}): User {
  return {
    id: USER_ID,
    externalAuthId: CLERK_ID,
    email: 'ops@acme.test',
    name: 'Ops',
    jobDescription: null,
    role: 'operator',
    status: 'active',
    tenantId: TENANT_ID,
    invitedById: null,
    activatedAt: new Date('2026-01-01T00:00:00Z'),
    suspendedAt: null,
    suspendedById: null,
    suspendedReason: null,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: TENANT_ID,
    slug: 'acme',
    displayName: 'Acme',
    legalName: null,
    status: 'active',
    domainAllowlist: [],
    settings: {},
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function membership(overrides: Partial<TenantMembership> = {}): TenantMembership {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: TENANT_ID,
    userId: USER_ID,
    role: 'operator',
    status: 'active',
    isDefault: true,
    invitedById: null,
    activatedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function platformRow(overrides: Partial<PlatformMembership> = {}): PlatformMembership {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    userId: USER_ID,
    role: 'superadmin',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function deps(overrides: {
  token?: { clerkUserId: string; claims?: Record<string, unknown> } | null
  user?: User | null
  tenant?: Tenant | null
  membership?: TenantMembership | null
  platform?: PlatformMembership[]
  audit?: Array<Record<string, unknown>>
}): { deps: McpPrincipalDeps; audit: Array<Record<string, unknown>> } {
  const audit = overrides.audit ?? []
  const token =
    overrides.token === undefined
      ? { clerkUserId: CLERK_ID }
      : overrides.token
  return {
    audit,
    deps: {
      async verifyOAuthToken() {
        return token
      },
      users: {
        async findByExternalAuthId() {
          return overrides.user === undefined ? user() : overrides.user
        },
      },
      tenants: {
        async findBySlug() {
          return overrides.tenant === undefined ? tenant() : overrides.tenant
        },
      },
      memberships: {
        async findByTenantAndUser() {
          return overrides.membership === undefined ? membership() : overrides.membership
        },
      },
      platformMemberships: {
        async findByUser() {
          return overrides.platform ?? []
        },
      },
      audit: {
        async append(data) {
          audit.push(data as unknown as Record<string, unknown>)
          return data as never
        },
      },
    },
  }
}

async function resolve(
  authorizationHeader: string | null,
  tenantSlug: string,
  stub: ReturnType<typeof deps>,
) {
  return resolveMcpPrincipal(
    { authorizationHeader, tenantSlug, resourceOrigin: ORIGIN },
    stub.deps,
  )
}

async function main() {
  await check('membership ok → role from membership, assumed false', async () => {
    const stub = deps({})
    const result = await resolve('Bearer tok', 'acme', stub)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.principal.userId, USER_ID)
    assert.equal(result.principal.tenantId, TENANT_ID)
    assert.equal(result.principal.tenantSlug, 'acme')
    assert.equal(result.principal.role, 'operator')
    assert.equal(result.principal.assumed, false)
    assert.equal(stub.audit.some((row) => row.action === 'mcp.auth.ok'), true)
  })

  await check('pending membership deny (non-superadmin)', async () => {
    const stub = deps({ membership: membership({ status: 'pending' }) })
    const result = await resolve('Bearer tok', 'acme', stub)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'not_a_member')
    assert.equal(stub.audit.some((row) => row.action === 'mcp.auth.deny'), true)
  })

  await check('inactive user deny (same code as unknown Clerk user)', async () => {
    const stub = deps({ user: user({ status: 'suspended' }) })
    const result = await resolve('Bearer tok', 'acme', stub)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'user_inactive')

    const unknown = deps({ user: null })
    const unknownResult = await resolve('Bearer tok', 'acme', unknown)
    assert.equal(unknownResult.ok, false)
    if (unknownResult.ok) return
    assert.equal(unknownResult.code, 'user_inactive')
  })

  await check('unknown slug → tenant_unavailable', async () => {
    const stub = deps({ tenant: null })
    const result = await resolve('Bearer tok', 'missing', stub)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'tenant_unavailable')
  })

  await check('inactive tenant denied including superadmin', async () => {
    const stub = deps({
      tenant: tenant({ status: 'suspended' }),
      membership: null,
      platform: [platformRow()],
    })
    const result = await resolve('Bearer tok', 'acme', stub)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'tenant_not_active')
  })

  await check('superadmin assume → assumed true, role admin', async () => {
    const stub = deps({
      membership: null,
      platform: [platformRow()],
    })
    const result = await resolve('Bearer tok', 'acme', stub)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.principal.assumed, true)
    assert.equal(result.principal.role, 'admin')
    assert.equal(result.principal.tenantSlug, 'acme')
    const ok = stub.audit.find((row) => row.action === 'mcp.auth.ok')
    assert.ok(ok)
    assert.equal((ok?.metadata as { assumed?: boolean }).assumed, true)
    assert.equal(
      stub.audit.some((row) => row.action === 'tenant.assume'),
      false,
    )
  })

  await check('non-superadmin without membership → not_a_member', async () => {
    const stub = deps({ membership: null, platform: [] })
    const result = await resolve('Bearer tok', 'acme', stub)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'not_a_member')
  })

  await check('missing Bearer → unauthenticated and is not audited', async () => {
    const stub = deps({})
    const result = await resolve(null, 'acme', stub)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'unauthenticated')
    assert.equal(stub.audit.length, 0)
  })

  await check('invalid token → invalid_token and is audited', async () => {
    const stub = deps({ token: null })
    const result = await resolve('Bearer bad', 'acme', stub)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'invalid_token')
    assert.equal(stub.audit.some((row) => row.action === 'mcp.auth.deny'), true)
  })

  await check('resource claim for a different origin → invalid_token', async () => {
    const stub = deps({
      token: {
        clerkUserId: CLERK_ID,
        claims: { resource: 'https://other.example.com/api/mcp' },
      },
    })
    const result = await resolve('Bearer tok', 'acme', stub)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'invalid_token')
  })

  await check('missing aud/resource is not fail-closed', async () => {
    const stub = deps({ token: { clerkUserId: CLERK_ID, claims: { aud: 'client_abc' } } })
    const result = await resolve('Bearer tok', 'acme', stub)
    assert.equal(result.ok, true)
  })

  await check('tokenClaimsForeignOrigin only flags URL-shaped other origins', () => {
    assert.equal(tokenClaimsForeignOrigin(undefined, ORIGIN), false)
    assert.equal(tokenClaimsForeignOrigin({ aud: 'client_x' }, ORIGIN), false)
    assert.equal(
      tokenClaimsForeignOrigin({ aud: 'https://app.example.com/api/mcp' }, ORIGIN),
      false,
    )
    assert.equal(
      tokenClaimsForeignOrigin({ resource: 'https://evil.test/api/mcp' }, ORIGIN),
      true,
    )
  })

  console.log(`\n${failures === 0 ? 'mcp-principal: ok' : `mcp-principal: ${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

void main()
