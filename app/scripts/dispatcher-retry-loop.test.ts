import assert from 'node:assert/strict'
import type { Prisma, Ticket } from '@prisma/client'
import {
  DispatcherService,
  type HarnessLauncher,
} from '../src/domain/dispatcher/dispatcher-service'
import type {
  DispatchAlertNotifier,
  DispatchBlockedNotificationInput,
} from '../src/domain/dispatcher/dispatch-alert-notifier'
import { MonitorDispatchAlertNotifier } from '../src/domain/dispatcher/dispatch-alert-notifier'
import type { MonitorNotificationInput, MonitorNotifier } from '../src/lib/notify/monitor-notifier'
import type {
  AgentRepository,
  AuditRepository,
  ModelCallRepository,
  TicketRepository,
} from '../src/repositories/interfaces'

const baseTicket = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: null,
  type: 'interaction',
  title: 'retry-loop regression',
  state: 'ready',
  assigneeType: 'agent',
  assigneeId: '22222222-2222-4222-8222-222222222222',
  agentId: '22222222-2222-4222-8222-222222222222',
  payload: {},
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
  createdById: '33333333-3333-4333-8333-333333333333',
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies Ticket

function cloneTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    ...baseTicket,
    ...overrides,
    payload: (overrides.payload ?? baseTicket.payload) as Prisma.JsonValue,
  }
}

class FakeTickets {
  transitions: Array<{ toState: string; note: string | null }> = []
  stale = false

  constructor(public ticket: Ticket) {}

  async findReadyForDispatch() {
    return this.ticket.state === 'ready' && this.ticket.lockToken === null ? [this.ticket] : []
  }

  async findStaleInProgressDispatches() {
    return this.stale ? [this.ticket] : []
  }

  async findById(id: string) {
    return id === this.ticket.id ? this.ticket : null
  }

  async update(id: string, data: Partial<Ticket>) {
    assert.equal(id, this.ticket.id)
    this.ticket = { ...this.ticket, ...data, updatedAt: new Date() }
    return this.ticket
  }

  async acquireDispatchLock(id: string, lockToken: string, now: Date) {
    assert.equal(id, this.ticket.id)
    if (this.ticket.state !== 'ready' || this.ticket.lockToken) return null
    this.ticket = { ...this.ticket, lockToken, lockedAt: now }
    return this.ticket
  }

  async releaseDispatchLock(id: string, lockToken: string) {
    assert.equal(id, this.ticket.id)
    if (this.ticket.lockToken === lockToken) {
      this.ticket = { ...this.ticket, lockToken: null, lockedAt: null }
    }
  }

  async completeDispatchLock(id: string, lockToken: string) {
    assert.equal(id, this.ticket.id)
    if (this.ticket.lockToken !== lockToken) return null
    this.ticket = { ...this.ticket, lockToken: null, lockedAt: null }
    return this.ticket
  }

  async recordTransition(data: { toState: string; note: string | null }) {
    this.transitions.push({ toState: data.toState, note: data.note })
    return { id: crypto.randomUUID(), ts: new Date(), ...data }
  }
}

class FakeAudit {
  events: Array<{ action: string; policyDecision: string | null; metadata: unknown }> = []

  async append(event: { action: string; policyDecision?: string | null; metadata?: unknown }) {
    this.events.push({
      action: event.action,
      policyDecision: event.policyDecision ?? null,
      metadata: event.metadata,
    })
    return event
  }
}

class FakeAgents {
  revoked: string[] = []

  async findById(id: string) {
    return { id, status: 'active', modelConfig: {} }
  }

  async issueEphemeralKey(agentId: string) {
    return { id: `key-${agentId}`, rawKey: `raw-${agentId}`, scopes: ['ticket:read', 'tool:invoke'] }
  }

  async revokeKey(keyId: string) {
    this.revoked.push(keyId)
  }
}

class FakeDispatchAlerts implements DispatchAlertNotifier {
  blocked: DispatchBlockedNotificationInput[] = []

