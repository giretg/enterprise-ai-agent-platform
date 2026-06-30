/**
 * Szerep-sablon (role_templates, §3.5) runtime-enforcement negatív tesztek.
 *
 * Bizonyítja, hogy a Tool Broker `authorize()` a szerep-sablon `tool_access_allowed`
 * mezőjéből vezeti a tool-less invariánst (§6, N-AR-2), és hogy sablon hiányában a
 * beégetett alapértelmezésre esik vissza (orchestrator akkor is tool-less — sosem
 * fail-open).
 */
import assert from 'node:assert/strict'
import type { Agent } from '@prisma/client'
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
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`)
  }
}

function buildAuthorizer(opts: {
  agentRole: Agent['role']
  roleTemplate: { toolAccessAllowed: boolean } | null
}) {
  const tools = {
    // A capability mindig engedett — így a megtagadás bizonyíthatóan a szerep-kapu
    // miatt történik, nem a capability-tábla miatt.
    findCapability: async () => ({ allowed: true }),
    findConnectorForAgent: async () => null,
  } as unknown as ToolBrokerRepository

  const agents = {
    findById: async () => ({ id: 'agent-1', role: opts.agentRole }) as Agent,
  } as unknown as AgentRepository

  const grants = {
    findActiveGrant: async () => null,
  } as unknown as ConnectorGrantRepository

  const lookupActingUser: ActingUserLookup = async () => ({ status: 'active' })
  const lookupRoleTemplate: RoleTemplateLookup = async () => opts.roleTemplate

  return new AllowlistAuthorizer(tools, agents, grants, lookupActingUser, lookupRoleTemplate)
}

async function main() {
  console.log('=== role_templates: tool-less enforcement (§3.5/§6) ===')

  await test('N-AR-2 — orchestrator-sablon (tool_access_allowed=false) → nem-delegáló tool DENY', async () => {
    const authorizer = buildAuthorizer({
      agentRole: 'orchestrator',
      roleTemplate: { toolAccessAllowed: false },
    })
    const result = await authorizer.authorize({ agentId: 'agent-1', tool: 'kb_search' })
    assert.equal(result.allowed, false)
    if (!result.allowed) assert.equal(result.reason, 'orchestrator_tool_less')
  })

  await test('orchestrator-sablon → delegáló tool (ticket_create) átjut a szerep-kapun', async () => {
    const authorizer = buildAuthorizer({
      agentRole: 'orchestrator',
      roleTemplate: { toolAccessAllowed: false },
    })
    const result = await authorizer.authorize({ agentId: 'agent-1', tool: 'ticket_create' })
    // A szerep-kapu nem tagadja meg; ha mégis tiltott lenne, az más okból (nem tool-less).
    if (!result.allowed) assert.notEqual(result.reason, 'orchestrator_tool_less')
  })

  await test('fail-safe — nincs sablon + orchestrator szerep → DENY (sosem fail-open)', async () => {
    const authorizer = buildAuthorizer({ agentRole: 'orchestrator', roleTemplate: null })
    const result = await authorizer.authorize({ agentId: 'agent-1', tool: 'kb_search' })
    assert.equal(result.allowed, false)
    if (!result.allowed) assert.equal(result.reason, 'orchestrator_tool_less')
  })

  await test('worker-sablon (tool_access_allowed=true) → eszközhívás átjut a szerep-kapun', async () => {
    const authorizer = buildAuthorizer({
      agentRole: 'worker',
      roleTemplate: { toolAccessAllowed: true },
    })
    const result = await authorizer.authorize({ agentId: 'agent-1', tool: 'kb_search' })
    if (!result.allowed) assert.notEqual(result.reason, 'orchestrator_tool_less')
  })

  if (failures > 0) {
    console.error(`\n${failures} role_template teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden role_template enforcement teszt zöld.')
}

main()
