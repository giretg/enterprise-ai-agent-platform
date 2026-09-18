/**
 * Ticket acting user: a humán feladó (createdById) a chat beszélőjéhez hasonlóan
 * a saját nevében futtat — board, egyszeri/ismétlődő scheduled és monitor ticketen is.
 * Explicit run-as felülír; agent-felvett kártyán a beszélgetés beszélője számít.
 *
 * Futtatás: npm run test:ticket-acting-user
 */
import assert from 'node:assert/strict'
import {
  buildRunAsAuthorization,
  freezeTicketIdentityPayload,
  resolveTicketActingUserId,
  RUN_AS_AUTHORIZED_AT,
  RUN_AS_AUTHORIZED_BY,
  RUN_AS_USER_ID,
  SCHEDULED_TASK_ID,
  stripTicketIdentityFromAgentPayload,
} from '../src/lib/run-as-payload'

const AGENT = 'aaaaaaaa-0000-4000-8000-aaaaaaaa0001'
const OTHER_AGENT = 'bbbbbbbb-0000-4000-8000-bbbbbbbb0001'
const USER = 'cccccccc-0000-4000-8000-cccccccc0001'
const OTHER_USER = 'dddddddd-0000-4000-8000-dddddddd0001'
const SYSTEM_ADMIN = 'eeeeeeee-0000-4000-8000-eeeeeeee0001'
const NIL = '00000000-0000-0000-0000-000000000000'
const TICKET = 'ffffffff-0000-4000-8000-ffffffff0001'
const TASK = '99999999-0000-4000-8000-999999990001'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function ticket(overrides: {
  agentId?: string | null
  createdById?: string
  source?: string | null
  conversationId?: string | null
  payload?: Record<string, unknown>
} = {}) {
  return {
    id: TICKET,
    agentId: overrides.agentId === undefined ? AGENT : overrides.agentId,
    createdById: overrides.createdById ?? USER,
    source: overrides.source,
    conversationId: overrides.conversationId ?? null,
    tenantId: 'tenant-1',
    payload: overrides.payload ?? { source: 'agent_chat' },
  }
}

console.log('ticket acting user')

test('humán feladójú ticket run-as nélkül a feladót adja', () => {
  assert.equal(
    resolveTicketActingUserId({ callerAgentId: AGENT, ticket: ticket() }),
    USER,
  )
})

test('más agent ticketje nem ad acting usert', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({ agentId: OTHER_AGENT }),
    }),
    null,
  )
})

test('explicit run-as felülírja a feladót', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({
        createdById: USER,
        payload: { source: 'board', ...buildRunAsAuthorization({ userId: OTHER_USER }) },
      }),
    }),
    OTHER_USER,
  )
})

test('ismétlődő scheduled ticket explicit run-asszal a felhatalmazott usert adja', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({
        payload: {
          source: 'scheduled_task',
          [SCHEDULED_TASK_ID]: TASK,
          schedule: { kind: 'recurring', recurrence: 'daily' },
          ...buildRunAsAuthorization({ userId: USER }),
        },
      }),
    }),
    USER,
  )
})

test('ismétlődő scheduled ticket run-as nélkül a feladót adja', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({
        payload: {
          source: 'scheduled_task',
          [SCHEDULED_TASK_ID]: TASK,
          schedule: { kind: 'recurring', recurrence: 'daily' },
        },
      }),
    }),
    USER,
  )
})

test('egyszeri ütemezett ticket run-as nélkül a feladót adja', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({
        payload: {
          source: 'scheduled_task',
          [SCHEDULED_TASK_ID]: TASK,
          schedule: { kind: 'once', recurrence: 'none' },
        },
      }),
    }),
    USER,
  )
})

test('monitor-ticket a létrehozó usert adja', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({
        source: 'system',
        payload: { source: 'monitor', monitorId: 'mon-1' },
      }),
    }),
    USER,
  )
})

test('visszavont scheduled run-as után a feladó marad', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({
        createdById: USER,
        payload: {
          source: 'scheduled_task',
          [SCHEDULED_TASK_ID]: TASK,
          schedule: { kind: 'recurring', recurrence: 'daily' },
          ...buildRunAsAuthorization({ userId: OTHER_USER }),
        },
      }),
      scheduledTask: {
        id: TASK,
        tenantId: 'tenant-1',
        status: 'active',
        materializedTicketId: TICKET,
        runAsUserId: null,
        runAsAuthorizedAt: null,
        runAsAuthorizedById: null,
        recurrence: 'daily',
      },
    }),
    USER,
  )
})

