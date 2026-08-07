/**
 * Tenant budget usage where — platform-agent work-owner attribution.
 *
 * Futtatás: npx tsx scripts/model-call-budget-where.test.ts
 *
 * ÜZLETI HÁTTÉR: a chat/task runtime a ticket/conversation `tenantId`-ját adja a
 * gateway budget-kapunak. A megosztott (platform, `agent.tenantId = null`) agentek
 * hívásai eddig csak a platform-bucketbe estek, ezért a szervezet hard cap-je nem
 * látta a fő költségsávot — a keret soha nem ugrott be.
 *
 * BW-1: konkrét tenant where tartalmazza a saját agenteket.
 * BW-2: konkrét tenant where tartalmazza a platform-agent ticket work-owner ágat.
 * BW-3: konkrét tenant where tartalmazza a platform-agent conversation work-owner ágat.
 * BW-4: platform-bucket (`tenantId: null`) továbbra is csak `agent.tenantId = null`.
 * BW-5: ticket_type where platform-agent + work-owner ticketet is mér.
 * BW-6: BudgetEngine hard cap blokkol, ha a tenant usage a platform-agent forgalmat is tartalmazza.
 */

import assert from 'node:assert/strict'
import type { ModelBudget } from '@prisma/client'
import { BudgetEngine } from '../src/domain/gateway/budget-engine'
import {
  modelCallWhereForTenantUsage,
  modelCallWhereForTicketTypeUsage,
} from '../src/lib/model-call-budget-where'
import type { ModelBudgetRepository, ModelCallRepository } from '../src/repositories/interfaces'

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

const TENANT = 'bbbbbbbb-0000-4000-8000-00000000000b'
const PLATFORM_AGENT = 'cccccccc-0000-4000-8000-0000000000c1'
const FIXED_NOW = new Date('2026-08-07T01:00:00.000Z')

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object')
  return value as Record<string, unknown>
}

async function main() {
  console.log('model-call-budget-where')

  await check('BW-1: tenant where includes own-tenant agents', () => {
    const where = modelCallWhereForTenantUsage(TENANT, 'day', FIXED_NOW)
    const or = where.OR
    assert.ok(Array.isArray(or))
    assert.ok(or.some((branch) => {
      const agent = asRecord(asRecord(branch).agent)
      return agent.tenantId === TENANT
    }))
  })

  await check('BW-2: tenant where includes platform-agent ticket work-owner', () => {
    const where = modelCallWhereForTenantUsage(TENANT, 'day', FIXED_NOW)
    const or = where.OR
    assert.ok(Array.isArray(or))
    const platformBranch = or.find((branch) => {
      const and = asRecord(branch).AND
      return Array.isArray(and)
    })
    assert.ok(platformBranch, 'platform AND branch missing')
    const and = asRecord(platformBranch).AND as unknown[]
    assert.ok(
      and.some((part) => asRecord(asRecord(part).agent).tenantId === null),
      'platform agent filter missing',
    )
    const workOwner = and.find((part) => Array.isArray(asRecord(part).OR))
    assert.ok(workOwner)
    const workOr = asRecord(workOwner).OR as unknown[]
    assert.ok(
      workOr.some((part) => {
        const ticket = asRecord(part).ticket
        return !!ticket && asRecord(ticket).tenantId === TENANT
      }),
      'ticket work-owner filter missing',
    )
  })

  await check('BW-3: tenant where includes platform-agent conversation work-owner', () => {
    const where = modelCallWhereForTenantUsage(TENANT, 'day', FIXED_NOW)
    const or = where.OR
    assert.ok(Array.isArray(or))
    const platformBranch = or.find((branch) => Array.isArray(asRecord(branch).AND))
    assert.ok(platformBranch)
    const and = asRecord(platformBranch).AND as unknown[]
    const workOwner = and.find((part) => Array.isArray(asRecord(part).OR))
    assert.ok(workOwner)
    const workOr = asRecord(workOwner).OR as unknown[]
    assert.ok(
      workOr.some((part) => {
        const conversation = asRecord(part).conversation
        return !!conversation && asRecord(conversation).tenantId === TENANT
      }),
      'conversation work-owner filter missing',
    )
  })

  await check('BW-4: platform bucket stays agent.tenantId=null only', () => {
    const where = modelCallWhereForTenantUsage(null, 'day', FIXED_NOW)
    assert.equal(asRecord(where.agent).tenantId, null)
    assert.equal(where.OR, undefined)
  })

  await check('BW-5: ticket_type where counts platform-agent work-owner tickets', () => {
    const where = modelCallWhereForTicketTypeUsage(TENANT, 'interaction', 'day', FIXED_NOW)
    const or = where.OR
    assert.ok(Array.isArray(or))
    assert.ok(
      or.some((branch) => {
        const row = asRecord(branch)
        return (
          asRecord(row.agent).tenantId === null &&
          asRecord(row.ticket).type === 'interaction' &&
          asRecord(row.ticket).tenantId === TENANT
        )
      }),
      'platform + ticket type/tenant branch missing',
    )
  })

  await check('BW-6: BudgetEngine hard-caps when usage includes platform-agent spend', async () => {
    const budget: ModelBudget = {
      id: crypto.randomUUID(),
      tenantId: TENANT,
      scope: 'tenant',
      scopeRef: null,
      period: 'day',
      callLimit: null,
      tokenLimit: 1_000_000,
      softThreshold: null,
      hardCap: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    const budgets: ModelBudgetRepository = {
      async list() { return [budget] },
      async findById() { return budget },
      async create() { return budget },
      async update() { return budget },
      async delete() {},
      async findApplicable() { return [budget] },
    }

    // A repo a javított where szerint már beleszámolja a platform-agent forgalmat.
    const modelCalls: ModelCallRepository = {
      async create(data) { return data as never },
      async getCostSummary() { return { tokens: 0, cost: 0 } },
      async getUsageForAgentSince() { return { calls: 0, tokens: 0 } },
      async getUsageForTicket() { return { calls: 0, tokens: 0 } },
      async getUsageForAgent() { return { calls: 0, tokens: 0 } },
      async getUsageForTenant() { return { calls: 40, tokens: 1_250_000 } },
      async getUsageForTicketType() { return { calls: 40, tokens: 1_250_000 } },
      async getUsageByAgent() {
        return [{ agentId: PLATFORM_AGENT, calls: 40, tokens: 1_250_000 }]
      },
      async getGovernanceSummary() {
        return {
          calls: 0,
          tokens: 0,
          cost: 0,
          avgLatencyMs: 0,
          okCalls: 0,
          errorCalls: 0,
          rateLimitedCalls: 0,
        }
      },
      async getPerTicketBreakdown() { return [] },
    }

    const engine = new BudgetEngine(budgets, modelCalls)
    const result = await engine.check({
      tenantId: TENANT,
      agentId: PLATFORM_AGENT,
      ticketType: 'interaction',
    })
    assert.equal(result.allowed, false)
    if (!result.allowed) {
      assert.match(result.reason, /Token limit exceeded/)
      assert.equal(result.usage.tokens, 1_250_000)
    }
  })

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`)
    process.exit(1)
  }
  console.log('\nAll model-call-budget-where checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
