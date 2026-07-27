/**
 * Tool Broker — agent-oldali TENANT-IZOLÁCIÓ regressziós teszt.
 *
 * Kontextus: a `user_directory` és a `ticket_create` HUMÁN-felelős ága már
 * tenant-szűrt volt (cross-tenant humán user sosem szivárog ki), de az
 * AGENT-irányú toolok (agent_resolve, agent_catalog, agent_ask, valamint a
 * ticket_create AGENT-felelős ága) a teljes agent-táblán dolgoztak tenant-szűrő
 * nélkül. Egy multi-tenant telepítésen ez cross-tenant felderítést (nevek,
 * szerepek, teljes capability-/connector-katalógus) és cross-tenant delegálást
 * (confused deputy) engedett meg. Ez a teszt az izolációs invariánst rögzíti:
 *   - MEGOSZTOTT agent (tenantId === null) mindig elérhető,
 *   - saját tenant agentje elérhető,
 *   - más tenant agentje SOHA nem oldódik fel — sem listában, sem delegálásban.
 *
 * A deny-utak DB nélkül futnak (a cross-tenant ellenőrzés a `systemUserId()` /
 * ticket-létrehozás ELŐTT dob), ezért in-memory fake repókkal determinisztikus.
 *
 * Futtatás: npm run test:tool-broker-tenant
 */
import assert from 'node:assert/strict'
import type { Agent, Ticket } from '@prisma/client'
import {
  ToolBrokerService,
  isAgentReachableFromTenant,
  filterAgentsByTenant,
  filterUserDirectory,
  type Authorizer,
} from '../src/domain/tool-broker/tool-broker-service'
import type {
  AgentRepository,
  TicketRepository,
  ToolBrokerRepository,
  AuditRepository,
} from '../src/repositories/interfaces'
import type { TicketService } from '../src/domain/ticket/ticket-service'
import type { ConnectorGrantService } from '../src/domain/connector-grant/connector-grant-service'
import type { FileEditorService } from '../src/domain/file-editor/file-editor-service'
import type { WebSearchService } from '../src/domain/web-search/web-search-service'
import type { WebSearchPolicyService } from '../src/domain/web-search/web-search-policy-service'
import type { UserDirectorySearchEntry } from '../src/domain/tool-broker/tool-broker-types'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000002'

const CALLER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ALFA = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const BRAVO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SHARED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function agent(id: string, name: string, tenantId: string | null): Agent {
  return {
    id,
    tenantId,
    name,
    role: 'worker',
    roleInstruction: `${name} feladata`,
    behaviorProfile: 'profil',
    status: 'active',
    currentVersion: 1,
    modelConfig: { provider: 'anthropic', model: 'claude-sonnet-5' },
  } as unknown as Agent
}

const AGENTS: Agent[] = [
  agent(CALLER, 'Caller Agent', TENANT_A),
  agent(ALFA, 'Alfa Agent', TENANT_A),
  agent(BRAVO, 'Bravo Agent', TENANT_B),
  agent(SHARED, 'Shared Agent', null),
]
const AGENT_BY_ID = new Map(AGENTS.map((a) => [a.id, a]))

const fakeAgents = {
  findMany: async () => AGENTS,
  findById: async (id: string) => AGENT_BY_ID.get(id) ?? null,
  findByIdForRuntime: async (id: string) => {
    const a = AGENT_BY_ID.get(id)
    if (!a) return null
    return { agent: a, memoryContent: null, memoryVersion: 1 }
  },
  findByIdForDisplay: async (id: string) => {
    const a = AGENT_BY_ID.get(id)
    if (!a) return null
    return {
      agent: a,
      memoryContent: null,
      memoryVersion: 1,
      recipe: null,
      resources: [],
      apiKeyPreview: null,
      behaviorProfileLink: null,
    }
  },
  findByIdWithDetails: async (id: string) => {
    const a = AGENT_BY_ID.get(id)
    if (!a) return null
    return {
      agent: a,
      memoryContent: null,
      memoryVersion: 1,
      recipe: null,
      resources: [],
      apiKeyPreview: null,
      behaviorProfileLink: null,
    }
  },
} as unknown as AgentRepository

const ticketA = {
  id: 'ticket-A',
  tenantId: TENANT_A,
  agentId: CALLER,
  payload: {},
  state: 'in_progress',
} as unknown as Ticket