  async dispatchBlocked(input: DispatchBlockedNotificationInput) {
    this.blocked.push(input)
    return { provider: 'test', messageId: `alert-${input.ticketId}`, channel: 'test:dispatch' }
  }
}

const modelCalls = {
  getUsageForAgentSince: async () => ({ calls: 0, tokens: 0 }),
} as unknown as ModelCallRepository

async function testEphemeralKeyAndPermanentBlock() {
  const tickets = new FakeTickets(cloneTicket())
  const audit = new FakeAudit()
  const agents = new FakeAgents()
  const alerts = new FakeDispatchAlerts()
  const launchInput: { current?: Parameters<HarnessLauncher['launch']>[0] } = {}
  const launcher: HarnessLauncher = {
    mode: 'docker-local',
    async launch(input) {
      launchInput.current = input
      return { jobId: 'job-1' }
    },
  }
  const dispatcher = new DispatcherService(
    tickets as unknown as TicketRepository,
    audit as unknown as AuditRepository,
    modelCalls,
    launcher,
    undefined,
    async () => true,
    agents as unknown as AgentRepository,
    alerts,
  )

  const started = await dispatcher.dispatchTicket(tickets.ticket.id)
  assert.equal(started.status, 'started')
  assert.equal(launchInput.current?.harnessAgentApiKey, `raw-${baseTicket.agentId}`)

  const completed = await dispatcher.completeHarnessRun({
    ticketId: tickets.ticket.id,
    lockToken: launchInput.current!.lockToken,
    status: 'failed',
    error: 'Agent mismatch for harness process',
    errorCategory: 'permanent',
  })

  assert.equal(completed.status, 'completed')
  assert.equal(tickets.ticket.state, 'awaiting_human')
  assert.deepEqual(agents.revoked, [`key-${baseTicket.agentId}`])
  assert.equal(alerts.blocked.length, 1)
  assert.equal(alerts.blocked[0].ticketId, baseTicket.id)
  assert.ok(audit.events.some((event) => event.action === 'dispatch.blocked'))
  assert.ok(audit.events.some((event) => event.action === 'dispatch.notify.sent'))
}

async function testTransientRetryLimit() {
  const previous = process.env.HARNESS_MAX_RETRIES
  process.env.HARNESS_MAX_RETRIES = '2'
  try {
    const tickets = new FakeTickets(
      cloneTicket({
        state: 'in_progress',
        lockToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        payload: { dispatch: { failureCount: 1, ephemeralKeyId: 'key-transient' } },
      }),
    )
    const audit = new FakeAudit()
    const agents = new FakeAgents()
    const dispatcher = new DispatcherService(
      tickets as unknown as TicketRepository,
      audit as unknown as AuditRepository,
      modelCalls,
      { mode: 'docker-local', launch: async () => ({ jobId: 'unused' }) },
      undefined,
      async () => true,
      agents as unknown as AgentRepository,
    )

    await dispatcher.completeHarnessRun({
      ticketId: tickets.ticket.id,
      lockToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'failed',
      error: 'temporary network timeout',
      errorCategory: 'transient',
    })

    assert.equal(tickets.ticket.state, 'awaiting_human')
    assert.deepEqual(agents.revoked, ['key-transient'])
    assert.ok(audit.events.some((event) => event.action === 'dispatch.blocked'))
  } finally {
    if (previous === undefined) delete process.env.HARNESS_MAX_RETRIES
    else process.env.HARNESS_MAX_RETRIES = previous
  }
}

async function testPermanentHeuristicBlocksWithoutCategory() {
  const tickets = new FakeTickets(
    cloneTicket({
      state: 'in_progress',
      lockToken: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      payload: { dispatch: { ephemeralKeyId: 'key-heuristic' } },
    }),
  )
  const audit = new FakeAudit()
  const agents = new FakeAgents()
  const dispatcher = new DispatcherService(
    tickets as unknown as TicketRepository,
    audit as unknown as AuditRepository,
    modelCalls,
    { mode: 'docker-local', launch: async () => ({ jobId: 'unused' }) },
    undefined,
    async () => true,
    agents as unknown as AgentRepository,
  )

  await dispatcher.completeHarnessRun({
    ticketId: tickets.ticket.id,
    lockToken: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    status: 'failed',
    error: 'Agent mismatch for harness process',
  })

  assert.equal(tickets.ticket.state, 'awaiting_human')
  assert.deepEqual(tickets.ticket.payload, { dispatch: { failureCount: 1 } })
  assert.deepEqual(agents.revoked, ['key-heuristic'])
  assert.ok(audit.events.some((event) => event.action === 'dispatch.blocked'))
}

