/**
 * Agent Scaffold MCP — create_draft / get_working_set / publish (#584).
 * Futtatás: npm run test:agent-scaffold-mcp
 */
import assert from 'node:assert/strict'
import type {
  Agent,
  AgentDefinitionVersion,
  AgentSkill,
  Connector,
  Prisma,
  Skill,
  SkillVersion,
} from '@prisma/client'
import { handleMcpRequest, type McpRuntimeDeps } from '../src/auth/mcp-server'
import {
  MCP_AGENT_CREATE_DRAFT_TOOL,
  MCP_AGENT_GET_WORKING_SET_TOOL,
  MCP_AGENT_PUBLISH_TOOL,
  MCP_AGENTS_LIST_TOOL,
} from '../src/auth/mcp-principal'
import { AgentDefinitionService, hashSnapshot } from '../src/domain/agent-definition'
import {
  createDraftAgent,
  publishAgentWorkingSet,
  type AgentScaffoldDeps,
} from '../src/domain/agent-scaffold'
import { isAvailableOnMcp } from '../src/lib/agent-lifecycle'

const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333333'
const SKILL_ID = '44444444-4444-4444-8444-444444444444'
const SKILL_VERSION_ID = '55555555-5555-4555-8555-555555555555'
const CONNECTOR_ID = '66666666-6666-4666-8666-666666666666'
const ORIGIN = 'https://app.example.com'
const TOKEN = 'oauth-access-token'
let nextAgentSuffix = 1

function nextAgentId(): string {
  const suffix = String(nextAgentSuffix++).padStart(12, '0')
  return `a0000000-0000-4000-8000-${suffix}`
}

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

function agentRow(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tenantId: TENANT_ID,
    name: 'Wiki helper',
    roleInstruction: 'Answer from the knowledge base only.',
    description: 'Internal wiki',
    status: 'draft',
    currentDefinitionVersionId: null,
    avatarUrl: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    retiredAt: null,
    ...overrides,
  }
}