const ticketBWithRunAs = {
  id: 'ticket-B',
  tenantId: TENANT_A,
  agentId: ALFA,
  payload: {
    runAsUserId: 'human-user-A',
    runAsAuthorizedBy: 'human-user-A',
    runAsAuthorizedAt: '2026-07-19T10:00:00.000Z',
  },
  state: 'in_progress',
} as unknown as Ticket

const fakeTickets = {
  findById: async (id: string) => {
    if (id === ticketA.id) return ticketA
    if (id === ticketBWithRunAs.id) return ticketBWithRunAs
    return null
  },
} as unknown as TicketRepository

const toolCalls: Array<{ toolName: string; status: string }> = []
const fakeTools = {
  createToolCall: async (row: { toolName: string; status: string }) => {
    toolCalls.push({ toolName: row.toolName, status: row.status })
  },
  findCapabilitiesForAgent: async () => [],
  findConnectorsForAgent: async () => [],
} as unknown as ToolBrokerRepository

const fakeAudit = { append: async () => undefined } as unknown as AuditRepository
const fakeAuthorizer: Authorizer = { authorize: async () => ({ allowed: true }) }

function makeBroker(): ToolBrokerService {
  return new ToolBrokerService(
    fakeAgents,
    fakeTickets,
    fakeTools,
    fakeAudit,
    null as unknown as TicketService,
    fakeAuthorizer,
    null as unknown as ConnectorGrantService,
    null as unknown as FileEditorService,
    null as never,
    null as never,
    null as unknown as WebSearchService,
    null as unknown as WebSearchPolicyService,
    null as never,
    null as never,
    null as never, // memoryProposal
  )
}

