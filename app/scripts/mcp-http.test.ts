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
import type { McpSkillPackage } from '../src/lib/skill/mcp-skill'
import { buildMcpSkillPackage } from '../src/lib/skill/mcp-skill'
import { hashAttachmentBytes } from '../src/lib/skill/skill-attachments'
import {
  canReadPublishedAgent,
  isPrivilegedAgentReader,
} from '../src/domain/agent-definition'
import {
  GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
  GOOGLE_DRIVE_READ_FILE_TOOL,
  GOOGLE_DRIVE_SEARCH_TOOL,
  KB_LIST_INDEX_TOOL,
  ENTERPRISE_TOOLS,
  invokeEnterpriseTool,
  type EnterpriseToolDeps,
  type LiveConnectorRow,
  type LiveGrantRow,
} from '../src/domain/enterprise-tools'
import {
  enqueueWriteForMcp,
  getGatewayOperation,
  getResultToMcp,
  type GatewayOperationServiceDeps,
} from '../src/domain/gateway-operation'
import { MemoryGatewayOperationStore } from './memory-gateway-operation-store'
import {
  MCP_AGENTS_LIST_TOOL,
  MCP_AGENT_CHECKOUT_TOOL,
  MCP_AGENT_CREATE_DRAFT_TOOL,
  MCP_AGENT_GET_DEFINITION_TOOL,
  MCP_AGENT_GET_WORKING_SET_TOOL,
  MCP_AGENT_PUBLISH_TOOL,
  MCP_GATEWAY_OPERATION_GET_TOOL,
  MCP_SKILLS_LIST_TOOL,
  MCP_SKILL_READ_TOOL,
  MCP_SKILL_SUBMIT_TOOL,
  MCP_WHOAMI_TOOL,
} from '../src/auth/mcp-principal'
import { PROJECT_WORK_TOOLS } from '../src/domain/project-work/mcp'
import { renderAgentBriefing } from '../src/lib/agent-checkout'
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
const FOREIGN_AGENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FOREIGN_DEFINITION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

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
  description: null,
  roleInstructionPreview: 'Inspect Drive',
  currentDefinitionId: DEFINITION_ID,
  currentVersion: 1,
}