function memoryScaffoldDeps(opts?: {
  skillName?: string
  connectorName?: string
  connectorActive?: boolean
}) {
  const agents = new Map<string, Agent>()
  const versions: AgentDefinitionVersion[] = []
  const bindings: Array<{ agentId: string; connectorId: string; accessMode: 'read' | 'write' }> = []
  let publishCalls = 0
  let activateCalls = 0

  const skill: Skill = {
    id: SKILL_ID,
    name: opts?.skillName ?? 'wiki-qa',
    displayName: 'Wiki QA',
    description: 'Wiki answers',
    catalogScope: 'tenant',
    tenantId: TENANT_ID,
    kind: 'tenant',
    sourceType: 'authored',
    provenance: null,
    license: null,
    riskTier: 't0',
    createdAt: new Date(),
  }
  const skillVersion: SkillVersion = {
    id: SKILL_VERSION_ID,
    skillId: SKILL_ID,
    version: 1,
    content: {},
    requires: [],
    attachments: null,
    status: 'active',
    contentHash: 'abc',
    approvedById: USER_ID,
    createdAt: new Date(),
  }
  const connector: Connector = {
    id: CONNECTOR_ID,
    tenantId: TENANT_ID,
    type: 'http_api',
    name: opts?.connectorName ?? 'CRM API',
    authMode: 'service',
    scope: 'single',
    secretAlias: null,
    version: 1,
    config: {},
    lifecycleState: opts?.connectorActive === false ? 'archived' : 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const deps: AgentScaffoldDeps = {
    agents: {
      async create(input) {
        const row = agentRow({
          id: nextAgentId(),
          name: input.name,
          roleInstruction: input.roleInstruction,
          tenantId: input.tenantId,
          status: input.status ?? 'draft',
        })
        agents.set(row.id, row)
        return row
      },
      async findById(id, tenantId) {
        const row = agents.get(id) ?? null
        if (!row) return null
        if (tenantId && row.tenantId !== tenantId) return null
        return row
      },
      async updateProfile({ agentId, description, name }) {
        const row = agents.get(agentId)
        if (!row) throw new Error('missing')
        const next = {
          ...row,
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
        }
        agents.set(agentId, next)
        return next
      },
      async replaceCapabilities(agentId, toolNames) {
        const caps = toolNames.map((toolName) => ({ toolName, allowed: true }))
        ;(deps.agents as { caps?: Map<string, { toolName: string; allowed: boolean }[]> }).caps =
          (deps.agents as { caps?: Map<string, { toolName: string; allowed: boolean }[]> }).caps ??
          new Map()
        ;(deps.agents as { caps: Map<string, { toolName: string; allowed: boolean }[]> }).caps.set(
          agentId,
          caps,
        )
      },
      async findCapabilitiesForAgent(agentId) {
        const caps =
          (deps.agents as { caps?: Map<string, { toolName: string; allowed: boolean }[]> }).caps
        return caps?.get(agentId) ?? []
      },
      async findConnectorsForAgent(agentId) {
        return bindings
          .filter((row) => row.agentId === agentId)
          .map((row) => ({
            accessMode: row.accessMode,
            connector,
          }))
      },
      async upsertConnectorBinding(input) {
        const idx = bindings.findIndex(
          (row) => row.agentId === input.agentId && row.connectorId === input.connectorId,
        )
        const next = {
          agentId: input.agentId,
          connectorId: input.connectorId,
          accessMode: input.accessMode,
        }
        if (idx >= 0) bindings[idx] = next
        else bindings.push(next)
      },
      async setCurrentDefinitionVersionId(agentId, versionId) {
        const row = agents.get(agentId)
        if (!row) throw new Error('missing')
        const next = { ...row, currentDefinitionVersionId: versionId }
        agents.set(agentId, next)
        return next
      },
      async activate(agentId) {
        activateCalls++
        const row = agents.get(agentId)
        if (!row) throw new Error('missing')
        const next = { ...row, status: 'active' as const }
        agents.set(agentId, next)
        return next
      },
    },
    versions: {
      async create(data) {
        publishCalls++
        const row: AgentDefinitionVersion = {
          id: `def-${data.version}`,
          agentId: data.agentId,
          version: data.version,
          snapshot: data.snapshot as Prisma.JsonValue,
          contentHash: data.contentHash,
          publishedById: data.publishedById,
          publishedAt: new Date('2026-01-02T00:00:00Z'),
        }
        versions.push(row)
        return row
      },
      async findById(id) {
        return versions.find((row) => row.id === id) ?? null
      },
      async findByAgentAndVersion(agentId, version) {
        return versions.find((row) => row.agentId === agentId && row.version === version) ?? null
      },
      async findMaxVersion(agentId) {
        return versions.filter((row) => row.agentId === agentId).reduce((max, row) => Math.max(max, row.version), 0)
      },
    },
    skills: {
      async findByNameInScope(name, tenantId) {
        if (tenantId !== null && tenantId !== TENANT_ID) return null
        return name.toLowerCase() === skill.name.toLowerCase() ? skill : null
      },
      async findById(id) {
        return id === SKILL_ID ? { ...skill, versions: [skillVersion] } : null
      },
      async assign(input) {
        const assignment: AgentSkill = {
          agentId: input.agentId,
          skillVersionId: input.skillVersionId,
          enabled: true,
          entry: false,
          assignedById: input.assignedById,
          createdAt: new Date(),
        }
        ;(deps.skills as { rows?: AgentSkill[] }).rows = (
          deps.skills as { rows?: AgentSkill[] }
        ).rows ?? []
        ;(deps.skills as { rows: AgentSkill[] }).rows.push(assignment)
      },
      async listEnabledForAgent(agentId) {
        const rows = (deps.skills as { rows?: AgentSkill[] }).rows ?? []
        return rows
          .filter((row) => row.agentId === agentId && row.enabled)
          .map((row) => ({
            ...row,
            skillVersion: { ...skillVersion, skill },
          }))
      },
    },
    connectors: {
      async listForTenant(tenantId) {
        return tenantId === TENANT_ID ? [connector] : []
      },
    },
  }

  const service = new AgentDefinitionService({
    agents: deps.agents,
    versions: deps.versions,
    skills: deps.skills,
  })

  return {
    deps,
    agents,
    versions,
    service,
    get publishCalls() {
      return publishCalls
    },
    get activateCalls() {
      return activateCalls
    },
    resetCounters() {
      publishCalls = 0
      activateCalls = 0
    },
  }
}

function stubMcpDeps(
  memory: ReturnType<typeof memoryScaffoldDeps>,
  role: 'admin' | 'approver' | 'operator',
  assumed = false,
): McpRuntimeDeps {
  const scaffold = memory.deps
  const audit: Array<Record<string, unknown>> = []
  const auditSink = {
    async append(data: Record<string, unknown>) {
      audit.push(data)
    },
  }
  return {
    isClerkConfigured: () => true,
    resolveOrigin: () => ORIGIN,
    async verifyOAuthToken(token) {
      return token === TOKEN ? { clerkUserId: 'clerk-user' } : null
    },
    users: {
      async findByExternalAuthId() {
        return {
          id: USER_ID,
          externalAuthId: 'clerk-user',
          email: 'admin@test',
          name: 'Admin',
          role: 'admin',
          status: 'active',
          invitedById: null,
          activatedAt: new Date(),
          suspendedAt: null,
          suspendedById: null,
          suspendedReason: null,
          lastLoginAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      },
    },
    tenants: {
      async findBySlug() {
        return {
          id: TENANT_ID,
          slug: 'acme',
          displayName: 'Acme',
          legalName: null,
          status: 'active',
          domainAllowlist: [],
          settings: {},
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      },
      async findById(id: string) {
        if (id !== TENANT_ID) return null
        return {
          id: TENANT_ID,
          slug: 'acme',
          displayName: 'Acme',
          legalName: null,
          status: 'active',
          domainAllowlist: [],
          settings: {},
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      },
    },
    memberships: {
      async findByTenantAndUser() {
        return {
          id: 'mem-1',
          tenantId: TENANT_ID,
          userId: USER_ID,
          role,
          status: 'active',
          isDefault: true,
          invitedById: null,
          activatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      },
    },
    platformMemberships: { async findByUser() { return [] } },
    audit: auditSink,
    async listPublishedAgents() {
      return [...memory.agents.values()]
        .filter((agent) => agent.tenantId === TENANT_ID && isAvailableOnMcp(agent))
        .map((agent) => ({
          agentId: agent.id,
          name: agent.name,
          status: agent.status,
          currentDefinitionId: agent.currentDefinitionVersionId,
          currentVersion: memory.versions.find((row) => row.id === agent.currentDefinitionVersionId)?.version ?? null,
        }))
    },
    async loadDefinition() {
      return null
    },
    async canViewAgent() {
      return role === 'admin' || role === 'approver'
    },
    async loadSkillVersions() {
      return []
    },
    invokeEnterpriseTool: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    getGatewayOperation: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    async listMcpSkills() {
      return []
    },
    agentScaffold: scaffold,
  }
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

async function postMcp(deps: McpRuntimeDeps, body: unknown) {
  return handleMcpRequest(
    new Request(`${ORIGIN}/api/mcp/acme`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    }),
    'acme',
    deps,
  )
}

async function initializeMcp(deps: McpRuntimeDeps) {
  const res = await postMcp(deps, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'agent-scaffold-mcp-test', version: '1.0.0' },
    },
  })
  assert.equal(res.status, 200)
}

async function callTool(
  deps: McpRuntimeDeps,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await initializeMcp(deps)
  const res = await postMcp(deps, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  })
  assert.equal(res.status, 200)
  const parsed = (await readJson(res)) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean }
  }
  const text = parsed.result?.content?.[0]?.text
  assert.ok(text, JSON.stringify(parsed))
  return JSON.parse(text) as Record<string, unknown>
}

