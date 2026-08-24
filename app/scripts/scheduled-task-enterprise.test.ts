/**
 * Scheduled task enterprise-regressziók: a scheduler csak az aktív tenantból
 * elérhető agentre hozhat létre autonóm futást, és a domain egyetlen atomi
 * repository-műveletre bízza a ticket + task-állapot materializálását.
 *
 * Futtatás: npm run test:scheduled-task-enterprise
 */
import assert from 'node:assert/strict'
import type { Agent, ScheduledTask, Ticket } from '@prisma/client'
import { ScheduledTaskService } from '../src/domain/scheduled-task/scheduled-task-service'
import { buildRunAsAuthorization, isScheduledTaskRunAsAuthorized, SCHEDULED_TASK_ID } from '../src/lib/run-as-payload'
import type {
  AgentRepository,
  AuditRepository,
  ScheduledTaskRepository,
  TicketRepository,
} from '../src/repositories/interfaces'

const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const AGENT_ID = 'cccccccc-0000-4000-8000-000000000003'
const USER_ID = 'dddddddd-0000-4000-8000-000000000004'
const TASK_ID = 'eeeeeeee-0000-4000-8000-000000000005'
const TICKET_ID = 'ffffffff-0000-4000-8000-000000000006'
const SERIES_TICKET_ID = 'aaaaaaaa-0000-4000-8000-0000000000aa'
const OCCURRENCE_TICKET_ID = 'bbbbbbbb-0000-4000-8000-0000000000bb'
const NOW = new Date('2026-07-18T10:00:00.000Z')

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    tenantId: TENANT_A,
    status: 'active',
    ...overrides,
  } as Agent
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: TASK_ID,
    tenantId: TENANT_A,
    kind: 'agent_task',
    status: 'active',
    recurrence: 'none',
    maxRuns: null,
    runCount: 0,
    title: 'Napi riport',
    agentId: AGENT_ID,
    createdById: USER_ID,
    payload: { question: 'Készíts riportot', attachmentDocumentIds: [] },
    runAsUserId: null,
    runAsAuthorizedAt: null,
    runAsAuthorizedById: null,
    nextRunAt: new Date(NOW.getTime() - 1_000),
    lastRunAt: null,
    materializedTicketId: null,
    materializedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ScheduledTask
}

function makeService(
  targetAgent: Agent,
  repository: Partial<ScheduledTaskRepository> = {},
  tickets?: Partial<TicketRepository>,
) {
  const audit: Array<Record<string, unknown>> = []
  const scheduledTasks: ScheduledTaskRepository = {
    create: async (input) => task({
      tenantId: input.tenantId,
      agentId: input.agentId,
      title: input.title,
      createdById: input.createdById,
      payload: input.payload as ScheduledTask['payload'],
      nextRunAt: input.nextRunAt,
      recurrence: input.recurrence ?? 'none',
      maxRuns: input.maxRuns ?? null,
    }),
    ...repository,
  } as ScheduledTaskRepository
  const agents: AgentRepository = {
    findById: async (id) => (id === targetAgent.id ? targetAgent : null),
  } as AgentRepository
  const auditRepository: AuditRepository = {
    append: async (entry) => {
      audit.push(entry as Record<string, unknown>)
      return {} as Awaited<ReturnType<AuditRepository['append']>>
    },
  } as AuditRepository

  return {
    service: new ScheduledTaskService(
      scheduledTasks,
      agents,
      auditRepository,
      tickets as TicketRepository | undefined,
    ),
    audit,
  }
}

console.log('=== scheduled task enterprise regresszió ===')