async function main() {
  console.log('=== Tool Broker tenant-izoláció ===')

  // ── Tiszta szabály ────────────────────────────────────────────────────────
  await test('isAgentReachableFromTenant: megosztott (null) agent bárhonnan elérhető', () => {
    assert.equal(isAgentReachableFromTenant(null, TENANT_A), true)
    assert.equal(isAgentReachableFromTenant(null, null), true)
  })

  await test('isAgentReachableFromTenant: saját tenant elérhető, más tenant nem', () => {
    assert.equal(isAgentReachableFromTenant(TENANT_A, TENANT_A), true)
    assert.equal(isAgentReachableFromTenant(TENANT_B, TENANT_A), false)
    assert.equal(isAgentReachableFromTenant(TENANT_A, null), false)
  })

  await test('filterAgentsByTenant: csak saját + megosztott marad', () => {
    const kept = filterAgentsByTenant(AGENTS, TENANT_A).map((a) => a.id)
    assert.ok(kept.includes(ALFA))
    assert.ok(kept.includes(SHARED))
    assert.ok(!kept.includes(BRAVO), 'más tenant agentje nem maradhat')
  })

  // ── user_directory adatminimalizálás (#80) ─────────────────────────────────
  const directory: UserDirectorySearchEntry[] = [
    {
      userId: '11111111-1111-4111-8111-111111111111',
      name: 'Kiss Anna',
      email: 'anna@example.test',
      role: 'member',
      jobDescription: 'marketing vezető',
      status: 'active',
    },
    {
      userId: '22222222-2222-4222-8222-222222222222',
      name: 'Nagy Béla',
      email: 'bela@example.test',
      role: 'member',
      jobDescription: 'pénzügyi elemző',
      status: 'active',
    },
  ]

  await test('user_directory: üres vagy hiányzó query nem ad vissza teljes névsort', () => {
    assert.deepEqual(filterUserDirectory(directory, {}), { users: [] })
    assert.deepEqual(filterUserDirectory(directory, { query: '   ' }), { users: [] })
  })

  await test('user_directory: célzott keresés működik, de e-mail nem kerül a válaszba', () => {
    const result = filterUserDirectory(directory, { query: 'marketing' })
    assert.equal(result.users.length, 1)
    assert.equal(result.users[0].userId, directory[0].userId)
    assert.equal('email' in result.users[0], false)
    assert.ok(!JSON.stringify(result).includes('anna@example.test'))
  })

  await test('user_directory: ismert e-mailre kereshet, de azt sem adja vissza', () => {
    const result = filterUserDirectory(directory, { query: 'bela@example.test' })
    assert.equal(result.users.length, 1)
    assert.equal(result.users[0].userId, directory[1].userId)
    assert.equal('email' in result.users[0], false)
  })

  // ── agent_resolve ─────────────────────────────────────────────────────────
  await test('agent_resolve: más tenant agentjét NEM adja vissza', async () => {
    const broker = makeBroker()
    const res = await broker.invoke({
      agentId: CALLER,
      agentVersion: 1,
      tool: 'agent_resolve',
      args: { query: 'agent' },
    })
    assert.equal(res.denied, false)
    const ids = (res as { result: { agents: Array<{ agentId: string }> } }).result.agents.map(
      (a) => a.agentId,
    )
    assert.ok(ids.includes(ALFA), 'saját tenant agentje látszik')
    assert.ok(ids.includes(SHARED), 'megosztott agent látszik')
    assert.ok(!ids.includes(BRAVO), 'cross-tenant agent SOHA nem szivárog ki')
  })

  // ── agent_catalog (agentId direkt lookup) ─────────────────────────────────
  await test('agent_catalog(agentId): cross-tenant agentre üres (nem árulja el a katalógust)', async () => {
    const broker = makeBroker()
    const res = await broker.invoke({
      agentId: CALLER,
      agentVersion: 1,
      tool: 'agent_catalog',
      args: { agentId: BRAVO },
    })
    assert.equal(res.denied, false)
    const agents = (res as { result: { agents: unknown[] } }).result.agents
    assert.equal(agents.length, 0, 'cross-tenant agent katalógus-belépője nem szivároghat ki')
  })

  await test('agent_catalog(agentId): saját tenant agentje elérhető', async () => {
    const broker = makeBroker()
    const res = await broker.invoke({
      agentId: CALLER,
      agentVersion: 1,
      tool: 'agent_catalog',
      args: { agentId: ALFA },
    })
    assert.equal(res.denied, false)
    const agents = (res as { result: { agents: Array<{ agentId: string }> } }).result.agents
    assert.equal(agents.length, 1)
    assert.equal(agents[0].agentId, ALFA)
  })

  // ── agent_ask (delegálás) ─────────────────────────────────────────────────
  await test('agent_ask: cross-tenant célagentnek NEM delegál (hangosan bukik)', async () => {
    const broker = makeBroker()
    await assert.rejects(
      () =>
        broker.invoke({
          agentId: CALLER,
          agentVersion: 1,
          ticketId: 'ticket-A',
          tool: 'agent_ask',
          args: { targetAgentId: BRAVO, question: 'Bizalmas kérdés' },
        }),
      /not reachable from this tenant/,
    )
  })

  // ── ticket_create (agent-felelős) ─────────────────────────────────────────
  await test('ticket_create: cross-tenant agent-felelőshöz NEM rendel ticketet', async () => {
    const broker = makeBroker()
    await assert.rejects(
      () =>
        broker.invoke({
          agentId: CALLER,
          agentVersion: 1,
          ticketId: 'ticket-A',
          tool: 'ticket_create',
          args: { title: 'Feladat', payload: {}, assigneeType: 'agent', assigneeId: BRAVO },
        }),
      /not reachable from this tenant/,
    )
  })

  // ── Külső agent API: acting-user / kontextus eredete ──────────────────────
  await test('más agent ticketjének run-as grantját nem fogadja el', async () => {
    const broker = makeBroker()
    const actingUserId = await broker.resolveActingUserId({
      agentId: CALLER,
      agentVersion: 1,
      ticketId: ticketBWithRunAs.id,
      tool: 'gmail_search',
      args: { query: 'bizalmas' },
    })
    assert.equal(actingUserId, null)
  })

  await test('külső agent API nem választhat acting usert a kérés törzséből', async () => {
    const broker = makeBroker()
    const actingUserId = await broker.resolveActingUserId({
      agentId: CALLER,
      agentVersion: 1,
      tool: 'gmail_search',
      args: { query: 'bizalmas' },
      actingUserId: 'human-user-A',
      actingUserSource: 'external_agent_api',
    })
    assert.equal(actingUserId, null)
  })

  await test('belső, szerveroldali acting user továbbra is használható', async () => {
    const broker = makeBroker()
    const actingUserId = await broker.resolveActingUserId({
      agentId: CALLER,
      agentVersion: 1,
      tool: 'gmail_search',
      args: { query: 'bizalmas' },
      actingUserId: 'human-user-A',
      actingUserSource: 'trusted_internal',
    })
    assert.equal(actingUserId, 'human-user-A')
  })

  if (failures > 0) {
    console.error(`\n${failures} tenant-izolációs teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden Tool Broker tenant-izolációs teszt zöld.')
}

void main()
