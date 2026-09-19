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
import {
  canReadPublishedAgent,
  isPrivilegedAgentReader,
} from '../src/domain/agent-definition'
import {
  GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
  GOOGLE_DRIVE_READ_FILE_TOOL,
  GOOGLE_DRIVE_SEARCH_TOOL,
  invokeEnterpriseTool,
  type EnterpriseToolDeps,
  type LiveConnectorRow,
  type LiveGrantRow,
} from '../src/domain/enterprise-tools'
import {
  enqueueGatewayOperation,
  enqueueResultToMcp,
  getGatewayOperation,
  getResultToMcp,
  type GatewayOperationServiceDeps,
} from '../src/domain/gateway-operation'
import { MemoryGatewayOperationStore } from './memory-gateway-operation-store'
import {
  MCP_AGENTS_LIST_TOOL,
  MCP_AGENT_GET_DEFINITION_TOOL,
  MCP_GATEWAY_OPERATION_GET_TOOL,
  MCP_WHOAMI_TOOL,
} from '../src/auth/mcp-principal'
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
    role: 'operator',
    status: 'active',
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

const DEFINITION_ID = '55555555-5555-4555-8555-555555555555'
const AGENT_ID = '66666666-6666-4666-8666-666666666666'
const OTHER_DEFINITION_ID = '77777777-7777-4777-8777-777777777777'
const CONNECTOR_ID = '88888888-8888-4888-8888-888888888888'
const GRANT_ID = '99999999-9999-4999-8999-999999999999'

const SAMPLE_DEFINITION = {
  definitionId: DEFINITION_ID,
  agentId: AGENT_ID,
  version: 1,
  tenantId: TENANT_ID,
  status: 'active' as const,
  publishedAt: '2026-01-02T00:00:00.000Z',
  snapshot: {
    name: 'Drive assistant',
    roleInstruction: 'Inspect Drive',
    skills: [],
    connectors: [{ connectorId: CONNECTOR_ID, type: 'google_drive', accessMode: 'write' as const }],
    capabilities: [
      { toolName: GOOGLE_DRIVE_SEARCH_TOOL, allowed: true },
      { toolName: GOOGLE_DRIVE_READ_FILE_TOOL, allowed: true },
      { toolName: GOOGLE_DRIVE_CREATE_FOLDER_TOOL, allowed: true },
    ],
  },
}

const PUBLISHED_LIST_ITEM = {
  agentId: AGENT_ID,
  name: 'Drive assistant',
  status: 'active' as const,
  currentDefinitionId: DEFINITION_ID,
  currentVersion: 1,
}

function liveConnector(): LiveConnectorRow {
  return {
    id: CONNECTOR_ID,
    tenantId: TENANT_ID,
    type: 'google_drive',
    authMode: 'user_delegated',
    lifecycleState: 'active',
  }
}

function liveGrant(): LiveGrantRow {
  return {
    id: GRANT_ID,
    tokenRef: 'stub-drive-token',
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
    status: 'active',
  }
}