const SCRIPT_TEXT = 'print("ok")\n'
const SAMPLE_SKILL = buildMcpSkillPackage({
  skillId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  skillVersionId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  name: 'tulajdoni-lap',
  description: 'Parse Hungarian land registry PDFs.',
  content: {
    instructions: ['Run scripts/parse_tulajdoni_lap.py'],
    triggerKeywords: [],
    parameters: [],
  },
  requires: [],
  attachments: [
    {
      path: 'scripts/parse_tulajdoni_lap.py',
      text: SCRIPT_TEXT,
      bytes: SCRIPT_TEXT.length,
      sha256: hashAttachmentBytes(new TextEncoder().encode(SCRIPT_TEXT)),
    },
  ],
})

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
  skills?: McpSkillPackage[]
  requestStateKey?: string
  driveCalls?: unknown[]
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
    if (input.definitionId === FOREIGN_DEFINITION_ID) {
      return { ...SAMPLE_DEFINITION, definitionId: FOREIGN_DEFINITION_ID, agentId: FOREIGN_AGENT_ID }
    }
    if (input.definitionId && input.definitionId !== DEFINITION_ID) return null
    if (!input.definitionId && input.agentId && input.agentId !== AGENT_ID) return null
    return SAMPLE_DEFINITION
  }
  const operations = new MemoryGatewayOperationStore()
  const gatewayDeps: GatewayOperationServiceDeps = {
    loadDefinition: ({ tenantId, definitionId }) => loadDefinition({ tenantId, definitionId }),
    async findCurrentDefinitionId() {
      return DEFINITION_ID
    },
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
    async executeDriveTool(_tool, args) {
      overrides.driveCalls?.push(args)
      return { file: { id: 'folder-1', name: 'Q3', mimeType: 'application/vnd.google-apps.folder' } }
    },
  }
  const enterpriseDeps: EnterpriseToolDeps = {
    loadDefinition: ({ tenantId, definitionId }) => loadDefinition({ tenantId, definitionId }),
    async findCurrentDefinitionId() {
      return DEFINITION_ID
    },
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
    enqueueWrite: (input) => enqueueWriteForMcp(gatewayDeps, input),
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
        async findById() {
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
      async loadSkillVersions() {
        return []
      },
      invokeEnterpriseTool: (input) => invokeEnterpriseTool(enterpriseDeps, input),
      requestStateKey: overrides.requestStateKey,
      getGatewayOperation: async (input) =>
        getResultToMcp(await getGatewayOperation(gatewayDeps, input)),
      async invokeProjectWork() {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] }
      },
      async listMcpSkills() {
        return overrides.skills ?? []
      },
      agentScaffold: {
        agents: {
          async create() {
            throw new Error('agentScaffold stub')
          },
          async findById() {
            return null
          },
          async updateProfile() {
            throw new Error('agentScaffold stub')
          },
          async replaceCapabilities() {},
          async findCapabilitiesForAgent() {
            return []
          },
          async findConnectorsForAgent() {
            return []
          },
          async upsertConnectorBinding() {},
          async setCurrentDefinitionVersionId() {
            throw new Error('agentScaffold stub')
          },
          async activate() {
            throw new Error('agentScaffold stub')
          },
        },
        versions: {
          async create() {
            throw new Error('agentScaffold stub')
          },
          async findById() {
            return null
          },
          async findByAgentAndVersion() {
            return null
          },
          async findMaxVersion() {
            return 0
          },
        },
        skills: {
          async findByNameInScope() {
            return null
          },
          async findById() {
            return null
          },
          async assign() {},
          async listEnabledForAgent() {
            return []
          },
        },
        connectors: {
          async listForTenant() {
            return []
          },
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

const STATE_KEY = 'k'.repeat(32)
const FOLDER_CALL_ARGS = { definitionId: DEFINITION_ID, name: 'Q3 reports', idempotencyKey: 'idem-mrtr' }

/** A stateless 2026-07-28 tools/call: no initialize, the envelope rides in `_meta` (#618). */
async function call2026(
  deps: McpRuntimeDeps,
  capabilities: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const res = await post(
    'acme',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
        arguments: FOLDER_CALL_ARGS,
        ...extra,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'mrtr-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': capabilities,
        },
      },
    },
    {
      authorization: `Bearer ${TOKEN}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
    },
    deps,
  )
  assert.equal(res.status, 200)
  return (await readJson(res)) as {
    result?: {
      resultType?: string
      isError?: boolean
      content?: Array<{ text: string }>
      inputRequests?: Record<string, { method: string; params: { mode: string } }>
      requestState?: string
    }
    error?: { code: number; message: string }
  }
}

function writerDeps(extra: { requestStateKey?: string; driveCalls?: unknown[] } = {}) {
  return runtimeDeps({
    role: 'operator',
    grantedAgentIds: new Set([AGENT_ID]),
    grantAccessLevel: 'operate',
    ...extra,
  })
}

async function main() {
  await check('#618 2026 + elicitation.form → input_required form', async () => {
    const { deps } = writerDeps({ requestStateKey: STATE_KEY })
    const body = await call2026(deps, { elicitation: { form: {} } })
    assert.equal(body.result?.resultType, 'input_required')
    assert.equal(body.result?.inputRequests?.confirm_write?.method, 'elicitation/create')
    assert.equal(body.result?.inputRequests?.confirm_write?.params.mode, 'form')
    assert.match(body.result?.requestState ?? '', /^v1\./)
  })

  await check('#618 2026 + empty elicitation {} → input_required (form is the default mode)', async () => {
    const { deps } = writerDeps({ requestStateKey: STATE_KEY })
    const body = await call2026(deps, { elicitation: {} })
    assert.equal(body.result?.resultType, 'input_required')
  })

  for (const [label, capabilities, key] of [
    ['2026 + url-only elicitation', { elicitation: { url: {} } }, STATE_KEY],
    ['2026 without elicitation', {}, STATE_KEY],
    ['missing MCP_REQUEST_STATE_KEY', { elicitation: { form: {} } }, undefined],
    ['too-short MCP_REQUEST_STATE_KEY', { elicitation: { form: {} } }, 'short'],
  ] as const) {
    await check(`#618 ${label} → link, not isError`, async () => {
      const { deps } = writerDeps({ requestStateKey: key })
      const body = await call2026(deps, capabilities)
      assert.equal(body.result?.resultType, 'complete')
      assert.equal(body.result?.isError, undefined)
      const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as {
        status?: string
        approvalUrl?: string
      }
      assert.equal(payload.status, 'awaiting_approval')
      assert.match(payload.approvalUrl ?? '', /\/control-plane\/operations#/)
    })
  }

  await check('#618 form round-trip approve → one Drive call, succeeded', async () => {
    const driveCalls: unknown[] = []
    const { deps, audit } = writerDeps({ requestStateKey: STATE_KEY, driveCalls })
    const first = await call2026(deps, { elicitation: { form: {} } })
    const requestState = first.result?.requestState
    assert.ok(requestState)
    const retry = await call2026(
      deps,
      { elicitation: { form: {} } },
      {
        inputResponses: { confirm_write: { action: 'accept', content: { decision: 'approve' } } },
        requestState,
      },
    )
    assert.equal(retry.result?.resultType, 'complete')
    const payload = JSON.parse(retry.result?.content?.[0]?.text ?? '{}') as { status?: string }
    assert.equal(payload.status, 'succeeded')
    assert.equal(driveCalls.length, 1)
    const approved = audit.find((row) => row.action === 'gateway.operation.approved') as
      | { metadata?: Record<string, unknown> }
      | undefined
    assert.equal(approved?.metadata?.channel, 'mcp_form')
    assert.equal(approved?.metadata?.selfDecided, true)
  })

  await check('#618 forged requestState → -32602, nothing executed', async () => {
    const driveCalls: unknown[] = []
    const { deps } = writerDeps({ requestStateKey: STATE_KEY, driveCalls })
    const first = await call2026(deps, { elicitation: { form: {} } })
    const [v, body, mac] = (first.result?.requestState ?? '').split('.')
    const forged = `${v}.${body}.${mac?.startsWith('A') ? 'B' : 'A'}${mac?.slice(1)}`
    const retry = await call2026(
      deps,
      { elicitation: { form: {} } },
      {
        inputResponses: { confirm_write: { action: 'accept', content: { decision: 'approve' } } },
        requestState: forged,
      },
    )
    assert.equal(retry.error?.code, -32602)
    assert.equal(driveCalls.length, 0)
  })

  await check('#618 2025 session with key configured still gets the link', async () => {
    const { deps } = writerDeps({ requestStateKey: STATE_KEY })
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: GOOGLE_DRIVE_CREATE_FOLDER_TOOL, arguments: FOLDER_CALL_ARGS },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const body = (await readJson(res)) as {
      result?: { resultType?: string; isError?: boolean; content?: Array<{ text: string }> }
    }
    assert.notEqual(body.result?.resultType, 'input_required')
    assert.equal(body.result?.isError, undefined)
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as { status?: string }
    assert.equal(payload.status, 'awaiting_approval')
  })

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

  await check('initialize returns tenant-aware instructions and server name', async () => {
    const { deps } = runtimeDeps({
      tenant: tenant({
        displayName: 'Acme',
        legalName: 'Acme Corp.',
        settings: { mcpIntro: 'Widget maker tenant.' },
      }),
      grantedAgentIds: new Set([AGENT_ID]),
    })
    const init = await initialize(deps)
    assert.equal(init.status, 200)
    const body = (await readJson(init)) as {
      result?: { serverInfo?: { name?: string }; instructions?: string }
    }
    assert.equal(body.result?.serverInfo?.name, 'Acme · Excellence AI')
    assert.match(body.result?.instructions ?? '', /Acme Corp\./)
    assert.match(body.result?.instructions ?? '', /Widget maker tenant\./)
    assert.match(body.result?.instructions ?? '', /Drive assistant/)
  })

  await check('tools/list returns platform tools, Drive, knowledge base, and gateway_operation.get', async () => {
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
      MCP_AGENT_CHECKOUT_TOOL,
      MCP_AGENT_CREATE_DRAFT_TOOL,
      MCP_AGENT_GET_WORKING_SET_TOOL,
      MCP_AGENT_PUBLISH_TOOL,
      MCP_SKILLS_LIST_TOOL,
      MCP_SKILL_READ_TOOL,
      MCP_SKILL_SUBMIT_TOOL,
      ...PROJECT_WORK_TOOLS,
      ...ENTERPRISE_TOOLS,
      MCP_GATEWAY_OPERATION_GET_TOOL,
    ])
    const submit = tools.find((tool) => tool.name === MCP_SKILL_SUBMIT_TOOL)
    assert.equal(submit?.inputSchema?.properties?.requires?.type, 'string')
    assert.equal(submit?.inputSchema?.properties?.attachments?.type, 'string')
    const search = tools.find((tool) => tool.name === GOOGLE_DRIVE_SEARCH_TOOL)
    assert.ok(search, 'google_drive_search missing from tools/list')
    assert.match(search.description ?? '', /fileId/i)
    const schemaJson = JSON.stringify(search.inputSchema ?? {})
    assert.ok(schemaJson.length <= 16384, `search schema ${schemaJson.length} bytes exceeds Claude.ai drop limit`)
    for (const tool of tools) {
      for (const [field, spec] of Object.entries(tool.inputSchema?.properties ?? {})) {
        assert.notEqual(spec.type, 'array', `${tool.name}.${field} advertised as array`)
      }
    }
  })

  await check('platform.whoami returns principal JSON and ignores extra args', async () => {
    const { deps, audit } = runtimeDeps({ grantedAgentIds: new Set([AGENT_ID]) })
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
      tenantDisplayName: 'Acme',
      tenantLegalName: null,
      organizationLabel: 'Acme',
      mcpIntro: null,
      coworkers: [PUBLISHED_LIST_ITEM],
    })
    assert.equal(audit.filter((row) => row.action === 'mcp.auth.ok').length, 1)
    assert.ok(audit.some((row) => row.action === 'mcp.tools.call' && row.inputRef === MCP_WHOAMI_TOOL))
  })

  await check('skill catalog is available through tools/list and tools/call', async () => {
    const { deps, audit } = runtimeDeps({ skills: [SAMPLE_SKILL] })
    await initialize(deps)

    const listed = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 35,
        method: 'tools/call',
        params: { name: MCP_SKILLS_LIST_TOOL, arguments: {} },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const listBody = (await readJson(listed)) as {
      result?: { content?: Array<{ text: string }>; isError?: boolean }
    }
    assert.equal(listBody.result?.isError, undefined)
    const listPayload = JSON.parse(listBody.result?.content?.[0]?.text ?? '{}') as {
      skills?: Array<{ uri?: string; resources?: Array<{ uri: string }> }>
    }
    const entry = listPayload.skills?.[0]
    assert.equal(entry?.uri, 'skill://tulajdoni-lap/SKILL.md')
    const scriptUri = entry?.resources?.find((resource) =>
      resource.uri.endsWith('scripts/parse_tulajdoni_lap.py'),
    )?.uri
    assert.ok(scriptUri)

    const read = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 36,
        method: 'tools/call',
        params: { name: MCP_SKILL_READ_TOOL, arguments: { uri: scriptUri } },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const readBody = (await readJson(read)) as {
      result?: { content?: Array<{ text: string }>; isError?: boolean }
    }
    assert.equal(readBody.result?.isError, undefined)
    const readPayload = JSON.parse(readBody.result?.content?.[0]?.text ?? '{}') as {
      contents?: Array<{ text?: string; mimeType?: string; uri?: string }>
    }
    assert.deepEqual(readPayload.contents?.[0], {
      uri: scriptUri,
      mimeType: 'text/x-python',
      text: SCRIPT_TEXT,
    })
    assert.ok(audit.some((row) => row.action === 'mcp.tools.call' && row.inputRef === MCP_SKILL_READ_TOOL))
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
      contentHash?: string
    }
    assert.equal(payload.definitionId, DEFINITION_ID)
    assert.equal(payload.tenantId, TENANT_ID)
    assert.match(payload.contentHash ?? '', /^[0-9a-f]{64}$/)
  })

  await check('get_definition carries general memory; denied memory read is omitted', async () => {
    const { deps } = runtimeDeps({ role: 'admin' })
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
    let denied = false
    deps.invokeProjectWork = async ({ toolName, args }) => {
      calls.push({ toolName, args })
      if (denied) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'agent_access_denied' }) }] }
      }
      const items = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, title: `fact ${i}`, body: 'x'.repeat(100) }))
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, items }) }] }
    }
    await initialize(deps)
    const getDefinition = async (id: number) => {
      const res = await post(
        'acme',
        {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: MCP_AGENT_GET_DEFINITION_TOOL, arguments: { definitionId: DEFINITION_ID } },
        },
        { authorization: `Bearer ${TOKEN}` },
        deps,
      )
      const body = (await readJson(res)) as { result?: { isError?: boolean; content?: Array<{ text: string }> } }
      assert.equal(body.result?.isError, undefined)
      return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as {
        definitionId?: string
        generalMemory?: { items: Array<{ id: string }>; truncated: boolean; note: string }
      }
    }

    const payload = await getDefinition(60)
    assert.equal(calls[0]?.toolName, 'platform.project_memory.read')
    assert.deepEqual(calls[0]?.args, { definitionId: DEFINITION_ID })
    assert.equal(payload.generalMemory?.items[0]?.id, 'm0')
    assert.equal(payload.generalMemory?.truncated, true)
    assert.ok((payload.generalMemory?.items.length ?? 0) <= 40)
    assert.match(payload.generalMemory?.note ?? '', /overrides search results/)

    denied = true
    const withoutMemory = await getDefinition(61)
    assert.equal(withoutMemory.definitionId, DEFINITION_ID)
    assert.equal(withoutMemory.generalMemory, undefined)
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

  await check('checkout writes AGENTS.md with roleInstruction and mcpUrl; extra JSON cannot override tenant', async () => {
    const { deps, audit } = runtimeDeps({ role: 'admin' })
    await initialize(deps)
    const res = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: MCP_AGENT_CHECKOUT_TOOL,
          arguments: {
            agentId: AGENT_ID,
            tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            tenantSlug: 'evil',
            harness: 'codex',
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
      mcpUrl?: string
      pin?: { agentId?: string; harness?: string | null; tenantSlug?: string }
      files?: Array<{ path: string; content: string }>
    }
    assert.equal(payload.mcpUrl, `${ORIGIN}/api/mcp/acme`)
    assert.equal(payload.pin?.tenantSlug, 'acme')
    assert.equal(payload.pin?.agentId, AGENT_ID)
    assert.equal(payload.pin?.harness, 'codex')
    const agents = payload.files?.find((file) => file.path === 'AGENTS.md')
    assert.ok(agents?.content.includes('Inspect Drive'))
    assert.ok(agents?.content.includes(`${ORIGIN}/api/mcp/acme`))
    assert.ok(
      audit.some((row) => row.action === 'mcp.tools.call' && row.inputRef === MCP_AGENT_CHECKOUT_TOOL),
    )
  })

  await check('checkout invalid agentId → invalid_args; no grant / inactive → definition_not_found', async () => {
    const denied = runtimeDeps({ role: 'operator' })
    await initialize(denied.deps)
    const invalid = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: MCP_AGENT_CHECKOUT_TOOL, arguments: { agentId: 'not-a-uuid' } },
      },
      { authorization: `Bearer ${TOKEN}` },
      denied.deps,
    )
    const invalidBody = (await readJson(invalid)) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
    }
    assert.equal(invalidBody.result?.isError, true)
    assert.equal(
      JSON.parse(invalidBody.result?.content?.[0]?.text ?? '{}').code,
      'invalid_args',
    )

    const noGrant = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: MCP_AGENT_CHECKOUT_TOOL, arguments: { agentId: AGENT_ID } },
      },
      { authorization: `Bearer ${TOKEN}` },
      denied.deps,
    )
    assert.equal(
      JSON.parse(
        ((await readJson(noGrant)) as { result?: { content?: Array<{ text: string }> } }).result
          ?.content?.[0]?.text ?? '{}',
      ).code,
      'definition_not_found',
    )

    const inactive = runtimeDeps({ role: 'admin' })
    inactive.deps.loadDefinition = async () => ({ ...SAMPLE_DEFINITION, status: 'draft' })
    await initialize(inactive.deps)
    const draft = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: { name: MCP_AGENT_CHECKOUT_TOOL, arguments: { agentId: AGENT_ID } },
      },
      { authorization: `Bearer ${TOKEN}` },
      inactive.deps,
    )
    assert.equal(
      JSON.parse(
        ((await readJson(draft)) as { result?: { content?: Array<{ text: string }> } }).result
          ?.content?.[0]?.text ?? '{}',
      ).code,
      'definition_not_found',
    )
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
        id: 24,
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

  async function callWithAgentHeader(
    deps: McpRuntimeDeps,
    name: string,
    args: Record<string, unknown>,
    agentHeader: string,
  ) {
    const res = await post(
      'acme',
      { jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name, arguments: args } },
      { authorization: `Bearer ${TOKEN}`, 'x-excellence-agent-id': agentHeader },
      deps,
    )
    assert.equal(res.status, 200)
    const body = (await readJson(res)) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
    }
    return {
      isError: body.result?.isError,
      payload: JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>,
    }
  }

  await check('#682 agent header only → current definition, audit records the agent', async () => {
    const { deps, audit } = runtimeDeps({ role: 'admin' })
    await initialize(deps)
    const out = await callWithAgentHeader(deps, GOOGLE_DRIVE_SEARCH_TOOL, { nameContains: 'x' }, AGENT_ID)
    assert.equal(out.isError, undefined)
    const ok = audit.find((row) => row.action === 'enterprise.tool.ok')
    assert.ok(ok)
    assert.ok(JSON.stringify(ok).includes(DEFINITION_ID))
    const def = await callWithAgentHeader(deps, MCP_AGENT_GET_DEFINITION_TOOL, {}, AGENT_ID)
    assert.equal(def.payload.definitionId, DEFINITION_ID)
  })

  await check('#682 agent header + matching definitionId → OK', async () => {
    const { deps } = runtimeDeps({ role: 'admin' })
    await initialize(deps)
    const out = await callWithAgentHeader(
      deps,
      GOOGLE_DRIVE_SEARCH_TOOL,
      { definitionId: DEFINITION_ID },
      AGENT_ID,
    )
    assert.equal(out.isError, undefined)
  })

  await check('#682 agent header + other agent definitionId / agentId → agent_mismatch, audited', async () => {
    const { deps, audit } = runtimeDeps({ role: 'admin' })
    await initialize(deps)
    const out = await callWithAgentHeader(
      deps,
      GOOGLE_DRIVE_SEARCH_TOOL,
      { definitionId: FOREIGN_DEFINITION_ID },
      AGENT_ID,
    )
    assert.equal(out.isError, true)
    assert.equal(out.payload.code, 'agent_mismatch')
    const def = await callWithAgentHeader(
      deps,
      MCP_AGENT_GET_DEFINITION_TOOL,
      { agentId: FOREIGN_AGENT_ID },
      AGENT_ID,
    )
    assert.equal(def.payload.code, 'agent_mismatch')
    assert.ok(
      audit.some(
        (row) =>
          row.action === 'mcp.tools.call.deny' &&
          (row.metadata as { code?: string }).code === 'agent_mismatch',
      ),
    )
    assert.equal(audit.some((row) => row.action === 'enterprise.tool.ok'), false)
  })

  await check('#682 unknown / other-tenant / malformed agent header → agent_not_found, audited', async () => {
    const { deps, audit } = runtimeDeps({ role: 'admin' })
    await initialize(deps)
    for (const header of [FOREIGN_AGENT_ID, 'not-a-uuid']) {
      const out = await callWithAgentHeader(deps, GOOGLE_DRIVE_SEARCH_TOOL, {}, header)
      assert.equal(out.isError, true)
      assert.equal(out.payload.code, 'agent_not_found')
    }
    assert.equal(
      audit.filter(
        (row) =>
          row.action === 'mcp.tools.call.deny' &&
          (row.metadata as { code?: string }).code === 'agent_not_found',
      ).length,
      2,
    )
  })

  await check('#682 agent header after access is revoked → agent_not_found', async () => {
    const { deps } = runtimeDeps({ role: 'operator', grantedAgentIds: new Set() })
    await initialize(deps)
    const out = await callWithAgentHeader(deps, KB_LIST_INDEX_TOOL, {}, AGENT_ID)
    assert.equal(out.payload.code, 'agent_not_found')
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

  await check('skills/list is empty when the tenant has no active skills', async () => {
    const { deps } = runtimeDeps()
    await initialize(deps)
    const res = await post(
      'acme',
      { jsonrpc: '2.0', id: 30, method: 'skills/list', params: {} },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    assert.equal(res.status, 200)
    const body = (await readJson(res)) as { result?: { skills?: unknown[] }; error?: unknown }
    assert.equal(body.error, undefined, JSON.stringify(body))
    assert.deepEqual(body.result?.skills, [])
  })

  await check('skills/list and resources/read serve SKILL.md plus scripts', async () => {
    const { deps, audit } = runtimeDeps({ skills: [SAMPLE_SKILL] })
    await initialize(deps)
    const listed = await post(
      'acme',
      { jsonrpc: '2.0', id: 31, method: 'skills/list', params: {} },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const listBody = (await readJson(listed)) as {
      result?: {
        skills?: Array<{
          uri: string
          frontmatter?: { name?: string }
          resources?: Array<{ uri: string; digest: string }>
        }>
      }
      error?: unknown
    }
    assert.equal(listBody.error, undefined, JSON.stringify(listBody))
    const entry = listBody.result?.skills?.[0]
    assert.equal(entry?.uri, 'skill://tulajdoni-lap/SKILL.md')
    assert.equal(entry?.frontmatter?.name, 'tulajdoni-lap')
    const scriptUri = entry?.resources?.find((resource) =>
      resource.uri.endsWith('scripts/parse_tulajdoni_lap.py'),
    )
    assert.ok(scriptUri, 'script resource missing from skills/list')
    assert.match(scriptUri.digest, /^sha256:[0-9a-f]{64}$/)

    const got = await post(
      'acme',
      { jsonrpc: '2.0', id: 32, method: 'skills/get', params: { uri: entry?.uri } },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const gotBody = (await readJson(got)) as { result?: { uri?: string }; error?: unknown }
    assert.equal(gotBody.error, undefined, JSON.stringify(gotBody))
    assert.equal(gotBody.result?.uri, entry?.uri)

    const read = await post(
      'acme',
      {
        jsonrpc: '2.0',
        id: 33,
        method: 'resources/read',
        params: { uri: 'skill://tulajdoni-lap/scripts/parse_tulajdoni_lap.py' },
      },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const readBody = (await readJson(read)) as {
      result?: { contents?: Array<{ text?: string; mimeType?: string; uri?: string }> }
      error?: unknown
    }
    assert.equal(readBody.error, undefined, JSON.stringify(readBody))
    assert.equal(readBody.result?.contents?.[0]?.text, SCRIPT_TEXT)
    assert.equal(readBody.result?.contents?.[0]?.mimeType, 'text/x-python')
    assert.ok(
      audit.some(
        (row) =>
          row.action === 'mcp.resources.read' &&
          row.inputRef === 'skill://tulajdoni-lap/scripts/parse_tulajdoni_lap.py',
      ),
    )

    const resources = await post(
      'acme',
      { jsonrpc: '2.0', id: 37, method: 'resources/list', params: {} },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const resourcesBody = (await readJson(resources)) as {
      result?: { resources?: Array<{ uri: string; mimeType?: string }> }
      error?: unknown
    }
    assert.equal(resourcesBody.error, undefined, JSON.stringify(resourcesBody))
    assert.ok(
      resourcesBody.result?.resources?.some(
        (resource) => resource.uri === 'skill://tulajdoni-lap/SKILL.md',
      ),
    )
  })

  await check('skills/get unknown uri → JSON-RPC error', async () => {
    const { deps } = runtimeDeps()
    await initialize(deps)
    const res = await post(
      'acme',
      { jsonrpc: '2.0', id: 34, method: 'skills/get', params: { uri: 'skill://missing/SKILL.md' } },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    const body = (await readJson(res)) as { error?: { message?: string } }
    assert.ok(body.error, JSON.stringify(body))
    assert.match(body.error?.message ?? '', /not found/i)
  })

  async function listPrompts(deps: McpRuntimeDeps) {
    const res = await post(
      'acme',
      { jsonrpc: '2.0', id: 40, method: 'prompts/list', params: {} },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    return (await readJson(res)) as {
      result?: { prompts?: Array<{ name: string; title?: string; arguments?: Array<{ name: string }> }> }
      error?: unknown
    }
  }

  async function getPrompt(deps: McpRuntimeDeps, args: Record<string, string> = {}) {
    const res = await post(
      'acme',
      { jsonrpc: '2.0', id: 41, method: 'prompts/get', params: { name: 'drive-assistant', arguments: args } },
      { authorization: `Bearer ${TOKEN}` },
      deps,
    )
    return (await readJson(res)) as {
      result?: { messages?: Array<{ role: string; content: { type: string; text: string } }> }
      error?: { message?: string }
    }
  }

  await check('#651 visible agent → /drive-assistant prompt in its role, with feladat, audited', async () => {
    const { deps, audit } = runtimeDeps({ role: 'operator', grantedAgentIds: new Set([AGENT_ID]) })
    const list = await listPrompts(deps)
    assert.equal(list.error, undefined, JSON.stringify(list))
    const prompt = list.result?.prompts?.find((row) => row.name === 'drive-assistant')
    assert.ok(prompt, JSON.stringify(list))
    assert.equal(prompt.title, 'Drive assistant (Inspect Drive)')
    assert.deepEqual(prompt.arguments?.map((row) => row.name), ['feladat'])

    const body = await getPrompt(deps, { feladat: 'Q3 riport' })
    assert.equal(body.error, undefined, JSON.stringify(body))
    const text = body.result?.messages?.[0]?.content.text ?? ''
    assert.equal(body.result?.messages?.[0]?.role, 'user')
    assert.match(text, /^You are now Drive assistant\./)
    assert.match(text, /Do not ask which agent to use/)
    assert.ok(text.includes(renderAgentBriefing({ snapshot: SAMPLE_DEFINITION.snapshot, skills: [] }).join('\n')))
    assert.match(text, /## Today's task\n\nQ3 riport\n$/)
    assert.ok(
      audit.some(
        (row) =>
          row.action === 'mcp.prompts.get' &&
          row.inputRef === 'drive-assistant' &&
          (row.metadata as { agentId?: string }).agentId === AGENT_ID,
      ),
    )
  })

  await check('#651 prompt follows the current published definition', async () => {
    const { deps } = runtimeDeps({ role: 'admin' })
    const before = (await getPrompt(deps)).result?.messages?.[0]?.content.text ?? ''
    assert.match(before, /version 1\)/)
    deps.loadDefinition = async () => ({
      ...SAMPLE_DEFINITION,
      definitionId: OTHER_DEFINITION_ID,
      version: 2,
      snapshot: { ...SAMPLE_DEFINITION.snapshot, roleInstruction: 'Inspect Drive, v2 rules' },
    })
    const after = (await getPrompt(deps)).result?.messages?.[0]?.content.text ?? ''
    assert.match(after, /version 2\)/)
    assert.match(after, /Inspect Drive, v2 rules/)
    assert.ok(!after.includes(`definitionId: ${DEFINITION_ID}`))
  })

  await check('#651 agent not visible to the user → no prompt listed, prompts/get fails', async () => {
    const { deps } = runtimeDeps({ role: 'operator' })
    const list = await listPrompts(deps)
    assert.ok(!list.result?.prompts?.some((row) => row.name === 'drive-assistant'), JSON.stringify(list))
    const body = await getPrompt(deps)
    assert.ok(body.error, JSON.stringify(body))
    assert.equal(body.result, undefined)
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
