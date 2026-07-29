/**
 * Napi model-keret: hatókör-helyes mérés + a dispatcher kétkapus budget-ellenőrzése.
 *
 * Futtatás: npx tsx scripts/dispatch-budget.test.ts
 *
 * DB-1: `scope=tenant` keretet a TENANT összesített forgalmán mérjük (nem az agentén).
 * DB-2: `scope=agent` keretet az agent saját forgalmán mérjük.
 * DB-3: `scope=agent` + `scopeRef=null` = per-agent alapértelmezés a bucket minden agentjére.
 * DB-4: a tenant-keret akkor is blokkol, ha az egyes agentek külön-külön a keret alatt vannak.
 * DB-5: `hardCap=false` keret nem blokkol.
 * DB-6: keret nélkül az env-mentsvár dönt (sosem esünk keret nélküli állapotba).
 * DB-7: a dispatcher a `budget_blocked` audit sorba beírja, MELYIK hatókör fogta meg.
 * DB-8: minden `skipped` ág indokot ad vissza (korábban kettő némán tűnt el).
 */

import assert from 'node:assert/strict'
import type { Agent, ModelBudget, Prisma, Ticket } from '@prisma/client'
import { BudgetEngine } from '../src/domain/gateway/budget-engine'
import { DispatcherService, type HarnessLauncher } from '../src/domain/dispatcher/dispatcher-service'
import type {
  AgentRepository,
  AuditRepository,
  ModelBudgetRepository,
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
const AGENT_2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const TICKET_ID = 'aaaaaaaa-0000-4000-8000-0000000000f1'

function budget(over: Partial<ModelBudget>): ModelBudget {
  return {
    id: crypto.randomUUID(),
    tenantId: TENANT_A,
    scope: 'tenant',
    scopeRef: null,
    period: 'day',
    callLimit: null,
    tokenLimit: null,
    softThreshold: null,
    hardCap: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ModelBudget
}

/** Agentenkénti forgalom; a tenant-összeg ebből származik, ahogy élesben a join is. */
function makeModelCalls(perAgent: Record<string, { calls: number; tokens: number }>): ModelCallRepository {
  const total = Object.values(perAgent).reduce(
    (acc, u) => ({ calls: acc.calls + u.calls, tokens: acc.tokens + u.tokens }),
    { calls: 0, tokens: 0 },
  )
  return {
    async create(data) { return data as never },
    async getCostSummary() { return { tokens: 0, cost: 0 } },
    async getUsageForAgentSince(agentId) { return perAgent[agentId] ?? { calls: 0, tokens: 0 } },
    async getUsageForTicket() { return { calls: 0, tokens: 0 } },
    async getUsageForAgent(agentId) { return perAgent[agentId] ?? { calls: 0, tokens: 0 } },
    async getUsageForTenant() { return total },
    async getUsageForTicketType() { return total },
    async getUsageByAgent() {
      return Object.entries(perAgent).map(([agentId, u]) => ({ agentId, ...u }))
    },
    async getGovernanceSummary() {
      return { calls: 0, tokens: 0, cost: 0, avgLatencyMs: 0, okCalls: 0, errorCalls: 0, rateLimitedCalls: 0 }
    },
    async getPerTicketBreakdown() { return [] },
  }
}

/** A `findApplicable` valódi szűrését utánozza: tenant + platform sorok, agent-scope illesztéssel. */
function makeBudgets(rows: ModelBudget[]): ModelBudgetRepository {
  return {
    async list() { return rows },
    async findById(id) { return rows.find((r) => r.id === id) ?? null },
    async create(data) { return { ...budget({}), ...data } as ModelBudget },
    async update(id, data) { return { ...rows.find((r) => r.id === id)!, ...data } as ModelBudget },
    async delete() {},
    async findApplicable(filter) {
      const scopeOrder = { ticket_type: 0, agent: 1, tenant: 2 } as const
      return rows
        .filter((r) => {
          if (filter.tenantId !== undefined && r.tenantId !== null && r.tenantId !== filter.tenantId) {
            return false
          }
          if (filter.tenantId === null && r.tenantId !== null) return false
          if (r.scope === 'tenant') return true
          if (r.scope === 'agent') return r.scopeRef === null || r.scopeRef === filter.agentId
          return r.scopeRef === filter.ticketType
        })
        .sort((a, b) => scopeOrder[a.scope] - scopeOrder[b.scope])
    },
  }
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

function makeTicket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: TICKET_ID,
    tenantId: TENANT_A,
    type: 'interaction',
    title: 'budget gate',
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

/** Dispatcher a valós kapukkal, in-memory repókkal; a launcher csak jelzi, hogy elindult. */
function makeDispatcher(input: {
  ticket: Ticket
  agent: Agent | null
  perAgentUsage: Record<string, { calls: number; tokens: number }>
  budgets: ModelBudget[]
  useEngine?: boolean
  lockable?: boolean
}) {
  const { repo: audit, events } = makeAudit()
  const modelCalls = makeModelCalls(input.perAgentUsage)
  const launched: string[] = []

  const tickets = {
    async findReadyForDispatch() { return [input.ticket] },
    async findById() { return input.ticket },
    async acquireDispatchLock() { return input.lockable === false ? null : input.ticket },
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
    async findById(id: string) {
      return id === TENANT_A
        ? ({ id: TENANT_A, status: 'active' } as never)
        : null
    },
  } as unknown as TenantRepository

  const launcher: HarnessLauncher = {
    mode: 'local-wiki',
    async launch({ ticketId }) {
      launched.push(ticketId)
      return { jobId: `job-${ticketId}` }
    },
  }

  const engine = input.useEngine === false
    ? undefined
    : new BudgetEngine(makeBudgets(input.budgets), modelCalls)

  const dispatcher = new DispatcherService(
    tickets,
    audit,
    modelCalls,
    launcher,
    { maxCallsPerDay: 100, maxTokensPerDay: 100_000 },
    async () => true,
    agents,
    undefined,
    undefined,
    engine,
    tenants,
  )

  return { dispatcher, events, launched }
}

async function main() {
  console.log('=== Napi model-keret: hatókör + dispatcher-kapu ===\n')

  // ── DB-1..DB-3: a BudgetEngine a keret hatókörén mér ──────────────────────
  await check('DB-1: scope=tenant keretet a tenant összesített forgalmán méri, nem az agentén', async () => {
    // Agent-1 önmagában bőven a keret alatt van (100 token), de a tenant összesen 900.
    const modelCalls = makeModelCalls({ [AGENT_1]: { calls: 1, tokens: 100 }, [AGENT_2]: { calls: 8, tokens: 800 } })
    const engine = new BudgetEngine(makeBudgets([budget({ scope: 'tenant', tokenLimit: 500 })]), modelCalls)

    const result = await engine.check({ tenantId: TENANT_A, agentId: AGENT_1 })
    assert.equal(result.allowed, false, 'a tenant-keret nem blokkolt, pedig 900 > 500')
    if (!result.allowed) assert.match(result.reason, /900\/500/)
  })

  await check('DB-2: scope=agent keretet az agent saját forgalmán méri', async () => {
    const modelCalls = makeModelCalls({ [AGENT_1]: { calls: 1, tokens: 100 }, [AGENT_2]: { calls: 8, tokens: 800 } })
    const engine = new BudgetEngine(
      makeBudgets([budget({ scope: 'agent', scopeRef: AGENT_1, tokenLimit: 500 })]),
      modelCalls,
    )

    const result = await engine.check({ tenantId: TENANT_A, agentId: AGENT_1 })
    assert.equal(result.allowed, true, 'agent-1 csak 100 tokent használt, nem szabadna blokkolni')
  })

  await check('DB-3: scope=agent + scopeRef=null a bucket MINDEN agentjére külön-külön érvényes', async () => {
    const modelCalls = makeModelCalls({ [AGENT_1]: { calls: 1, tokens: 100 }, [AGENT_2]: { calls: 8, tokens: 800 } })
    const engine = new BudgetEngine(
      makeBudgets([budget({ scope: 'agent', scopeRef: null, tokenLimit: 500 })]),
      modelCalls,
    )

    const forAgent1 = await engine.check({ tenantId: TENANT_A, agentId: AGENT_1 })
    const forAgent2 = await engine.check({ tenantId: TENANT_A, agentId: AGENT_2 })
    assert.equal(forAgent1.allowed, true, 'agent-1 (100 token) a per-agent keret alatt van')
    assert.equal(forAgent2.allowed, false, 'agent-2 (800 token) átlépte a per-agent keretet')
  })

  await check('DB-4: a tenant-keret akkor is blokkol, ha minden agent külön-külön a keret alatt van', async () => {
    // Két agent 300-300 token: per-agent keret (500) alatt, tenant keret (500) fölött.
    const modelCalls = makeModelCalls({ [AGENT_1]: { calls: 3, tokens: 300 }, [AGENT_2]: { calls: 3, tokens: 300 } })
    const engine = new BudgetEngine(
      makeBudgets([
        budget({ scope: 'tenant', tokenLimit: 500 }),
        budget({ scope: 'agent', scopeRef: null, tokenLimit: 500 }),
      ]),
      modelCalls,
    )

    const result = await engine.check({ tenantId: TENANT_A, agentId: AGENT_1 })
    assert.equal(result.allowed, false, 'a tenant-összeg (600) átlépte az 500-as keretet')
  })

  await check('DB-4b: a NEVESÍTETT agent-keret felülírja az alapértelmezést (nem ÉS-ben értékel)', async () => {
    // Üzleti eset: egy sok eszközhívást igénylő agent (nagy dokumentum-feldolgozás)
    // magasabb keretet kap, a többi agent marad az alapértelmezésen. E nélkül az
    // egész szervezet keretét kellene megemelni.
    const modelCalls = makeModelCalls({ [AGENT_1]: { calls: 8, tokens: 800 }, [AGENT_2]: { calls: 8, tokens: 800 } })
    const engine = new BudgetEngine(
      makeBudgets([
        budget({ scope: 'agent', scopeRef: null, tokenLimit: 500 }),
        budget({ scope: 'agent', scopeRef: AGENT_1, tokenLimit: 2_000 }),
      ]),
      modelCalls,
    )

    const forAgent1 = await engine.check({ tenantId: TENANT_A, agentId: AGENT_1 })
    const forAgent2 = await engine.check({ tenantId: TENANT_A, agentId: AGENT_2 })
    assert.equal(forAgent1.allowed, true, 'a nevesített 2000-es keret alatt van (800)')
    assert.equal(forAgent2.allowed, false, 'a többi agentre marad az 500-as alapértelmezés')
  })

  await check('DB-4c: a kivétel csak a saját hatókörét oldja fel — a tenant-keret marad', async () => {
    const modelCalls = makeModelCalls({ [AGENT_1]: { calls: 8, tokens: 800 } })
    const engine = new BudgetEngine(
      makeBudgets([
        budget({ scope: 'tenant', tokenLimit: 500 }),
        budget({ scope: 'agent', scopeRef: null, tokenLimit: 500 }),
        budget({ scope: 'agent', scopeRef: AGENT_1, tokenLimit: 2_000 }),
      ]),
      modelCalls,
    )
    const result = await engine.check({ tenantId: TENANT_A, agentId: AGENT_1 })
    assert.equal(result.allowed, false, 'a szervezeti keret nem oldható fel per-agent kivétellel')
  })

  await check('DB-5: hardCap=false keret nem blokkol', async () => {
    const modelCalls = makeModelCalls({ [AGENT_1]: { calls: 99, tokens: 99_000 } })
    const engine = new BudgetEngine(
      makeBudgets([budget({ scope: 'tenant', tokenLimit: 10, hardCap: false })]),
      modelCalls,
    )
    const result = await engine.check({ tenantId: TENANT_A, agentId: AGENT_1 })
    assert.equal(result.allowed, true, 'soft cap nem blokkolhat')
  })

  // ── DB-6..DB-7: dispatcher-kapu ──────────────────────────────────────────
  await check('DB-6: egyetlen keret sincs → env-mentsvár dönt (nincs keret nélküli állapot)', async () => {
    const { dispatcher, launched } = makeDispatcher({
      ticket: makeTicket(),
      agent: makeAgent(),
      perAgentUsage: { [AGENT_1]: { calls: 0, tokens: 150_000 } }, // > env 100_000
      budgets: [],
    })

    const [result] = await dispatcher.dispatchReadyBatch()
    assert.equal(result.status, 'budget_blocked', 'az env-mentsvárnak blokkolnia kellett volna')
    assert.equal(launched.length, 0, 'a launcher nem futhat le blokkolt ticketen')
  })

  await check('DB-6b: env-mentsvár alatt a ticket elindul', async () => {
    const { dispatcher, launched } = makeDispatcher({
      ticket: makeTicket(),
      agent: makeAgent(),
      perAgentUsage: { [AGENT_1]: { calls: 1, tokens: 500 } },
      budgets: [],
    })

    const [result] = await dispatcher.dispatchReadyBatch()
    assert.equal(result.status, 'started')
    assert.deepEqual(launched, [TICKET_ID])
  })

  await check('DB-7: a budget_blocked audit sor tartalmazza, MELYIK hatókör fogta meg', async () => {
    const { dispatcher, events } = makeDispatcher({
      ticket: makeTicket(),
      agent: makeAgent(),
      perAgentUsage: { [AGENT_1]: { calls: 1, tokens: 100 }, [AGENT_2]: { calls: 1, tokens: 800 } },
      budgets: [budget({ scope: 'tenant', tokenLimit: 500 })],
    })

    const [result] = await dispatcher.dispatchReadyBatch()
    assert.equal(result.status, 'budget_blocked')

    const blocked = events.find((e) => e.action === 'dispatch.budget_blocked')
    assert.ok(blocked, 'nincs dispatch.budget_blocked audit sor')
    assert.equal(blocked.outputRef, 'tenant', 'a hatókörnek a sorban kell lennie')
    const metadata = blocked.metadata as Record<string, unknown>
    assert.equal(metadata.scope, 'tenant')
    assert.match(String(metadata.reason), /900\/500/)
  })

  await check('DB-7b: a per-agent keret hatóköre `agent`-ként jelenik meg az auditban', async () => {
    const { dispatcher, events } = makeDispatcher({
      ticket: makeTicket(),
      agent: makeAgent(),
      perAgentUsage: { [AGENT_1]: { calls: 1, tokens: 900 } },
      budgets: [budget({ scope: 'agent', scopeRef: null, tokenLimit: 500 })],
    })

    const [result] = await dispatcher.dispatchReadyBatch()
    assert.equal(result.status, 'budget_blocked')
    const blocked = events.find((e) => e.action === 'dispatch.budget_blocked')
    assert.equal(blocked?.outputRef, 'agent')
  })

  // ── DB-8: minden skipped ág indokot ad ───────────────────────────────────
  await check('DB-8: inaktív agent → skipped + `agent_inactive` indok', async () => {
    const { dispatcher, launched } = makeDispatcher({
      ticket: makeTicket(),
      agent: makeAgent({ status: 'draft' }),
      perAgentUsage: {},
      budgets: [],
    })

    const [result] = await dispatcher.dispatchReadyBatch()
    assert.equal(result.status, 'skipped')
    assert.equal(result.reason, 'agent_inactive')
    assert.equal(launched.length, 0)
  })

  await check('DB-8b: elvesztett lock → skipped + `lock_lost` indok (korábban némán tűnt el)', async () => {
    const { dispatcher } = makeDispatcher({
      ticket: makeTicket(),
      agent: makeAgent(),
      perAgentUsage: {},
      budgets: [],
      lockable: false,
    })

    const [result] = await dispatcher.dispatchReadyBatch()
    assert.equal(result.status, 'skipped')
    assert.equal(result.reason, 'lock_lost')
  })

  await check('DB-8c: agent nélküli ticket → skipped + `no_agent` indok', async () => {
    const { dispatcher } = makeDispatcher({
      ticket: makeTicket({ agentId: null }),
      agent: makeAgent(),
      perAgentUsage: {},
      budgets: [],
    })

    const [result] = await dispatcher.dispatchReadyBatch()
    assert.equal(result.status, 'skipped')
    assert.equal(result.reason, 'no_agent')
  })

  console.log('\n=== Összesítés ===')
  if (failures > 0) {
    console.log(`${failures} teszt BUKOTT`)
    process.exit(1)
  }
  console.log('Minden teszt zöld (MIND OK)')
}

void main()
