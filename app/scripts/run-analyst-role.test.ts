/**
 * Futás-elemző role-sablon — unit tesztek (#346, RA-02).
 *
 * Futtatás: npm run test:run-analyst-role
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent } from '@prisma/client'
import {
  RUN_ANALYST_CAPABILITIES_LOCKED_MESSAGE,
  RUN_ANALYST_FORBIDDEN_TOOLS,
  RUN_ANALYST_LOOP_GUARD_OVERRIDES,
  RUN_ANALYST_PRIVACY_CATEGORY_POLICY,
  RUN_ANALYST_ROLE_CAPABILITIES,
  RUN_ANALYST_ROLE_TEMPLATE,
  mergeRunAnalystLoopGuardModelConfig,
  runAnalystCapabilitiesAreDisjointFromForbidden,
} from '../src/domain/agents/run-analyst-role'
import { REGISTERED_AUDIT_ACTIONS } from '../src/lib/audit/event-catalog'
import { resolveLoopGuardLimits } from '../src/domain/agent/loop-stop-decision'
import { DEFAULT_ROLE_PERMISSIONS } from '../src/repositories/postgres/iam-repository'
import {
  allowsExternalRaw,
  resolvePrivacyCategoryPolicy,
} from '../src/domain/privacy/privacy-category-policy'
import {
  AllowlistAuthorizer,
  type ActingUserLookup,
  type RoleTemplateLookup,
} from '../src/domain/tool-broker/tool-broker-service'
import type {
  AgentRepository,
  ConnectorGrantRepository,
  ToolBrokerRepository,
} from '../src/repositories/interfaces'

let failures = 0

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`)
  }
}

function buildAuthorizer(
  allowedCapabilities: Set<string>,
  connectorLink: {
    connector: {
      id: string
      type: string
      tenantId: string | null
      lifecycleState: string
      authMode: string
    }
    agentSecretAlias: string | null
  } | null = null,
  opts: {
    /** AgentConnector nélkül is feloldható tenant HTTP API — a Futás-elemző útja. */
    tenantConnectors?: Array<{
      id: string
      type: string
      tenantId: string | null
      lifecycleState: string
      authMode: string
    }>
    systemRole?: Agent['systemRole']
  } = {},
) {
  const tenantConnectors = opts.tenantConnectors ?? []
  const systemRole = opts.systemRole === undefined ? 'run_analyst' : opts.systemRole
  const tenantHttpLink = (
    type: string,
    accessMode: string,
    tenantId: string | null | undefined,
    connectorId?: string,
  ) => {
    if (systemRole !== 'run_analyst' || type !== 'http_api' || accessMode !== 'read') return null
    const connector = tenantConnectors.find((candidate) => {
      if (candidate.type !== type) return false
      if (connectorId && candidate.id !== connectorId) return false
      return candidate.tenantId === null || candidate.tenantId === tenantId
    })
    return connector ? { connector, agentSecretAlias: null } : null
  }
  const tools = {
    findCapability: async (_agentId: string, tool: string) =>
      allowedCapabilities.has(tool) ? { allowed: true } : null,
    findConnectorForAgent: async (
      _agentId: string,
      type: string,
      accessMode: string,
      tenantId?: string | null,
    ) => connectorLink ?? tenantHttpLink(type, accessMode, tenantId),
    findConnectorForAgentById: async (
      _agentId: string,
      connectorId: string,
      type: string,
      accessMode: string,
      tenantId?: string | null,
    ) => connectorLink ?? tenantHttpLink(type, accessMode, tenantId, connectorId),
  } as unknown as ToolBrokerRepository

  const agents = {
    findById: async () =>
      ({
        id: 'agent-ra',
        role: 'worker',
        tenantId: 'tenant-1',
        systemRole,
      }) as Agent,
  } as unknown as AgentRepository

  const grants = { findActiveGrant: async () => null } as unknown as ConnectorGrantRepository
  const lookupActingUser: ActingUserLookup = async () => ({ status: 'active' })
  const lookupRoleTemplate: RoleTemplateLookup = async () => ({ toolAccessAllowed: true })

  return new AllowlistAuthorizer(tools, agents, grants, lookupActingUser, lookupRoleTemplate)
}