test('agent által felvett ticket nem a system usert adja', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({
        createdById: SYSTEM_ADMIN,
        payload: { source: 'agent_tool', createdByAgentId: AGENT },
      }),
    }),
    null,
  )
})

test('agent által chatből felvett ticket a beszélő usert adja', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({
        createdById: SYSTEM_ADMIN,
        conversationId: 'conv-1',
        payload: { source: 'agent_tool', createdByAgentId: AGENT },
      }),
      conversation: { agentId: AGENT, createdById: USER },
    }),
    USER,
  )
})

test('idegen beszélgetésből nem örököl acting usert', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({
        createdById: SYSTEM_ADMIN,
        payload: { source: 'agent_tool', createdByAgentId: AGENT },
      }),
      conversation: { agentId: OTHER_AGENT, createdById: USER },
    }),
    null,
  )
})

test('nil createdById nem acting user', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({ createdById: NIL, payload: { source: 'board' } }),
    }),
    null,
  )
})

test('agent_ask ticket nem a system-admin createdById-t adja (privilege escalation)', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({
        createdById: SYSTEM_ADMIN,
        payload: { source: 'agent_ask', delegation: true, requesterAgentId: OTHER_AGENT },
      }),
    }),
    null,
  )
})

test('agent_ask chat-delegáció a beszélő usert adja, nem az admint', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({
        createdById: SYSTEM_ADMIN,
        conversationId: 'conv-1',
        payload: {
          source: 'agent_ask',
          delegation: true,
          conversationId: 'conv-1',
          requesterAgentId: OTHER_AGENT,
        },
      }),
      conversation: { agentId: AGENT, createdById: USER },
    }),
    USER,
  )
})

test('delegation:true agent-filed — system createdById nem acting user', () => {
  assert.equal(
    resolveTicketActingUserId({
      callerAgentId: AGENT,
      ticket: ticket({
        createdById: SYSTEM_ADMIN,
        payload: { delegation: true, requesterAgentId: OTHER_AGENT },
      }),
    }),
    null,
  )
})

test('freezeTicketIdentityPayload visszadobja a hamis run-as mezőket', () => {
  const original = { source: 'board', note: 'ok' }
  const merged = freezeTicketIdentityPayload(
    {
      ...original,
      [RUN_AS_USER_ID]: OTHER_USER,
      [RUN_AS_AUTHORIZED_AT]: '2026-08-01T00:00:00.000Z',
      [RUN_AS_AUTHORIZED_BY]: OTHER_USER,
      conversationId: 'stolen-conv',
      source: 'agent_tool',
    },
    original,
  )
  assert.equal(merged[RUN_AS_USER_ID], undefined)
  assert.equal(merged.conversationId, undefined)
  assert.equal(merged.source, 'board')
  assert.equal(merged.note, 'ok')
})

test('freezeTicketIdentityPayload megőrzi az eredeti run-ast', () => {
  const original = {
    source: 'scheduled_task',
    [SCHEDULED_TASK_ID]: TASK,
    ...buildRunAsAuthorization({ userId: USER }),
  }
  const merged = freezeTicketIdentityPayload(
    {
      ...original,
      [RUN_AS_USER_ID]: OTHER_USER,
      [RUN_AS_AUTHORIZED_BY]: OTHER_USER,
      note: 'agent note',
    },
    original,
  )
  assert.equal(merged[RUN_AS_USER_ID], USER)
  assert.equal(merged[RUN_AS_AUTHORIZED_BY], USER)
  assert.equal(merged.note, 'agent note')
})

test('stripTicketIdentityFromAgentPayload kidobja a hamis run-ast ticket_create előtt', () => {
  const stripped = stripTicketIdentityFromAgentPayload({
    titleHint: 'x',
    [RUN_AS_USER_ID]: OTHER_USER,
    [RUN_AS_AUTHORIZED_AT]: '2026-08-01T00:00:00.000Z',
    [RUN_AS_AUTHORIZED_BY]: OTHER_USER,
    conversationId: 'forged',
    source: 'board',
  })
  assert.equal(stripped.titleHint, 'x')
  assert.equal(stripped[RUN_AS_USER_ID], undefined)
  assert.equal(stripped.conversationId, undefined)
  assert.equal(stripped.source, undefined)
})

if (failures > 0) {
  console.error(`\n${failures} ticket acting-user teszt elbukott.`)
  process.exit(1)
}
console.log('\nMinden ticket acting-user teszt zöld.')
