/**
 * Tenant-státusz kapu az AUTOMATA úton (Feature-spec Tenant-Management §7.3).
 *
 * Futtatás: npx tsx scripts/dispatch-tenant-status.test.ts
 *
 * A `tenantStatusAllowsOperations` kapu eddig kizárólag az emberi guardokban élt
 * (`requireTenantRole` / `requireTenantPermission`). A dispatcher megkerülte, így egy
 * felfüggesztett tenant agentjei tovább futottak: modell-keretet égettek, connectorokat
 * hívtak, adatot mozgattak. Ezek a tesztek a kaput az automata úton rögzítik.
 *
 * TS-1: `active` tenant → a dispatch elindul (a kapu nem regresszió).
 * TS-2: `suspended` tenant → skipped + `tenant_inactive`, semmi nem indul.
 * TS-3: `offboarding` / `archived` tenant → ugyanúgy tilt.
 * TS-4: a tiltás auditált (`dispatch.tenant_inactive`), a tenant-státusszal együtt.
 * TS-5: hiányzó tenant-sor → fail-closed (nem "ismeretlen ⇒ engedd").
 * TS-6: valóban platform-szintű munka (ticket ÉS agent tenant nélkül) fut.
 * TS-7: a kapu a MUNKA tulajdonosára kulcsol — suspended tenant tickete megosztott
 *       platform-agenthez rendelve is tilt (különben a megosztott agent kiskapu lenne).
 * TS-8: a kiírt audit-action regisztrálva van az esemény-katalógusban (élesben dobna).
 */

import assert from 'node:assert/strict'
import type { Agent, Prisma, Tenant, TenantStatus, Ticket } from '@prisma/client'
import { DispatcherService, type HarnessLauncher } from '../src/domain/dispatcher/dispatcher-service'
import type {
  AgentRepository,
  AuditRepository,
  ModelCallRepository,
  TenantRepository,
  TicketRepository,
} from '../src/repositories/interfaces'

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

const TENANT_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const AGENT_1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const TICKET_ID = 'aaaaaaaa-0000-4000-8000-0000000000f1'

function makeTicket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: TICKET_ID,
    tenantId: TENANT_A,
    type: 'interaction',
    title: 'tenant status gate',
    state: 'ready',
    assigneeType: 'agent',
    assigneeId: AGENT_1,
    agentId: AGENT_1,
    payload: {} as Prisma.JsonValue,
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    lockToken: null,
    lockedAt: null,
    playbookRef: null,
    processInstanceId: null,
    playbookVersionId: null,
    playbookStepId: null,
    requiredGateId: null,
    conversationId: null,
    source: 'user',
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Ticket
}

function makeAgent(over: Partial<Agent> = {}): Agent {
  return { id: AGENT_1, tenantId: TENANT_A, status: 'active', name: 'Péter', ...over } as Agent
}