async function main() {
  await check('create clips unknown capability/skill/connector and still creates draft', async () => {
    const { deps } = memoryScaffoldDeps()
    const result = await createDraftAgent(deps, {
      tenantId: TENANT_ID,
      actorId: USER_ID,
      name: 'Wiki helper',
      roleInstruction: 'Use the wiki.',
      capabilities: ['kb_search', 'nope_tool'],
      skills: ['wiki-qa', 'missing-skill'],
      connectors: [{ name: 'CRM API' }, { name: 'Missing API' }],
    })
    assert.equal(result.status, 'draft')
    assert.deepEqual(
      result.workingSet.capabilities.map((row) => row.toolName),
      ['kb_search'],
    )
    assert.equal(result.workingSet.skills.length, 1)
    assert.equal(result.workingSet.connectors.length, 1)
    const codes = result.warnings.map((row) => row.code).sort()
    assert.deepEqual(codes, ['UNKNOWN_CAPABILITY', 'UNKNOWN_CONNECTOR', 'UNKNOWN_SKILL'])
  })

  await check('inactive connector → CONNECTOR_NOT_ACTIVE warning', async () => {
    const { deps } = memoryScaffoldDeps({ connectorActive: false })
    const result = await createDraftAgent(deps, {
      tenantId: TENANT_ID,
      actorId: USER_ID,
      name: 'CRM bot',
      roleInstruction: 'Read CRM.',
      connectors: [{ name: 'CRM API' }],
    })
    assert.equal(result.workingSet.connectors.length, 0)
    assert.ok(result.warnings.some((row) => row.code === 'CONNECTOR_NOT_ACTIVE'))
  })

  await check('create does not publish or activate', async () => {
    const { deps, publishCalls, activateCalls } = memoryScaffoldDeps()
    await createDraftAgent(deps, {
      tenantId: TENANT_ID,
      actorId: USER_ID,
      name: 'No publish',
      roleInstruction: 'Stay draft.',
    })
    assert.equal(publishCalls, 0)
    assert.equal(activateCalls, 0)
  })

  await check('admin happy path: create → get → publish → list', async () => {
    const memory = memoryScaffoldDeps()
    const created = await createDraftAgent(memory.deps, {
      tenantId: TENANT_ID,
      actorId: USER_ID,
      name: 'Listed agent',
      roleInstruction: 'Go live.',
      capabilities: ['kb_search'],
    })
    const working = await memory.service.getWorkingSet({
      agentId: created.agentId,
      tenantId: TENANT_ID,
    })
    assert.equal(working.contentHash, created.contentHash)
    const published = await publishAgentWorkingSet(memory.deps, {
      agentId: created.agentId,
      tenantId: TENANT_ID,
      publishedById: USER_ID,
    })
    assert.equal(published.status, 'active')
    assert.equal(published.activated, true)
    const agent = await memory.deps.agents.findById(created.agentId, TENANT_ID)
    assert.ok(agent && isAvailableOnMcp(agent))
  })

  await check('publish on suspended agent → invalid_state', async () => {
    const memory = memoryScaffoldDeps()
    const created = await createDraftAgent(memory.deps, {
      tenantId: TENANT_ID,
      actorId: USER_ID,
      name: 'Suspended',
      roleInstruction: 'Nope.',
    })
    const row = await memory.deps.agents.findById(created.agentId, TENANT_ID)
    assert.ok(row)
    memory.agents.set(created.agentId, { ...row, status: 'suspended' })
    await assert.rejects(
      () =>
        publishAgentWorkingSet(memory.deps, {
          agentId: created.agentId,
          tenantId: TENANT_ID,
          publishedById: USER_ID,
        }),
      (error: unknown) => error instanceof Error && error.message.includes('suspended'),
    )
  })

  await check('operator denied on create_draft', async () => {
    const memory = memoryScaffoldDeps()
    const deps = stubMcpDeps(memory, 'operator')
    const result = await callTool(deps, MCP_AGENT_CREATE_DRAFT_TOOL, {
      name: 'Blocked',
      roleInstruction: 'No.',
    })
    assert.equal(result.code, 'tool_not_allowed')
  })

  await check('operator get_working_set returns definition_not_found', async () => {
    const memory = memoryScaffoldDeps()
    const created = await createDraftAgent(memory.deps, {
      tenantId: TENANT_ID,
      actorId: USER_ID,
      name: 'Hidden',
      roleInstruction: 'Hidden.',
    })
    const deps = stubMcpDeps(memory, 'operator')
    const result = await callTool(deps, MCP_AGENT_GET_WORKING_SET_TOOL, {
      agentId: created.agentId,
    })
    assert.equal(result.code, 'definition_not_found')
  })

  await check('foreign tenant publish → definition_not_found via MCP', async () => {
    const memory = memoryScaffoldDeps()
    const created = await createDraftAgent(memory.deps, {
      tenantId: TENANT_ID,
      actorId: USER_ID,
      name: 'Tenant bound',
      roleInstruction: 'Stay here.',
    })
    await assert.rejects(
      () =>
        publishAgentWorkingSet(memory.deps, {
          agentId: created.agentId,
          tenantId: OTHER_TENANT_ID,
          publishedById: USER_ID,
        }),
      (error: unknown) => error instanceof Error && error.message.includes('not found'),
    )
  })

  await check('get_working_set hash matches create output', async () => {
    const memory = memoryScaffoldDeps()
    const deps = stubMcpDeps(memory, 'admin')
    const created = await callTool(deps, MCP_AGENT_CREATE_DRAFT_TOOL, {
      name: 'Hash check',
      roleInstruction: 'Same hash.',
      capabilities: ['kb_search'],
    })
    const working = await callTool(deps, MCP_AGENT_GET_WORKING_SET_TOOL, {
      agentId: created.agentId,
    })
    assert.equal(working.contentHash, created.contentHash)
    assert.equal(hashSnapshot(working.workingSet as never), created.contentHash)
  })

  await check('draft agent not listed until publish', async () => {
    const memory = memoryScaffoldDeps()
    const adminDeps = stubMcpDeps(memory, 'admin')
    const created = await createDraftAgent(memory.deps, {
      tenantId: TENANT_ID,
      actorId: USER_ID,
      name: 'Draft only',
      roleInstruction: 'Invisible.',
    })
    const listBefore = await callTool(adminDeps, MCP_AGENTS_LIST_TOOL, {})
    assert.equal(
      (listBefore.agents as Array<{ agentId: string }>).some((row) => row.agentId === created.agentId),
      false,
    )
    await callTool(adminDeps, MCP_AGENT_PUBLISH_TOOL, { agentId: created.agentId })
    const listAfter = await callTool(adminDeps, MCP_AGENTS_LIST_TOOL, {})
    assert.equal(
      (listAfter.agents as Array<{ agentId: string }>).some((row) => row.agentId === created.agentId),
      true,
    )
  })

  if (failures > 0) {
    console.error(`agent-scaffold-mcp: ${failures} failure(s)`)
    process.exit(1)
  }
  console.log('agent-scaffold-mcp: ok')
}

void main()