function runtimeDeps(overrides: {
  membership?: TenantMembership | null
  tenant?: Tenant | null
  user?: User | null
  platform?: PlatformMembership[]
  clerkConfigured?: boolean
  role?: TenantMembership['role']
  grantedAgentIds?: Set<string>
  grantAccessLevel?: 'view' | 'operate'
  liveGrant?: LiveGrantRow | null
  startAuthorization?: EnterpriseToolDeps['startAuthorization']
} = {}): {
  deps: McpRuntimeDeps
  audit: Array<Record<string, unknown>>
  seen: {
    loadDefinitionTenantId?: string
    findActiveGrantTenantId?: string
    findActiveGrantUserId?: string
    resolveActingUserId?: string
    resolveTenantId?: string
  }
} {
  const audit: Array<Record<string, unknown>> = []
  const auditSink = {
    async append(data: { action: string } & Record<string, unknown>) {
      audit.push({ action: data.action, ...data })
    },
  }
  const seen: {
    loadDefinitionTenantId?: string
    findActiveGrantTenantId?: string
    findActiveGrantUserId?: string
    resolveActingUserId?: string
    resolveTenantId?: string
  } = {}
  const role = overrides.role ?? 'operator'
  const grantedAgentIds = overrides.grantedAgentIds ?? new Set<string>()
  const grantAccessLevel = overrides.grantAccessLevel ?? 'view'
  async function loadDefinition(input: {
    tenantId: string
    definitionId?: string
    agentId?: string
    version?: number
  }) {
    seen.loadDefinitionTenantId = input.tenantId
    if (input.definitionId === OTHER_DEFINITION_ID) return null
    if (input.tenantId !== TENANT_ID) return null
    if (input.definitionId && input.definitionId !== DEFINITION_ID) return null
    return SAMPLE_DEFINITION
  }
  const operations = new MemoryGatewayOperationStore()
  const gatewayDeps: GatewayOperationServiceDeps = {
    loadDefinition: ({ tenantId, definitionId }) => loadDefinition({ tenantId, definitionId }),
    async findAgentGrant({ agentId }) {
      return grantedAgentIds.has(agentId) ? { accessLevel: grantAccessLevel } : null
    },
    async findConnector() {
      return liveConnector()
    },
    async findActiveGrant(input) {
      seen.findActiveGrantTenantId = input.tenantId
      seen.findActiveGrantUserId = input.userId
      if ('liveGrant' in overrides) return overrides.liveGrant ?? null
      return liveGrant()
    },
    async resolveAccessToken(params) {
      seen.resolveActingUserId = params.actingUserId
      seen.resolveTenantId = params.tenantId
      return 'stub-drive-token'
    },
    operations,
    audit: auditSink,
    async resolveRequester() {
      return { role, assumed: false }
    },
    startAuthorization: overrides.startAuthorization,
  }
  const enterpriseDeps: EnterpriseToolDeps = {
    loadDefinition: ({ tenantId, definitionId }) => loadDefinition({ tenantId, definitionId }),
    async findAgentGrant({ agentId }) {
      return grantedAgentIds.has(agentId) ? { accessLevel: grantAccessLevel } : null
    },
    async findConnector() {
      return liveConnector()
    },
    async findActiveGrant(input) {
      seen.findActiveGrantTenantId = input.tenantId
      seen.findActiveGrantUserId = input.userId
      if ('liveGrant' in overrides) return overrides.liveGrant ?? null
      return liveGrant()
    },
    async resolveAccessToken(params) {
      seen.resolveActingUserId = params.actingUserId
      seen.resolveTenantId = params.tenantId
      return 'stub-drive-token'
    },
    enqueueWrite: async (input) =>
      enqueueResultToMcp(await enqueueGatewayOperation(gatewayDeps, input)),
    startAuthorization: overrides.startAuthorization,
    audit: auditSink,
  }
  return {
    audit,
    seen,
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
          if (overrides.membership === undefined) return membership({ role })
          return overrides.membership
        },
      },
      platformMemberships: {
        async findByUser() {
          return overrides.platform ?? []
        },
      },
      audit: auditSink,
      async listPublishedAgents({ role: principalRole }) {
        if (isPrivilegedAgentReader(principalRole)) return [PUBLISHED_LIST_ITEM]
        return grantedAgentIds.has(AGENT_ID) ? [PUBLISHED_LIST_ITEM] : []
      },
      loadDefinition,
      async canViewAgent({ role: principalRole, agentId }) {
        return canReadPublishedAgent({
          role: principalRole,
          grant: grantedAgentIds.has(agentId) ? { accessLevel: grantAccessLevel } : null,
        })
      },
      invokeEnterpriseTool: (input) => invokeEnterpriseTool(enterpriseDeps, input),
      getGatewayOperation: async (input) =>
        getResultToMcp(await getGatewayOperation(gatewayDeps, input)),
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

  await check('invalid token → 401, not audited (flood)', async () => {
    const { deps, audit } = runtimeDeps()
    const res = await post(
      'acme',
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { authorization: 'Bearer wrong' },
      deps,
    )
    assert.equal(res.status, 401)
    assert.equal(audit.some((row) => row.action === 'mcp.auth.deny'), false)
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
    assert.ok(audit.some((row) => row.action === 'mcp.auth.deny'))
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
    assert.ok(audit.some((row) => row.action === 'mcp.auth.deny'))
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
    assert.ok(audit.some((row) => row.action === 'mcp.auth.deny'))
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
    assert.ok(audit.some((row) => row.action === 'mcp.auth.deny'))
  })

  await check('Clerk not configured → 503 auth_not_configured', async () => {
    const { deps } = runtimeDeps({ clerkConfigured: false })
    const res = await post('acme', { jsonrpc: '2.0', id: 1, method: 'ping' }, {}, deps)
    assert.equal(res.status, 503)
    const body = (await readJson(res)) as { error: { code: string } }
    assert.equal(body.error.code, 'auth_not_configured')
  })

  await check('tools/list returns platform tools, Drive read+write, and gateway_operation.get', async () => {
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
      result?: {
        tools?: Array<{
          name: string
          description?: string
          inputSchema?: { properties?: Record<string, { type?: string }> }
        }>
      }
      error?: unknown
    }
    assert.equal(body.error, undefined, JSON.stringify(body))
    const tools = body.result?.tools ?? []
    const names = tools.map((tool) => tool.name)
    assert.deepEqual(names, [
      MCP_WHOAMI_TOOL,
      MCP_AGENTS_LIST_TOOL,
      MCP_AGENT_GET_DEFINITION_TOOL,
      GOOGLE_DRIVE_SEARCH_TOOL,
      GOOGLE_DRIVE_READ_FILE_TOOL,
      GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
      MCP_GATEWAY_OPERATION_GET_TOOL,
    ])
    const search = tools.find((tool) => tool.name === GOOGLE_DRIVE_SEARCH_TOOL)
    assert.ok(search, 'google_drive_search missing from tools/list')
    assert.match(search.description ?? '', /fileId/i)
    const schemaJson = JSON.stringify(search.inputSchema ?? {})
    assert.ok(schemaJson.length <= 16384, `search schema ${schemaJson.length} bytes exceeds Claude.ai drop limit`)
    for (const [field, spec] of Object.entries(search.inputSchema?.properties ?? {})) {
      assert.notEqual(spec.type, 'array', `${field} advertised as array`)
    }
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
          name: MCP_WHOAMI_TOOL,
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
    assert.equal(audit.filter((row) => row.action === 'mcp.auth.ok').length, 1)
    assert.ok(audit.some((row) => row.action === 'mcp.tools.call' && row.inputRef === MCP_WHOAMI_TOOL))
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
    assert.ok(audit.some((row) => row.action === 'mcp.tools.call.deny'))
  })

  await check('platform.agents.list ignores extra tenant keys', async () => {
    const { deps } = runtimeDeps({ role: 'admin' })
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: MCP_AGENTS_LIST_TOOL,
          arguments: { tenantId: 'attacker-tenant', tenantSlug: 'evil' },
        },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(res.status, 200)
    const body = (await readJson(res)) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
    }
    assert.equal(body.result?.isError, undefined)
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as {
      agents: Array<{ agentId: string }>
    }
    assert.equal(payload.agents[0]?.agentId, AGENT_ID)
  })

  await check('get_definition happy path and extra JSON cannot override tenant', async () => {
    const { deps } = runtimeDeps({ role: 'admin' })
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: MCP_AGENT_GET_DEFINITION_TOOL,
          arguments: {
            definitionId: DEFINITION_ID,
            tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
        },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(res.status, 200)
    const body = (await readJson(res)) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
    }
    assert.equal(body.result?.isError, undefined)
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as {
      definitionId?: string
      tenantId?: string
    }
    assert.equal(payload.definitionId, DEFINITION_ID)
    assert.equal(payload.tenantId, TENANT_ID)
  })

  await check('operator without ResourceGrant cannot list or get a definition', async () => {
    const { deps } = runtimeDeps({ role: 'operator' })
    await initialize(deps)
    const list = await post(
      'acme',
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: MCP_AGENTS_LIST_TOOL, arguments: {} } },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const listed = JSON.parse(
      ((await readJson(list)) as { result?: { content?: Array<{ text: string }> } }).result?.content?.[0]
        ?.text ?? '{}',
    ) as { agents: unknown[] }
    assert.deepEqual(listed.agents, [])

    const get = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: MCP_AGENT_GET_DEFINITION_TOOL, arguments: { definitionId: DEFINITION_ID } },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const body = (await readJson(get)) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
    }
    assert.equal(body.result?.isError, true)
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as { code?: string }
    assert.equal(payload.code, 'definition_not_found')
  })

  await check('operator with view grant can list and get definition', async () => {
    const { deps } = runtimeDeps({ role: 'operator', grantedAgentIds: new Set([AGENT_ID]) })
    await initialize(deps)
    const list = await post(
      'acme',
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: MCP_AGENTS_LIST_TOOL, arguments: {} } },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const listed = JSON.parse(
      ((await readJson(list)) as { result?: { content?: Array<{ text: string }> } }).result?.content?.[0]
        ?.text ?? '{}',
    ) as { agents: Array<{ agentId: string }> }
    assert.equal(listed.agents[0]?.agentId, AGENT_ID)

    const get = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: MCP_AGENT_GET_DEFINITION_TOOL, arguments: { definitionId: DEFINITION_ID } },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const body = (await readJson(get)) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
    }
    assert.equal(body.result?.isError, undefined)
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as { definitionId?: string }
    assert.equal(payload.definitionId, DEFINITION_ID)
  })

  await check('other-tenant definitionId → definition_not_found', async () => {
    const { deps } = runtimeDeps()
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: MCP_AGENT_GET_DEFINITION_TOOL,
          arguments: { definitionId: OTHER_DEFINITION_ID },
        },
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
    assert.equal(payload.code, 'definition_not_found')
  })

  await check('google_drive_search without grant returns authorizationUrl', async () => {
    const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?state=mcp-http'
    const { deps } = runtimeDeps({
      role: 'admin',
      liveGrant: null,
      startAuthorization: async () => ({ url: AUTH_URL }),
    })
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: GOOGLE_DRIVE_SEARCH_TOOL,
          arguments: { definitionId: DEFINITION_ID },
        },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(res.status, 200)
    const body = (await readJson(res)) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
    }
    assert.equal(body.result?.isError, true)
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as {
      code?: string
      authorizationUrl?: string
    }
    assert.equal(payload.code, 'connector_grant_missing')
    assert.equal(payload.authorizationUrl, AUTH_URL)
  })

  await check('google_drive_search happy path with stub client; extra JSON cannot override tenant', async () => {
    const { deps, seen, audit } = runtimeDeps({ role: 'admin' })
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: GOOGLE_DRIVE_SEARCH_TOOL,
          arguments: {
            definitionId: DEFINITION_ID,
            nameContains: 'Platform',
            tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
        },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(res.status, 200)
    const body = (await readJson(res)) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
    }
    assert.equal(body.result?.isError, undefined)
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as {
      files?: Array<{ id: string }>
    }
    assert.ok(Array.isArray(payload.files) && payload.files.length > 0)
    assert.equal((body.result?.content?.[0]?.text ?? '').includes('stub-drive-token'), false)
    assert.equal(seen.loadDefinitionTenantId, TENANT_ID)
    assert.equal(seen.findActiveGrantTenantId, TENANT_ID)
    assert.equal(seen.findActiveGrantUserId, USER_ID)
    assert.equal(seen.resolveTenantId, TENANT_ID)
    assert.equal(seen.resolveActingUserId, USER_ID)
    assert.ok(audit.some((row) => row.action === 'enterprise.tool.ok'))
  })

  await check('google_drive_read_file happy path with stub client', async () => {
    const { deps } = runtimeDeps({ role: 'admin' })
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: GOOGLE_DRIVE_READ_FILE_TOOL,
          arguments: { definitionId: DEFINITION_ID, fileId: 'stub-file-1' },
        },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(res.status, 200)
    const body = (await readJson(res)) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
    }
    assert.equal(body.result?.isError, undefined)
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as { text?: string }
    assert.equal(typeof payload.text, 'string')
  })

  await check('Drive tool without definitionId → definition_not_found', async () => {
    const { deps } = runtimeDeps({ role: 'admin' })
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: { name: GOOGLE_DRIVE_SEARCH_TOOL, arguments: { nameContains: 'Platform' } },
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
    assert.equal(payload.code, 'definition_not_found')
  })

  await check('wrong-tenant definitionId on Drive tool → definition_not_found', async () => {
    const { deps } = runtimeDeps({ role: 'admin' })
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: {
          name: GOOGLE_DRIVE_SEARCH_TOOL,
          arguments: { definitionId: OTHER_DEFINITION_ID },
        },
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
    assert.equal(payload.code, 'definition_not_found')
  })

  await check('operator with view grant cannot invoke Drive tools', async () => {
    const { deps } = runtimeDeps({
      role: 'operator',
      grantedAgentIds: new Set([AGENT_ID]),
      grantAccessLevel: 'view',
    })
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/call',
        params: {
          name: GOOGLE_DRIVE_SEARCH_TOOL,
          arguments: { definitionId: DEFINITION_ID },
        },
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
    assert.equal(payload.code, 'agent_access_denied')
  })

  await check('google_drive_create_folder enqueues awaiting_approval without writing', async () => {
    const { deps, audit } = runtimeDeps({ role: 'admin' })
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 17,
        method: 'tools/call',
        params: {
          name: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
          arguments: {
            definitionId: DEFINITION_ID,
            name: 'Q3 reports',
            idempotencyKey: 'idem-mcp-1',
          },
        },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(res.status, 200)
    const body = (await readJson(res)) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
    }
    assert.equal(body.result?.isError, undefined)
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as {
      operationId?: string
      status?: string
      idempotencyKey?: string
      toolName?: string
    }
    assert.equal(payload.status, 'awaiting_approval')
    assert.equal(payload.idempotencyKey, 'idem-mcp-1')
    assert.equal(payload.toolName, GOOGLE_DRIVE_CREATE_FOLDER_TOOL)
    assert.equal(typeof payload.operationId, 'string')

    const get = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 18,
        method: 'tools/call',
        params: {
          name: MCP_GATEWAY_OPERATION_GET_TOOL,
          arguments: { operationId: payload.operationId },
        },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const got = JSON.parse(
      ((await readJson(get)) as { result?: { content?: Array<{ text: string }> } }).result?.content?.[0]
        ?.text ?? '{}',
    ) as { status?: string; approval?: { decision?: string } }
    assert.equal(got.status, 'awaiting_approval')
    assert.equal(got.approval?.decision, 'pending')

    const replay = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 19,
        method: 'tools/call',
        params: {
          name: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
          arguments: {
            definitionId: DEFINITION_ID,
            name: 'Q3 reports',
            idempotencyKey: 'idem-mcp-1',
          },
        },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const replayed = JSON.parse(
      ((await readJson(replay)) as { result?: { content?: Array<{ text: string }> } }).result
        ?.content?.[0]?.text ?? '{}',
    ) as { operationId?: string; status?: string }
    assert.equal(replayed.operationId, payload.operationId)
    assert.equal(replayed.status, 'awaiting_approval')
    assert.equal(audit.filter((row) => row.action === 'gateway.operation.enqueued').length, 1)
  })

  await check('protected resource metadata resource is {origin}/api/mcp at every well-known path', async () => {
    const previous = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    const previousApp = process.env.NEXT_PUBLIC_APP_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from('clerk.example.com$').toString('base64url')}`
    delete process.env.NEXT_PUBLIC_APP_URL
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
      if (previousApp === undefined) delete process.env.NEXT_PUBLIC_APP_URL
      else process.env.NEXT_PUBLIC_APP_URL = previousApp
    }
  })

  console.log(`\n${failures === 0 ? 'mcp-http: ok' : `mcp-http: ${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

void main()