async function testTransientFailureRetriesBeforeLimit() {
  const previous = process.env.HARNESS_MAX_RETRIES
  process.env.HARNESS_MAX_RETRIES = '3'
  try {
    const tickets = new FakeTickets(
      cloneTicket({
        state: 'in_progress',
        lockToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        payload: { dispatch: { ephemeralKeyId: 'key-retry' } },
      }),
    )
    const audit = new FakeAudit()
    const agents = new FakeAgents()
    const dispatcher = new DispatcherService(
      tickets as unknown as TicketRepository,
      audit as unknown as AuditRepository,
      modelCalls,
      { mode: 'docker-local', launch: async () => ({ jobId: 'unused' }) },
      undefined,
      async () => true,
      agents as unknown as AgentRepository,
    )

    await dispatcher.completeHarnessRun({
      ticketId: tickets.ticket.id,
      lockToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'failed',
      error: 'temporary network timeout',
      errorCategory: 'transient',
    })

    assert.equal(tickets.ticket.state, 'ready')
    assert.deepEqual(tickets.ticket.payload, { dispatch: { failureCount: 1 } })
    assert.deepEqual(agents.revoked, ['key-retry'])
    assert.ok(!audit.events.some((event) => event.action === 'dispatch.blocked'))
  } finally {
    if (previous === undefined) delete process.env.HARNESS_MAX_RETRIES
    else process.env.HARNESS_MAX_RETRIES = previous
  }
}

async function testStaleReclaimRevokesEphemeralKey() {
  const tickets = new FakeTickets(
    cloneTicket({
      state: 'in_progress',
      lockToken: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      lockedAt: new Date(Date.now() - 3_600_000),
      payload: { dispatch: { failureCount: 1, ephemeralKeyId: 'key-stale' } },
    }),
  )
  tickets.stale = true
  const audit = new FakeAudit()
  const agents = new FakeAgents()
  const dispatcher = new DispatcherService(
    tickets as unknown as TicketRepository,
    audit as unknown as AuditRepository,
    modelCalls,
    { mode: 'docker-local', launch: async () => ({ jobId: 'unused' }) },
    undefined,
    async () => true,
    agents as unknown as AgentRepository,
  )

  const result = await dispatcher.reclaimStaleDispatches()

  assert.deepEqual(result, [{ ticketId: tickets.ticket.id, status: 'reclaimed' }])
  assert.equal(tickets.ticket.state, 'ready')
  assert.equal(tickets.ticket.lockToken, null)
  assert.deepEqual(tickets.ticket.payload, { dispatch: { failureCount: 1 } })
  assert.deepEqual(agents.revoked, ['key-stale'])
}

async function testLaunchFailureRevokesEphemeralKeyAndReleasesTicket() {
  const tickets = new FakeTickets(cloneTicket())
  const audit = new FakeAudit()
  const agents = new FakeAgents()
  const dispatcher = new DispatcherService(
    tickets as unknown as TicketRepository,
    audit as unknown as AuditRepository,
    modelCalls,
    {
      mode: 'docker-local',
      async launch() {
        throw new Error('launcher unavailable')
      },
    },
    undefined,
    async () => true,
    agents as unknown as AgentRepository,
  )

  await assert.rejects(
    () => dispatcher.dispatchTicket(tickets.ticket.id),
    /launcher unavailable/,
  )

  assert.equal(tickets.ticket.state, 'ready')
  assert.equal(tickets.ticket.lockToken, null)
  assert.deepEqual(tickets.ticket.payload, {})
  assert.deepEqual(agents.revoked, [`key-${baseTicket.agentId}`])
  assert.deepEqual(tickets.transitions, [
    { toState: 'in_progress', note: 'dispatcher start' },
    { toState: 'ready', note: 'dispatcher launch failed' },
  ])
  assert.ok(audit.events.some((event) => event.action === 'dispatch.error'))
}

