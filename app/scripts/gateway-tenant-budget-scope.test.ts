/**
 * Keret- és routing-kapu szervezet-helyessége a Model Gateway határán.
 *
 * Futtatás: npx tsx scripts/gateway-tenant-budget-scope.test.ts
 *
 * ÜZLETI HÁTTÉR: a futásidejű hívási utak (chat tool-loop, ticket-dispatch) nem
 * visznek `tenantId`-t a gateway-nek, ezért a kapu tenant-vakon értékelt: egy MÁSIK
 * szervezet napi kerete állította meg ezt az agentet, holott a saját, magasabb kerete
 * még bőven élt. A felhasználó ebből csak annyit látott, hogy a feladat
 * „Végrehajtásra vár"-ban ragad — a blokkoló keretsor a saját felületén nem is látszik.
 *
 * GT-1: hívói `tenantId` nélkül is a saját szervezet kerete dönt (idegen tenant nem blokkol).
 * GT-2: a saját szervezet kerete továbbra is blokkol (a javítás nem fail-open).
 * GT-3: a platform-szintű (`tenantId: null`) keret minden szervezetre érvényes marad.
 * GT-4: a routing-policy lekérdezés is a feloldott szervezetet kapja.
 * GT-5: a feloldó hibája nem buktatja a modellhívást — csak a platform-szintű keret él.
 * GT-6: az explicit hívói `tenantId` erősebb a feloldásnál.
 */

import assert from 'node:assert/strict'
import {
  ModelGateway,
  GatewayBudgetError,
  type AgentTenantResolver,
  type ModelProvider,
} from '../src/domain/gateway/model-gateway'
import { BudgetEngine } from '../src/domain/gateway/budget-engine'
import { RoutingEngine } from '../src/domain/gateway/routing-engine'
import type {
  AuditRepository,
  ModelBudgetRepository,
  ModelCallRepository,
  ModelRoutingPolicyRepository,
} from '../src/repositories/interfaces'
import type { AuditLog, ModelBudget, ModelCall, ModelRoutingPolicy } from '@prisma/client'

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

/** „Demo" szervezet — szigorú per-agent alapértelmezéssel. */
const TENANT_OTHER = 'aaaaaaaa-0000-4000-8000-00000000000a'
/** „Ostorosbor" szervezet — az agent itt él, magasabb nevesített kerettel. */
const TENANT_OWN = 'bbbbbbbb-0000-4000-8000-00000000000b'
const AGENT_ID = 'bbbbbbbb-0000-4000-8000-000000000001'

/** Az agent 24 órás fogyasztása: a szigorú idegen keret fölött, a sajátja alatt. */
const AGENT_TOKENS = 11_592_963