function makeTenant(status: TenantStatus): Tenant {
  return {
    id: TENANT_A,
    slug: 'acme',
    displayName: 'Acme Zrt.',
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Tenant
}

function makeAudit(): { repo: AuditRepository; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = []
  const repo = {
    async append(data: Record<string, unknown>) {
      events.push(data)
      return data as never
    },
    async findMany() { return [] },
    async findAll() { return [] },
    async getActionCounts() { return {} },
  } as unknown as AuditRepository
  return { repo, events }
}

const noUsage: ModelCallRepository = {
  async create(data: unknown) { return data as never },
  async getCostSummary() { return { tokens: 0, cost: 0 } },
  async getUsageForAgentSince() { return { calls: 0, tokens: 0 } },
  async getUsageForTicket() { return { calls: 0, tokens: 0 } },
  async getUsageForAgent() { return { calls: 0, tokens: 0 } },
  async getUsageForTenant() { return { calls: 0, tokens: 0 } },
  async getUsageForTicketType() { return { calls: 0, tokens: 0 } },
  async getUsageByAgent() { return [] },
  async getGovernanceSummary() {
    return { calls: 0, tokens: 0, cost: 0, avgLatencyMs: 0, okCalls: 0, errorCalls: 0, rateLimitedCalls: 0 }
  },
  async getPerTicketBreakdown() { return [] },
} as unknown as ModelCallRepository

/** Dispatcher a valós kapukkal; a launcher csak jelzi, hogy elindult volna egy agent. */
function makeDispatcher(input: { ticket: Ticket; agent: Agent | null; tenant: Tenant | null }) {
  const { repo: audit, events } = makeAudit()
  const launched: string[] = []

  const tickets = {
    async findReadyForDispatch() { return [input.ticket] },
    async findById() { return input.ticket },
    async acquireDispatchLock() { return input.ticket },
    async releaseDispatchLock() {},
    async update(_id: string, data: Partial<Ticket>) { return { ...input.ticket, ...data } },
    async recordTransition() {},
    async findStaleInProgressDispatches() { return [] },
  } as unknown as TicketRepository

  const agents = {
    async findById() { return input.agent },
    async findMany() { return input.agent ? [input.agent] : [] },
  } as unknown as AgentRepository

  const tenants = {
    async findById() { return input.tenant },
    async findBySlug() { return input.tenant },
    async findMany() { return input.tenant ? [input.tenant] : [] },
  } as unknown as TenantRepository

  const launcher: HarnessLauncher = {
    mode: 'local-wiki',
    async launch({ ticketId }) {
      launched.push(ticketId)
      return { jobId: `job-${ticketId}` }
    },
  }

  const dispatcher = new DispatcherService(
    tickets,
    audit,
    noUsage,
    launcher,
    { maxCallsPerDay: 100, maxTokensPerDay: 100_000 },
    async () => true,
    agents,
    undefined,
    undefined,
    undefined,
    tenants,
  )

  return { dispatcher, events, launched }
}

async function main() {
  console.log('=== Tenant-státusz kapu az automata (dispatcher) úton ===\n')

  await check('TS-1: `active` tenant → a dispatch elindul', async () => {
    const { dispatcher, launched } = makeDispatcher({
      ticket: makeTicket(),
      agent: makeAgent(),
      tenant: makeTenant('active'),
    })

    const [result] = await dispatcher.dispatchReadyBatch()
    assert.equal(result.status, 'started')
    assert.equal(launched.length, 1)
  })

  await check('TS-2: `suspended` tenant → skipped + `tenant_inactive`, nem indul semmi', async () => {
    const { dispatcher, launched } = makeDispatcher({
      ticket: makeTicket(),
      agent: makeAgent(),
      tenant: makeTenant('suspended'),
    })

    const [result] = await dispatcher.dispatchReadyBatch()
    assert.equal(result.status, 'skipped')
    assert.equal(result.reason, 'tenant_inactive')
    assert.equal(launched.length, 0)
  })

  await check('TS-3: `offboarding` és `archived` tenant is tilt', async () => {
    for (const status of ['offboarding', 'archived'] as const) {
      const { dispatcher, launched } = makeDispatcher({
        ticket: makeTicket(),
        agent: makeAgent(),
        tenant: makeTenant(status),
      })

      const [result] = await dispatcher.dispatchReadyBatch()
      assert.equal(result.status, 'skipped', `${status}: nem lett skipped`)
      assert.equal(result.reason, 'tenant_inactive', `${status}: rossz indok`)
      assert.equal(launched.length, 0, `${status}: mégis elindult`)
    }
  })

  await check('TS-4: a tiltás auditált, a tenant-státusszal együtt', async () => {
    const { dispatcher, events } = makeDispatcher({
      ticket: makeTicket(),
      agent: makeAgent(),
      tenant: makeTenant('suspended'),
    })

    await dispatcher.dispatchReadyBatch()
    const denied = events.find((e) => e.action === 'dispatch.tenant_inactive')
    assert.ok(denied, 'nincs `dispatch.tenant_inactive` audit-sor')
    assert.equal(denied.policyDecision, 'denied')
    assert.equal(denied.outputRef, 'suspended')
    assert.equal(denied.tenantId, TENANT_A)
    assert.equal((denied.metadata as Record<string, unknown>).tenantStatus, 'suspended')
  })

  await check('TS-5: hiányzó tenant-sor → fail-closed', async () => {
    const { dispatcher, events, launched } = makeDispatcher({
      ticket: makeTicket(),
      agent: makeAgent(),
      tenant: null,
    })

    const [result] = await dispatcher.dispatchReadyBatch()
    assert.equal(result.status, 'skipped')
    assert.equal(result.reason, 'tenant_inactive')
    assert.equal(launched.length, 0)
    const denied = events.find((e) => e.action === 'dispatch.tenant_inactive')
    assert.equal(denied?.outputRef, 'missing')
  })

  await check('TS-6: valóban platform-szintű munka (ticket + agent tenant nélkül) fut', async () => {
    const { dispatcher, launched } = makeDispatcher({
      ticket: makeTicket({ tenantId: null }),
      agent: makeAgent({ tenantId: null }),
      // A tenant-repo `suspended`-et adna vissza — de tenant nélküli munkánál meg sem kérdezzük.
      tenant: makeTenant('suspended'),
    })

    const [result] = await dispatcher.dispatchReadyBatch()
    assert.equal(result.status, 'started')
    assert.equal(launched.length, 1)
  })

  await check('TS-7: suspended tenant tickete MEGOSZTOTT platform-agenthez rendelve is tilt', async () => {
    // A megosztott agent (`tenantId === null`) az `isAgentReachableFromTenant` szerint
    // minden tenantból elérhető. Ha a kapu az agent tulajdonosára kulcsolna, ez a
    // konfiguráció megkerülné a felfüggesztést — a munka a tenant adatán dolgozna.
    const { dispatcher, events, launched } = makeDispatcher({
      ticket: makeTicket({ tenantId: TENANT_A }),
      agent: makeAgent({ tenantId: null }),
      tenant: makeTenant('suspended'),
    })

    const [result] = await dispatcher.dispatchReadyBatch()
    assert.equal(result.status, 'skipped')
    assert.equal(result.reason, 'tenant_inactive')
    assert.equal(launched.length, 0)
    const denied = events.find((e) => e.action === 'dispatch.tenant_inactive')
    assert.equal(denied?.tenantId, TENANT_A)
  })

  await check('TS-8: minden kiírt audit-action szerepel az esemény-katalógusban', async () => {
    // A tesztek hamis AuditRepositoryt használnak, ami NEM validál — élesben viszont a
    // `PostgresAuditRepository` dob a nem regisztrált actionre. Ez a teszt zárja a rést.
    const { assertAuditActionRegistered } = await import('../src/lib/audit/event-catalog')
    assert.doesNotThrow(() => assertAuditActionRegistered('dispatch.tenant_inactive'))
  })

  console.log(
    failures === 0
      ? '\n✅ Minden tenant-státusz kapu teszt zöld'
      : `\n❌ ${failures} teszt bukott`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

void main()