async function testLauncherResolutionFailureReleasesReadyLock() {
  const tickets = new FakeTickets(cloneTicket())
  const audit = new FakeAudit()
  const agents = new FakeAgents()
  const dispatcher = new DispatcherService(
    tickets as unknown as TicketRepository,
    audit as unknown as AuditRepository,
    modelCalls,
    () => {
      throw new Error('launcher config invalid')
    },
    undefined,
    async () => true,
    agents as unknown as AgentRepository,
  )

  await assert.rejects(
    () => dispatcher.dispatchTicket(tickets.ticket.id),
    /launcher config invalid/,
  )

  assert.equal(tickets.ticket.state, 'ready')
  assert.equal(tickets.ticket.lockToken, null)
  assert.equal(tickets.ticket.lockedAt, null)
  assert.deepEqual(tickets.ticket.payload, {})
  assert.deepEqual(agents.revoked, [])
  assert.ok(audit.events.some((event) => event.action === 'dispatch.error'))
}

async function testSuccessClearsDispatchFailurePayload() {
  const tickets = new FakeTickets(
    cloneTicket({
      state: 'in_progress',
      lockToken: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      payload: { dispatch: { failureCount: 2, ephemeralKeyId: 'key-success' } },
    }),
  )
  const audit = new FakeAudit()
  const agents = new FakeAgents()
  const dispatcher = new DispatcherService(
    tickets as unknown as TicketRepository,
    audit as unknown as AuditRepository,
    modelCalls,
    { mode: 'docker-local', launch: async () => ({ jobId: 'unused' }) },
    undefined,
    async () => true,
    agents as unknown as AgentRepository,
  )

  await dispatcher.completeHarnessRun({
    ticketId: tickets.ticket.id,
    lockToken: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    status: 'succeeded',
  })

  assert.equal(tickets.ticket.lockToken, null)
  assert.deepEqual(tickets.ticket.payload, {})
  assert.deepEqual(agents.revoked, ['key-success'])
}

async function testDispatchAlertNotifierReadsPersistedChannel() {
  const sent: MonitorNotificationInput[] = []
  const monitorNotifier: MonitorNotifier = {
    async send(input) {
      sent.push(input)
      return { provider: 'chat', messageId: 'chat-1' }
    },
  }
  const platformSettings = {
    async getDispatcherControls() {
      return {
        enabled: true,
        pollIntervalMs: 30_000,
        blockedNotifyChannel: 'chat:ops',
        updatedById: null,
        updatedAt: null,
      }
    },
  }
  const notifier = new MonitorDispatchAlertNotifier(monitorNotifier, {
    platformSettings: platformSettings as never,
  })

  const result = await notifier.dispatchBlocked({
    tenantId: null,
    ticketId: baseTicket.id,
    ticketTitle: baseTicket.title,
    category: 'permanent',
    failureCount: 1,
    maxRetries: 3,
    error: 'Agent mismatch for harness process',
  })

  assert.equal(result.channel, 'chat:ops')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].channel, 'chat:ops')
  assert.equal(sent[0].dedupKey, `dispatch-blocked:${baseTicket.id}`)
}

async function main() {
  await testEphemeralKeyAndPermanentBlock()
  await testPermanentHeuristicBlocksWithoutCategory()
  await testTransientFailureRetriesBeforeLimit()
  await testTransientRetryLimit()
  await testStaleReclaimRevokesEphemeralKey()
  await testLaunchFailureRevokesEphemeralKeyAndReleasesTicket()
  await testLauncherResolutionFailureReleasesReadyLock()
  await testSuccessClearsDispatchFailurePayload()
  await testDispatchAlertNotifierReadsPersistedChannel()
  console.log('dispatcher retry-loop regression tests passed')
}

void main()