function budgetRow(over: Partial<ModelBudget>): ModelBudget {
  return {
    id: crypto.randomUUID(),
    tenantId: TENANT_OWN,
    scope: 'agent',
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

function makeAuditRepo(): AuditRepository {
  const events: AuditLog[] = []
  return {
    async append(data) {
      const row = { id: crypto.randomUUID(), createdAt: new Date(), ...data } as AuditLog
      events.push(row)
      return row
    },
    async findMany() { return events },
    async findAll() { return events },
    async getActionCounts() { return {} },
  } as AuditRepository
}

function makeModelCallRepo(): ModelCallRepository {
  const usage = { calls: 387, tokens: AGENT_TOKENS }
  return {
    async create(data) { return { id: crypto.randomUUID(), createdAt: new Date(), ...data } as ModelCall },
    async getCostSummary() { return { tokens: 0, cost: 0 } },
    async getUsageForAgentSince() { return usage },
    async getUsageForTicket() { return { calls: 0, tokens: 0 } },
    async getUsageForAgent() { return usage },
    async getUsageForTenant() { return usage },
    async getUsageForTicketType() { return usage },
    async getUsageByAgent() { return [{ agentId: AGENT_ID, ...usage }] },
    async getGovernanceSummary() {
      return { calls: 0, tokens: 0, cost: 0, avgLatencyMs: 0, okCalls: 0, errorCalls: 0, rateLimitedCalls: 0 }
    },
    async getPerTicketBreakdown() { return [] },
  }
}

/**
 * A `PostgresModelBudgetRepository.findApplicable` javított szemantikáját utánozza:
 * a tenant-szűrő MINDIG érvényes, hiányzó `tenantId` esetén csak a platform-szintű sorok.
 * A kapott filtereket rögzíti, hogy a teszt lássa, milyen szervezettel kérdeztünk.
 */
function makeBudgetRepo(rows: ModelBudget[]): {
  repo: ModelBudgetRepository
  seenTenantIds: Array<string | null | undefined>
} {
  const seenTenantIds: Array<string | null | undefined> = []
  const repo = {
    async list() { return rows },
    async findById(id: string) { return rows.find((r) => r.id === id) ?? null },
    async create(data: Partial<ModelBudget>) { return budgetRow(data) },
    async update(id: string, data: Partial<ModelBudget>) {
      return { ...rows.find((r) => r.id === id)!, ...data } as ModelBudget
    },
    async delete() {},
    async findApplicable(filter: { tenantId?: string | null; agentId?: string; ticketType?: string }) {
      seenTenantIds.push(filter.tenantId)
      const scopeOrder = { ticket_type: 0, agent: 1, tenant: 2 } as const
      return rows
        .filter((r) => {
          if (r.tenantId !== null && r.tenantId !== filter.tenantId) return false
          if (r.scope === 'tenant') return true
          if (r.scope === 'agent') return r.scopeRef === null || r.scopeRef === filter.agentId
          return r.scopeRef === filter.ticketType
        })
        .sort((a, b) => scopeOrder[a.scope] - scopeOrder[b.scope])
    },
  } as unknown as ModelBudgetRepository
  return { repo, seenTenantIds }
}

function makeRoutingRepo(): {
  repo: ModelRoutingPolicyRepository
  seenTenantIds: Array<string | undefined>
} {
  const seenTenantIds: Array<string | undefined> = []
  const repo = {
    async list() { return [] },
    async findById() { return null },
    async create(data: Partial<ModelRoutingPolicy>) { return data as ModelRoutingPolicy },
    async update(_id: string, data: Partial<ModelRoutingPolicy>) { return data as ModelRoutingPolicy },
    async delete() {},
    async findForRouting(filter: { tenantId?: string }) {
      seenTenantIds.push(filter.tenantId)
      return []
    },
  } as unknown as ModelRoutingPolicyRepository
  return { repo, seenTenantIds }
}

function makeProviders(): { providers: Map<string, ModelProvider>; calls: { n: number } } {
  const calls = { n: 0 }
  const providers = new Map<string, ModelProvider>([
    [
      'chatgpt-oauth',
      {
        name: 'chatgpt-oauth',
        async chat() {
          calls.n++
          return { content: 'kész', latencyMs: 1 }
        },
      },
    ],
  ])
  return { providers, calls }
}

function makeGateway(input: {
  budgets: ModelBudget[]
  resolver?: AgentTenantResolver
}) {
  const budgetRepo = makeBudgetRepo(input.budgets)
  const routingRepo = makeRoutingRepo()
  const { providers, calls } = makeProviders()
  const gateway = new ModelGateway(
    makeAuditRepo(),
    makeModelCallRepo(),
    providers,
    { maxCallsPerTicket: 1000 },
    new RoutingEngine(routingRepo.repo),
    new BudgetEngine(budgetRepo.repo, makeModelCallRepo()),
    undefined,
    undefined,
    undefined,
    input.resolver ?? {
      async tenantIdForAgent() { return TENANT_OWN },
    },
  )
  return { gateway, budgetRepo, routingRepo, providerCalls: calls }
}

function callParams(over: Record<string, unknown> = {}) {
  return {
    agentId: AGENT_ID,
    messages: [{ role: 'user' as const, content: 'tulajdoni lap feldolgozás' }],
    modelConfig: { provider: 'chatgpt-oauth', model: 'chatgpt-oauth-default' },
    ...over,
  }
}

async function main() {
  console.log('\n=== Gateway keret-kapu: szervezet-helyesség ===\n')

  await check(
    'GT-1: idegen szervezet szigorú per-agent kerete NEM blokkolja a másik szervezet agentjét',
    async () => {
      const { gateway, budgetRepo, providerCalls } = makeGateway({
        budgets: [
          // „Demo" alapértelmezése minden agentjére: 10M token — ez fogta meg élesben.
          budgetRow({ tenantId: TENANT_OTHER, scope: 'agent', scopeRef: null, tokenLimit: 10_000_000 }),
          // A saját szervezet nevesített kerete erre az agentre: 25M.
          budgetRow({ tenantId: TENANT_OWN, scope: 'agent', scopeRef: AGENT_ID, tokenLimit: 25_000_000 }),
        ],
      })

      // A hívó szándékosan NEM ad tenantId-t — pontosan úgy, ahogy a tool-loop hív.
      const result = await gateway.call(callParams())
      assert.equal(result.content, 'kész')
      assert.equal(providerCalls.n, 1)
      assert.deepEqual(budgetRepo.seenTenantIds, [TENANT_OWN])
    },
  )

  await check('GT-2: a SAJÁT szervezet kerete továbbra is blokkol', async () => {
    const { gateway, providerCalls } = makeGateway({
      budgets: [budgetRow({ tenantId: TENANT_OWN, scope: 'agent', scopeRef: null, tokenLimit: 10_000_000 })],
    })

    await assert.rejects(() => gateway.call(callParams()), GatewayBudgetError)
    assert.equal(providerCalls.n, 0, 'blokkolt kereten a providert nem hívjuk')
  })

  await check('GT-3: a platform-szintű keret minden szervezetre érvényes marad', async () => {
    const { gateway, providerCalls } = makeGateway({
      budgets: [budgetRow({ tenantId: null, scope: 'agent', scopeRef: null, tokenLimit: 1_000_000 })],
    })

    await assert.rejects(() => gateway.call(callParams()), GatewayBudgetError)
    assert.equal(providerCalls.n, 0)
  })

  await check('GT-4: a routing-policy lekérdezés is a feloldott szervezetet kapja', async () => {
    const { gateway, routingRepo } = makeGateway({ budgets: [] })

    await gateway.call(callParams())
    assert.deepEqual(routingRepo.seenTenantIds, [TENANT_OWN])
  })

  await check('GT-5: a feloldó hibája nem buktatja a hívást — csak a platform-szintű keret él', async () => {
    const { gateway, budgetRepo, providerCalls } = makeGateway({
      budgets: [
        budgetRow({ tenantId: TENANT_OTHER, scope: 'agent', scopeRef: null, tokenLimit: 10_000_000 }),
      ],
      resolver: {
        async tenantIdForAgent() {
          throw new Error('DB nem elérhető')
        },
      },
    })

    const result = await gateway.call(callParams())
    assert.equal(result.content, 'kész')
    assert.equal(providerCalls.n, 1)
    assert.deepEqual(budgetRepo.seenTenantIds, [null], 'ismeretlen szervezet → csak platform-szintű keret')
  })

  await check('GT-6: az explicit hívói tenantId erősebb a feloldásnál', async () => {
    const { gateway, budgetRepo } = makeGateway({
      budgets: [],
      resolver: {
        async tenantIdForAgent() { return TENANT_OWN },
      },
    })

    await gateway.call(callParams({ tenantId: TENANT_OTHER }))
    assert.deepEqual(budgetRepo.seenTenantIds, [TENANT_OTHER])
  })

  console.log('\n=== Összesítés ===')
  if (failures > 0) {
    console.log(`${failures} teszt BUKOTT`)
    process.exit(1)
  }
  console.log('Minden teszt zöld (MIND OK)')
}

void main()