async function main() {
  console.log('=== Futás-elemző role-sablon (#346) ===')

  await test('capability-halmaz: run_* + ticket_create + tenant HTTP olvasás', () => {
    assert.deepEqual([...RUN_ANALYST_ROLE_CAPABILITIES].sort(), [
      'run_index',
      'run_trace',
      'run_stats',
      'ticket_create',
      'http_api_get',
      'http_api_get_all',
    ].sort())
    assert.deepEqual(RUN_ANALYST_ROLE_TEMPLATE.capabilities, RUN_ANALYST_ROLE_CAPABILITIES)
    assert.ok(!RUN_ANALYST_ROLE_CAPABILITIES.includes('http_api_request' as never))
  })

  await test('forbiddenTools diszjunkt a capability-halmaztól', () => {
    assert.equal(runAnalystCapabilitiesAreDisjointFromForbidden(), true)
    for (const forbidden of RUN_ANALYST_FORBIDDEN_TOOLS) {
      assert.ok(
        !RUN_ANALYST_ROLE_CAPABILITIES.includes(forbidden as never),
        `${forbidden} must not be a capability`,
      )
    }
  })

  await test('kézzel hozzáadott forbidden/extra capability sem nyit toolt', async () => {
    const drifted = [...RUN_ANALYST_FORBIDDEN_TOOLS, 'kb_search'] as const
    const allowed = new Set<string>([...RUN_ANALYST_ROLE_CAPABILITIES, ...drifted])
    const authorizer = buildAuthorizer(allowed)
    for (const tool of drifted) {
      const result = await authorizer.authorize({ agentId: 'agent-ra', tool: tool as never })
      assert.equal(result.allowed, false, tool)
      if (!result.allowed) assert.equal(result.reason, 'system_role_tool_not_allowed', tool)
    }
  })

  await test('engedélyezett capability (ticket_create) → átjut a capability-kapun', async () => {
    const allowed = new Set<string>(RUN_ANALYST_ROLE_CAPABILITIES)
    const authorizer = buildAuthorizer(allowed)
    const result = await authorizer.authorize({ agentId: 'agent-ra', tool: 'ticket_create' })
    if (!result.allowed) assert.notEqual(result.reason, 'capability_not_allowed')
  })

  await test('ticket_create board-connectorral engedélyezett', async () => {
    const allowed = new Set<string>(RUN_ANALYST_ROLE_CAPABILITIES)
    const authorizer = buildAuthorizer(allowed, {
      connector: {
        id: 'board-1',
        type: 'board',
        tenantId: 'tenant-1',
        lifecycleState: 'active',
        authMode: 'service',
      },
      agentSecretAlias: null,
    })
    const result = await authorizer.authorize({
      agentId: 'agent-ra',
      tool: 'ticket_create',
      tenantId: 'tenant-1',
    })
    assert.equal(result.allowed, true)
  })

  await test('run_index / run_trace / run_stats: connector nélkül engedélyezett', async () => {
    const allowed = new Set<string>(RUN_ANALYST_ROLE_CAPABILITIES)
    const authorizer = buildAuthorizer(allowed)
    for (const tool of ['run_index', 'run_trace', 'run_stats'] as const) {
      const result = await authorizer.authorize({ agentId: 'agent-ra', tool })
      assert.equal(result.allowed, true, `${tool} reason=${!result.allowed ? result.reason : ''}`)
    }
  })

  await test('run_* tool normál agentnél capability-drifttel is tiltott', async () => {
    const allowed = new Set<string>(RUN_ANALYST_ROLE_CAPABILITIES)
    const authorizer = buildAuthorizer(allowed, null, { systemRole: null })
    for (const tool of ['run_index', 'run_trace', 'run_stats'] as const) {
      const result = await authorizer.authorize({ agentId: 'agent-normal', tool })
      assert.equal(result.allowed, false, tool)
      if (!result.allowed) assert.equal(result.reason, 'system_role_tool_not_allowed', tool)
    }
  })

  await test('http_api_get / http_api_get_all: tenant API AgentConnector nélkül is engedélyezett', async () => {
    const allowed = new Set<string>(RUN_ANALYST_ROLE_CAPABILITIES)
    const tenantApi = {
      id: 'api-1',
      type: 'http_api',
      tenantId: 'tenant-1',
      lifecycleState: 'active',
      authMode: 'service',
    }
    const authorizer = buildAuthorizer(allowed, null, { tenantConnectors: [tenantApi] })
    for (const tool of ['http_api_get', 'http_api_get_all'] as const) {
      const result = await authorizer.authorize({
        agentId: 'agent-ra',
        tool,
        tenantId: 'tenant-1',
        args: { path: '/health', connectorId: 'api-1' },
      })
      assert.equal(result.allowed, true, `${tool} reason=${!result.allowed ? result.reason : ''}`)
    }
  })

  await test('http_api_request írás a Futás-elemzőn capability-drifttel sem nyílik', async () => {
    const allowed = new Set<string>([...RUN_ANALYST_ROLE_CAPABILITIES, 'http_api_request'])
    const authorizer = buildAuthorizer(allowed, {
      connector: {
        id: 'api-1',
        type: 'http_api',
        tenantId: 'tenant-1',
        lifecycleState: 'active',
        authMode: 'service',
      },
      agentSecretAlias: null,
    })
    const result = await authorizer.authorize({
      agentId: 'agent-ra',
      tool: 'http_api_request',
      tenantId: 'tenant-1',
      args: { method: 'POST', path: '/items' },
    })
    assert.equal(result.allowed, false)
    if (!result.allowed) assert.equal(result.reason, 'system_role_tool_not_allowed')
  })

  await test('idegen tenant HTTP API a Futás-elemzőn sem oldódik fel', async () => {
    const allowed = new Set<string>(RUN_ANALYST_ROLE_CAPABILITIES)
    const authorizer = buildAuthorizer(allowed, null, {
      tenantConnectors: [
        {
          id: 'api-foreign',
          type: 'http_api',
          tenantId: 'tenant-other',
          lifecycleState: 'active',
          authMode: 'service',
        },
      ],
    })
    const result = await authorizer.authorize({
      agentId: 'agent-ra',
      tool: 'http_api_get',
      tenantId: 'tenant-1',
      args: { path: '/health', connectorId: 'api-foreign' },
    })
    assert.equal(result.allowed, false)
    if (!result.allowed) {
      assert.match(result.reason ?? '', /missing_http_api_connector_read/)
    }
  })

  await test('tenant HTTP API agent-kötés nélkül normál agentnek nem nyílik meg', async () => {
    const allowed = new Set<string>(['http_api_get'])
    const authorizer = buildAuthorizer(allowed, null, {
      systemRole: null,
      tenantConnectors: [
        {
          id: 'api-1',
          type: 'http_api',
          tenantId: 'tenant-1',
          lifecycleState: 'active',
          authMode: 'service',
        },
      ],
    })
    const result = await authorizer.authorize({
      agentId: 'agent-normal',
      tool: 'http_api_get',
      tenantId: 'tenant-1',
      args: { path: '/health', connectorId: 'api-1' },
    })
    assert.equal(result.allowed, false)
  })

  await test('privacy overlay: scanner-kategóriák nem engednek nyers külső modellt', () => {
    const resolved = resolvePrivacyCategoryPolicy({
      agent: {
        categories: { ...RUN_ANALYST_PRIVACY_CATEGORY_POLICY },
        custom: {},
        updatedById: 'provisioning',
        updatedAt: null,
      },
      legacyAllowSensitiveExternalModel: true,
    })
    assert.equal(resolved.legacyToggleApplied, false)
    for (const [category, action] of Object.entries(RUN_ANALYST_PRIVACY_CATEGORY_POLICY)) {
      assert.equal(
        allowsExternalRaw(resolved.categories[category as keyof typeof resolved.categories]),
        false,
        `${category} must not allow raw external egress`,
      )
      assert.equal(resolved.categories[category as keyof typeof resolved.categories], action)
    }
  })

  await test('analysis.run permission: admin minimum a DEFAULT_ROLE_PERMISSIONS-ben', () => {
    const entry = DEFAULT_ROLE_PERMISSIONS.find((p) => p.permissionKey === 'analysis.run')
    assert.ok(entry)
    assert.equal(entry!.minRole, 'admin')
  })

  await test('editor-deny: audit action a katalógusban, üzenet a capability-lock', () => {
    assert.ok(REGISTERED_AUDIT_ACTIONS.has('capability.update_denied_system_role'))
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const platform = readFileSync(join(root, 'src/app/actions/platform.ts'), 'utf8')
    assert.match(platform, /capability\.update_denied_system_role/)
    assert.match(platform, /RUN_ANALYST_CAPABILITIES_LOCKED_MESSAGE/)
    assert.equal(
      RUN_ANALYST_CAPABILITIES_LOCKED_MESSAGE.includes('platform által védettek'),
      true,
    )
  })

  await test('az agent adatlap nem engedi szerkeszteni a Futás-elemző eszközjogait', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const page = readFileSync(
      join(root, 'src/app/control-plane/agents/[agentId]/page.tsx'),
      'utf8',
    )
    const tabPage = readFileSync(
      join(root, 'src/app/control-plane/agents/[agentId]/(workspace)/[tab]/page.tsx'),
      'utf8',
    )
    const provisioning = readFileSync(join(root, 'src/app/actions/provisioning.ts'), 'utf8')
    assert.match(page, /capabilitiesLocked/)
    assert.match(page, /canEdit=\{isAdmin && !capabilitiesLocked\}/)
    assert.match(page, /RUN_ANALYST_CAPABILITIES_LOCKED_MESSAGE/)
    assert.match(page, /id: 'motor'/)
    assert.match(page, /UpdateModelConfigForm/)
    assert.match(tabPage, /profile:\s*\(\)\s*=>/)
    assert.match(tabPage, /embedded/)
    assert.match(provisioning, /RUN_ANALYST_CONNECTOR_LOCKED_MESSAGE/)
  })

  await test('modellcsere megőrzi a Futás-elemző loop-guardját', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const update = readFileSync(join(root, 'src/app/actions/agent-model-config-update.ts'), 'utf8')
    assert.match(update, /mergeRunAnalystLoopGuardModelConfig/)
    assert.match(update, /RUN_ANALYST_SYSTEM_ROLE/)
  })

  await test('loop-guard modelConfig: ≥150 tool hívás task módban (#351)', () => {
    const limits = resolveLoopGuardLimits(
      mergeRunAnalystLoopGuardModelConfig(RUN_ANALYST_ROLE_TEMPLATE.modelConfig),
      40,
      'task',
    )
    assert.ok(limits.maxToolCalls >= 150)
    assert.equal(limits.maxToolCalls, RUN_ANALYST_LOOP_GUARD_OVERRIDES.maxToolCalls)
  })

  if (failures > 0) {
    console.error(`\n${failures} run-analyst-role teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden run-analyst-role teszt zöld.')
}

main()
