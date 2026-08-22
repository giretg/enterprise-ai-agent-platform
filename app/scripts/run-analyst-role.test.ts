/**
 * Futás-elemző role-sablon — unit tesztek (#346, RA-02).
 *
 * Futtatás: npm run test:run-analyst-role
 */
import assert from 'node:assert/strict'
import type { Agent } from '@prisma/client'
import {
  RUN_ANALYST_FORBIDDEN_TOOLS,
  RUN_ANALYST_LOOP_GUARD_OVERRIDES,
  RUN_ANALYST_PRIVACY_CATEGORY_POLICY,
  RUN_ANALYST_ROLE_CAPABILITIES,
  RUN_ANALYST_ROLE_TEMPLATE,
  mergeRunAnalystLoopGuardModelConfig,
  runAnalystCapabilitiesAreDisjointFromForbidden,
} from '../src/domain/agents/run-analyst-role'
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

function buildAuthorizer(allowedCapabilities: Set<string>) {
  const tools = {
    findCapability: async (_agentId: string, tool: string) =>
      allowedCapabilities.has(tool) ? { allowed: true } : null,
    findConnectorForAgent: async () => null,
  } as unknown as ToolBrokerRepository

  const agents = {
    findById: async () =>
      ({ id: 'agent-ra', role: 'worker', tenantId: 'tenant-1' }) as Agent,
  } as unknown as AgentRepository

  const grants = { findActiveGrant: async () => null } as unknown as ConnectorGrantRepository
  const lookupActingUser: ActingUserLookup = async () => ({ status: 'active' })
  const lookupRoleTemplate: RoleTemplateLookup = async () => ({ toolAccessAllowed: true })

  return new AllowlistAuthorizer(tools, agents, grants, lookupActingUser, lookupRoleTemplate)
}

async function main() {
  console.log('=== Futás-elemző role-sablon (#346) ===')

  await test('capability-halmaz: run_index, run_trace, run_stats, ticket_create', () => {
    assert.deepEqual([...RUN_ANALYST_ROLE_CAPABILITIES], [
      'run_index',
      'run_trace',
      'run_stats',
      'ticket_create',
    ])
    assert.deepEqual(RUN_ANALYST_ROLE_TEMPLATE.capabilities, RUN_ANALYST_ROLE_CAPABILITIES)
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

  await test('kimenő egress tool (web_search) → capability_not_allowed', async () => {
    const allowed = new Set<string>(RUN_ANALYST_ROLE_CAPABILITIES)
    const authorizer = buildAuthorizer(allowed)
    const result = await authorizer.authorize({ agentId: 'agent-ra', tool: 'web_search' })
    assert.equal(result.allowed, false)
    if (!result.allowed) assert.equal(result.reason, 'capability_not_allowed')
  })

  await test('kimenő egress tool (gmail_send) → capability_not_allowed', async () => {
    const allowed = new Set<string>(RUN_ANALYST_ROLE_CAPABILITIES)
    const authorizer = buildAuthorizer(allowed)
    const result = await authorizer.authorize({ agentId: 'agent-ra', tool: 'gmail_send' })
    assert.equal(result.allowed, false)
    if (!result.allowed) assert.equal(result.reason, 'capability_not_allowed')
  })

  await test('engedélyezett capability (ticket_create) → átjut a capability-kapun', async () => {
    const allowed = new Set<string>(RUN_ANALYST_ROLE_CAPABILITIES)
    const authorizer = buildAuthorizer(allowed)
    const result = await authorizer.authorize({ agentId: 'agent-ra', tool: 'ticket_create' })
    if (!result.allowed) assert.notEqual(result.reason, 'capability_not_allowed')
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
