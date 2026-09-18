/**
 * MCP HTTP handler — stub token verifier, no live Clerk (#538).
 * Futtatás: npm run test:mcp-http
 */
import assert from 'node:assert/strict'
import type {
  PlatformMembership,
  Tenant,
  TenantMembership,
  User,
} from '@prisma/client'
import { mcpProtectedResourceMetadata } from '../src/auth/mcp-oauth-metadata'
import { handleMcpRequest } from '../src/auth/mcp-server'
import type { McpRuntimeDeps } from '../src/auth/mcp-server'
import { PHASE_A_TOOL_NAME } from '../src/auth/mcp-principal'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const ORIGIN = 'https://app.example.com'
const TOKEN = 'oauth-access-token'

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
    externalAuthId: 'user_clerk_acme',
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

function runtimeDeps(overrides: {
  membership?: TenantMembership | null
  tenant?: Tenant | null
  user?: User | null
  platform?: PlatformMembership[]
  clerkConfigured?: boolean
} = {}): { deps: McpRuntimeDeps; audit: Array<Record<string, unknown>> } {
  const audit: Array<Record<string, unknown>> = []
  return {
    audit,
    deps: {
      isClerkConfigured: () => overrides.clerkConfigured ?? true,
      resolveOrigin: () => ORIGIN,
      async verifyOAuthToken(bearerToken) {
        if (bearerToken !== TOKEN) return null
        return { clerkUserId: 'user_clerk_acme' }
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

function mcpUrl(slug = 'acme') {
  return `${ORIGIN}/api/mcp/${slug}`
}

function post(slug: string, body: unknown, headers: Record<string, string>, deps: McpRuntimeDeps) {
  return handleMcpRequest(
    new Request(mcpUrl(slug), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    slug,
    deps,
  )
}

async function readJson(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') ?? ''
  const text = await res.text()
  if (contentType.includes('text/event-stream')) {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
    const last = lines.at(-1)
    if (!last) throw new Error(`SSE response had no data: ${text.slice(0, 400)}`)
    return JSON.parse(last) as unknown
  }
  return JSON.parse(text) as unknown
}

async function initialize(deps: McpRuntimeDeps, slug = 'acme') {
  const res = await post(
    slug,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'mcp-http-test', version: '1.0.0' },
      },
    },
    { authorization: `Bearer ${TOKEN}` },
    deps,
  )
  return res
}

async function main() {
  await check('missing Bearer → 401 + WWW-Authenticate resource_metadata, not audited', async () => {
    const { deps, audit } = runtimeDeps()
    const res = await post('acme', { jsonrpc: '2.0', id: 1, method: 'ping' }, {}, deps)
    assert.equal(res.status, 401)
    const www = res.headers.get('www-authenticate') ?? ''
    assert.match(www, /resource_metadata=/i)
    assert.match(www, /\/\.well-known\/oauth-protected-resource\/api\/mcp/)
    assert.equal(audit.some((row) => row.action === 'mcp.auth.deny'), false)
  })

  await check('invalid token → 401 and mcp.auth.deny', async () => {
    const { deps, audit } = runtimeDeps()
    const res = await post(
      'acme',
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { authorization: 'Bearer wrong' },
      deps,
    )
    assert.equal(res.status, 401)
    const deny = audit.find((row) => row.action === 'mcp.auth.deny')
    assert.ok(deny)
    assert.equal((deny?.metadata as { code?: string }).code, 'invalid_token')
  })

  await check('unknown slug after auth → 403 tenant_unavailable', async () => {
    const { deps, audit } = runtimeDeps({ tenant: null })
    const res = await post(
      'missing',
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(res.status, 403)
    const body = (await readJson(res)) as { error: { code: string } }
    assert.equal(body.error.code, 'tenant_unavailable')
    assert.equal(audit.some((row) => row.action === 'mcp.auth.deny'), true)
  })

  await check('inactive user → 403 user_inactive', async () => {
    const { deps, audit } = runtimeDeps({ user: user({ status: 'suspended' }) })
    const res = await post(
      'acme',
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(res.status, 403)
    const body = (await readJson(res)) as { error: { code: string } }
    assert.equal(body.error.code, 'user_inactive')
    assert.equal(audit.some((row) => row.action === 'mcp.auth.deny'), true)
  })

  await check('inactive tenant → 403 tenant_not_active', async () => {
    const { deps, audit } = runtimeDeps({ tenant: tenant({ status: 'suspended' }) })
    const res = await post(
      'acme',
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(res.status, 403)
    const body = (await readJson(res)) as { error: { code: string } }
    assert.equal(body.error.code, 'tenant_not_active')
    assert.equal(audit.some((row) => row.action === 'mcp.auth.deny'), true)
  })

  await check('non-member → 403 not_a_member', async () => {
    const { deps, audit } = runtimeDeps({ membership: null })
    const res = await post(
      'acme',
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(res.status, 403)
    const body = (await readJson(res)) as { error: { code: string } }
    assert.equal(body.error.code, 'not_a_member')
    assert.equal(audit.some((row) => row.action === 'mcp.auth.deny'), true)
  })

  await check('Clerk not configured → 503 auth_not_configured', async () => {
    const { deps } = runtimeDeps({ clerkConfigured: false })
    const res = await post('acme', { jsonrpc: '2.0', id: 1, method: 'ping' }, {}, deps)
    assert.equal(res.status, 503)
    const body = (await readJson(res)) as { error: { code: string } }
    assert.equal(body.error.code, 'auth_not_configured')
  })

  await check('tools/list returns only platform.whoami', async () => {
    const { deps } = runtimeDeps()
    const init = await initialize(deps)
    assert.equal(init.status, 200, `initialize HTTP ${init.status}: ${await init.clone().text()}`)
    const list = await post(
      'acme',
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(list.status, 200)
    const body = (await readJson(list)) as {
      result?: { tools?: Array<{ name: string }> }
      error?: unknown
    }
    assert.equal(body.error, undefined, JSON.stringify(body))
    const names = (body.result?.tools ?? []).map((tool) => tool.name)
    assert.deepEqual(names, [PHASE_A_TOOL_NAME])
  })

  await check('platform.whoami returns principal JSON and ignores extra args', async () => {
    const { deps, audit } = runtimeDeps()
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: PHASE_A_TOOL_NAME,
          arguments: {
            userId: 'attacker-user',
            tenantId: 'attacker-tenant',
            tenantSlug: 'other-tenant',
          },
        },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(res.status, 200)
    const body = (await readJson(res)) as {
      result?: { content?: Array<{ type: string; text: string }>; isError?: boolean }
    }
    assert.equal(body.result?.isError, undefined)
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>
    assert.deepEqual(payload, {
      userId: USER_ID,
      tenantId: TENANT_ID,
      tenantSlug: 'acme',
      role: 'operator',
      assumed: false,
    })
    assert.equal(audit.some((row) => row.action === 'mcp.tools.call'), true)
  })

  await check('unknown tool → HTTP 200 tool_not_allowed isError', async () => {
    const { deps, audit } = runtimeDeps()
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'drive.files.list', arguments: {} },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(res.status, 200)
    const body = (await readJson(res)) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
    }
    assert.equal(body.result?.isError, true)
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as { code?: string }
    assert.equal(payload.code, 'tool_not_allowed')
    assert.equal(audit.some((row) => row.action === 'mcp.tools.call.deny'), true)
  })

  await check('protected resource metadata resource is {origin}/api/mcp at every well-known path', async () => {
    const previous = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from('clerk.example.com$').toString('base64url')}`
    try {
      for (const url of [
        `${ORIGIN}/.well-known/oauth-protected-resource`,
        `${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`,
        `${ORIGIN}/.well-known/oauth-protected-resource/api/mcp/acme`,
      ]) {
        const res = await mcpProtectedResourceMetadata(new Request(url))
        assert.equal(res.status, 200, url)
        const body = (await res.json()) as {
          resource: string
          authorization_servers: string[]
          scopes_supported: string[]
          bearer_methods_supported: string[]
        }
        assert.equal(body.resource, `${ORIGIN}/api/mcp`)
        assert.ok(Array.isArray(body.authorization_servers) && body.authorization_servers.length > 0)
        assert.deepEqual(body.scopes_supported, ['openid', 'profile', 'email'])
        assert.deepEqual(body.bearer_methods_supported, ['header'])
      }
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
      else process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = previous
    }
  })

  console.log(`\n${failures === 0 ? 'mcp-http: ok' : `mcp-http: ${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

void main()
