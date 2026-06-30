/**
 * Agent Registry — életciklus-állapotgép negatív/invariáns tesztek
 * (Feature-spec §4, §8; N-AR-1, N-AR-6).
 *
 * Futtatás: npx tsx scripts/agent-registry-lifecycle.test.ts
 *
 * AR-L1: az állapotgép csak a megengedett átmeneteket fogadja el (§4).
 * AR-L2: kizárólag `active` agent dispatchelhető (I1) — isDispatchable.
 * AR-L3: csak `draft` törölhető fizikailag (I3) — isPhysicallyDeletable.
 * AR-L4: a valódi DispatcherService non-active agentre `agent.dispatch_denied_inactive`
 *        auditot ír és kihagyja a dispatch-et, a launchert NEM hívja (I1, N-AR-1).
 */

import assert from 'node:assert/strict'
import type { Agent, AuditLog, Ticket } from '@prisma/client'
import {
  AGENT_STATUS_TRANSITIONS,
  canTransition,
  assertTransition,
  isDispatchable,
  isPhysicallyDeletable,
} from '../src/lib/agent-lifecycle'
import { DispatcherService, type HarnessLauncher } from '../src/domain/dispatcher/dispatcher-service'
import type {
  AgentRepository,
  AuditRepository,
  ModelCallRepository,
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

async function main() {
  // AR-L1 — átmenet-mátrix
  await check('AR-L1 megengedett átmenetek elfogadva', () => {
    assert.ok(canTransition('draft', 'active'))
    assert.ok(canTransition('active', 'suspended'))
    assert.ok(canTransition('suspended', 'active'))
    assert.ok(canTransition('active', 'retired'))
    assert.ok(canTransition('suspended', 'retired'))
  })

  await check('AR-L1 tiltott átmenetek elutasítva', () => {
    assert.ok(!canTransition('draft', 'suspended'))
    assert.ok(!canTransition('draft', 'retired'))
    assert.ok(!canTransition('retired', 'active'))
    assert.ok(!canTransition('active', 'draft'))
    assert.equal(AGENT_STATUS_TRANSITIONS.retired.length, 0)
    assert.throws(() => assertTransition('retired', 'active'), /Invalid agent lifecycle transition/)
  })

  // AR-L2 — dispatchelhetőség
  await check('AR-L2 csak active dispatchelhető', () => {
    assert.ok(isDispatchable('active'))
    assert.ok(!isDispatchable('draft'))
    assert.ok(!isDispatchable('suspended'))
    assert.ok(!isDispatchable('retired'))
  })

  // AR-L3 — fizikai törölhetőség
  await check('AR-L3 csak draft törölhető', () => {
    assert.ok(isPhysicallyDeletable('draft'))
    assert.ok(!isPhysicallyDeletable('active'))
    assert.ok(!isPhysicallyDeletable('suspended'))
    assert.ok(!isPhysicallyDeletable('retired'))
  })

  // AR-L4 — valódi DispatcherService I1-kapu
  await check('AR-L4 suspended agent dispatch megtagadva + audit (N-AR-1)', async () => {
    const events: AuditLog[] = []
    const ticket = {
      id: 'ticket-1',
      agentId: 'agent-1',
      state: 'ready',
      executeAfter: null,
      payload: {},
    } as unknown as Ticket

    const tickets: Pick<TicketRepository, 'findById'> = {
      findById: async (id) => (id === ticket.id ? ticket : null),
    }
    const audit: Pick<AuditRepository, 'append'> = {
      append: async (data) => {
        const row = { ...data, id: `a${events.length}`, seq: events.length } as unknown as AuditLog
        events.push(row)
        return row
      },
    }
    const modelCalls: Pick<ModelCallRepository, 'getUsageForAgentSince'> = {
      getUsageForAgentSince: async () => {
        throw new Error('budget check must NOT run for a non-active agent')
      },
    }
    const agents: Pick<AgentRepository, 'findById'> = {
      findById: async () => ({ id: 'agent-1', status: 'suspended' }) as unknown as Agent,
    }
    const launcher: HarnessLauncher = {
      mode: 'test',
      launch: async () => {
        throw new Error('launcher must NOT be called for a non-active agent')
      },
    }

    const dispatcher = new DispatcherService(
      tickets as TicketRepository,
      audit as AuditRepository,
      modelCalls as ModelCallRepository,
      launcher,
      undefined,
      async () => true,
      agents as AgentRepository,
    )

    const result = await dispatcher.dispatchTicket(ticket.id)
    assert.equal(result.status, 'skipped')
    const denied = events.find((e) => e.action === 'agent.dispatch_denied_inactive')
    assert.ok(denied, 'agent.dispatch_denied_inactive audit hiányzik')
    assert.equal(denied!.policyDecision, 'denied')
    assert.equal(denied!.targetId, 'agent-1')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden agent-registry életciklus teszt zöld.')
}

void main()