async function run() {
await test('cross-tenant agentre nem hozható létre scheduled task', async () => {
  let createCalls = 0
  const { service } = makeService(agent({ tenantId: TENANT_B }), {
    create: async () => {
      createCalls += 1
      return task()
    },
  })

  await assert.rejects(
    () => service.createOneShotAgentTask({
      tenantId: TENANT_A,
      agentId: AGENT_ID,
      title: 'Idegen agent',
      content: 'ne fusson le',
      createdById: USER_ID,
      nextRunAt: NOW,
    }),
    /Agent not found/,
  )
  assert.equal(createCalls, 0)
})

await test('inaktív agentre nem hozható létre scheduled task', async () => {
  let createCalls = 0
  const { service } = makeService(agent({ status: 'suspended' }), {
    create: async () => {
      createCalls += 1
      return task()
    },
  })

  await assert.rejects(
    () => service.createOneShotAgentTask({
      tenantId: TENANT_A,
      agentId: AGENT_ID,
      title: 'Felfüggesztett agent',
      content: 'ne fusson le',
      createdById: USER_ID,
      nextRunAt: NOW,
    }),
    /Agent not found/,
  )
  assert.equal(createCalls, 0)
})

await test('saját és megosztott aktív agent ütemezhető', async () => {
  const own = makeService(agent())
  const ownTask = await own.service.createOneShotAgentTask({
    tenantId: TENANT_A,
    agentId: AGENT_ID,
    title: 'Saját agent',
    content: 'fusson le',
    createdById: USER_ID,
    nextRunAt: NOW,
  })
  assert.equal(ownTask.tenantId, TENANT_A)
  assert.equal(own.audit[0]?.action, 'scheduled_task.create')

  const shared = makeService(agent({ tenantId: null }))
  const sharedTask = await shared.service.createOneShotAgentTask({
    tenantId: TENANT_B,
    agentId: AGENT_ID,
    title: 'Megosztott agent',
    content: 'fusson le',
    createdById: USER_ID,
    nextRunAt: NOW,
  })
  assert.equal(sharedTask.tenantId, TENANT_B)
})

await test('a materializálás egy atomi repository-hívással hozza létre a ticketet és zárja a taskot', async () => {
  const dueTask = task()
  let materializeCalls = 0
  let createdTicketId: string | null = null
  const { service } = makeService(agent(), {
    findDue: async () => [dueTask],
    claimDue: async () => task({ status: 'materializing' }),
    materializeTicket: async (id, ticketInput, state) => {
      materializeCalls += 1
      assert.equal(id, TASK_ID)
      assert.equal(ticketInput.tenantId, TENANT_A)
      assert.equal(ticketInput.agentId, AGENT_ID)
      assert.equal((ticketInput.payload as Record<string, unknown>).scheduledTaskId, TASK_ID)
      assert.equal(state.status, 'materialized')
      const createdTicket = { id: TICKET_ID, ...ticketInput } as Ticket
      createdTicketId = createdTicket.id
      return {
        ticket: createdTicket,
        scheduledTask: task({
          status: 'materialized',
          materializedTicketId: TICKET_ID,
          materializedAt: NOW,
          lastRunAt: NOW,
          runCount: 1,
        }),
      }
    },
  })

  const result = await service.materializeDue(NOW, 1)
  assert.equal(materializeCalls, 1)
  assert.equal(createdTicketId, TICKET_ID)
  assert.deepEqual(result, [{ scheduledTaskId: TASK_ID, status: 'materialized', ticketId: TICKET_ID }])
})

await test('egyszeri, előre kirakott ticketet nem másol, csak lépteti az ütemezést', async () => {
  let materializeCalls = 0
  let advanceCalls = 0
  const precreated = task({
    status: 'materializing',
    materializedTicketId: TICKET_ID,
    runCount: 0,
    recurrence: 'none',
  })
  const { service } = makeService(agent(), {
    findDue: async () => [precreated],
    claimDue: async () => precreated,
    materializeTicket: async () => {
      materializeCalls += 1
      return null
    },
    advanceExistingTicket: async () => {
      advanceCalls += 1
      return task({
        status: 'materialized',
        materializedTicketId: TICKET_ID,
        runCount: 1,
        recurrence: 'none',
      })
    },
  })

  const result = await service.materializeDue(NOW, 1)
  assert.equal(materializeCalls, 0)
  assert.equal(advanceCalls, 1)
  assert.deepEqual(result, [{ scheduledTaskId: TASK_ID, status: 'materialized', ticketId: TICKET_ID }])
})

await test('rendszeres sorozatnál új példány készül, a sablon a következő időpontra lép', async () => {
  let materializeCalls = 0
  let advanceCalls = 0
  const seriesUpdates: Array<Record<string, unknown>> = []
  const dueAt = new Date(NOW.getTime() - 1_000)
  const precreated = task({
    status: 'materializing',
    materializedTicketId: SERIES_TICKET_ID,
    runCount: 0,
    recurrence: 'daily',
    nextRunAt: dueAt,
    payload: {
      question: 'Készíts riportot',
      attachmentDocumentIds: [],
      seriesTicketId: SERIES_TICKET_ID,
    },
  })
  const { service } = makeService(
    agent(),
    {
      findDue: async () => [precreated],
      claimDue: async () => precreated,
      materializeTicket: async (_id, ticketInput, state) => {
        materializeCalls += 1
        assert.equal(ticketInput.executeAfter, null)
        assert.ok(ticketInput.title.startsWith('Napi riport — '))
        const payload = ticketInput.payload as Record<string, unknown>
        assert.equal(payload.scheduleSeries, undefined)
        assert.equal(payload.scheduleOccurrence, true)
        assert.equal(payload.seriesTicketId, SERIES_TICKET_ID)
        assert.equal(state.status, 'active')
        return {
          ticket: { id: OCCURRENCE_TICKET_ID, ...ticketInput } as Ticket,
          scheduledTask: task({
            status: 'active',
            materializedTicketId: OCCURRENCE_TICKET_ID,
            materializedAt: NOW,
            lastRunAt: NOW,
            runCount: 1,
            recurrence: 'daily',
          }),
        }
      },
      advanceExistingTicket: async () => {
        advanceCalls += 1
        return null
      },
    },
    {
      findById: async (id) =>
        id === SERIES_TICKET_ID
          ? ({
              id: SERIES_TICKET_ID,
              state: 'ready',
              payload: { scheduleSeries: true, question: 'Készíts riportot' },
              executeAfter: dueAt,
            } as Ticket)
          : null,
      update: async (id, data) => {
        assert.equal(id, SERIES_TICKET_ID)
        seriesUpdates.push(data as Record<string, unknown>)
        return { id: SERIES_TICKET_ID, ...data } as Ticket
      },
    },
  )

  const result = await service.materializeDue(NOW, 1)
  assert.equal(materializeCalls, 1)
  assert.equal(advanceCalls, 0)
  assert.equal(seriesUpdates.length, 1)
  const seriesUpdate = seriesUpdates[0] ?? {}
  assert.ok(seriesUpdate.executeAfter instanceof Date)
  assert.equal((seriesUpdate.executeAfter as Date).toISOString(), '2026-07-19T09:59:59.000Z')
  assert.equal(seriesUpdate.state, undefined)
  const seriesPayload = seriesUpdate.payload as Record<string, unknown>
  assert.equal(seriesPayload.scheduleSeries, true)
  assert.deepEqual(result, [
    { scheduledTaskId: TASK_ID, status: 'materialized', ticketId: OCCURRENCE_TICKET_ID },
  ])
})

await test('a visszavont scheduled task run-as joga minden további tool-hívásnál elutasított', () => {
  const authorizedAt = '2026-07-18T10:00:00.000Z'
  const payload = {
    ...buildRunAsAuthorization({ userId: USER_ID, authorizedAt }),
    [SCHEDULED_TASK_ID]: TASK_ID,
  }
  const materializedTask = task({
    status: 'materialized',
    materializedTicketId: TICKET_ID,
    runAsUserId: USER_ID,
    runAsAuthorizedById: USER_ID,
    runAsAuthorizedAt: new Date(authorizedAt),
  })
  const input = {
    ticketId: TICKET_ID,
    ticketTenantId: TENANT_A,
    payload,
    scheduledTask: materializedTask,
  }
  assert.equal(isScheduledTaskRunAsAuthorized(input), true)
  assert.equal(isScheduledTaskRunAsAuthorized({ ...input, scheduledTask: { ...materializedTask, status: 'revoked' } }), false)
  assert.equal(isScheduledTaskRunAsAuthorized({ ...input, ticketId: 'other-ticket' }), false)
})

console.log(failures === 0 ? '\n✅ minden scheduled task enterprise teszt zöld' : `\n❌ ${failures} teszt bukott`)
process.exit(failures === 0 ? 0 : 1)
}

void run()
