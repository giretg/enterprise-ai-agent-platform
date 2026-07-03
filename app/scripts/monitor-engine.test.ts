/**
 * Determinisztikus unit-teszt a proaktív monitor magjához (Feature-spec — Proactive
 * Monitor §4.4, §5.3). Futtatás: npm run test:monitor
 *
 * DB és LLM NÉLKÜL igazolja a szűrő-kiértékelőt (csendes alapállapot, küszöb,
 * business-hours, AND/OR) és a következő-söprés számítást (catch-up + jitter).
 */
import assert from 'node:assert/strict'
import type { AuditLog, MonitorDefinition, MonitorRun, MonitorSignal, Prisma, Ticket } from '@prisma/client'
import { evaluateFilter } from '../src/domain/monitor/filter-eval'
import { computeNextSweepAt, MonitorService, resolveMonitorCronInputPayload } from '../src/domain/monitor/monitor-service'
import { BoardBacklogCollector } from '../src/domain/monitor/collectors/board-collector'
import { DeadlineCollector } from '../src/domain/monitor/collectors/deadline-collector'
import { ConnectorCountCollector } from '../src/domain/monitor/collectors/connector-count-collector'
import type { MonitorCollector, MonitorSignalDraft } from '../src/domain/monitor/collectors/types'
import type {
  AgentRepository,
  AuditRepository,
  MonitorRepository,
  ProcessDefinitionRepository,
  TicketRepository,
} from '../src/repositories/interfaces'
import type { MonitorNotifier, MonitorNotificationInput } from '../src/lib/notify/monitor-notifier'
import { RoutingMonitorNotifier } from '../src/lib/notify/monitor-notifier'
import { WebhookChatNotifier } from '../src/lib/notify/webhook-chat-notifier'
import type { ToolBrokerInvokeInput } from '../src/domain/tool-broker/tool-broker-service'

let failures = 0
const asyncChecks: Promise<void>[] = []
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

function checkAsync(name: string, fn: () => Promise<void>) {
  asyncChecks.push(
    fn()
      .then(() => {
        console.log(`  ✅ ${name}`)
      })
      .catch((e) => {
        failures++
        console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
      }),
  )
}

function signal(overrides: Partial<MonitorSignalDraft> = {}): MonitorSignalDraft {
  return {
    dedupKeyParts: { ticketId: 't1' },
    severity: 50,
    title: 'teszt jel',
    dueBy: null,
    payload: {},
    ...overrides,
  }
}

const NOW = new Date('2026-06-21T10:00:00.000Z') // UTC 10:00 → business hours

console.log('=== monitor filter-eval teszt ===')

check('üres szűrő → match (csendes default a collectorra hárul)', () => {
  assert.equal(evaluateFilter({}, signal(), NOW).matched, true)
})

check('severity küszöb alatt → nincs match (csendes)', () => {
  const filter = { field: 'severity', cmp: '>=', value: 60 }
  assert.equal(evaluateFilter(filter, signal({ severity: 50 }), NOW).matched, false)
})

check('severity küszöb felett → match (eszkalálható)', () => {
  const filter = { field: 'severity', cmp: '>=', value: 60 }
  assert.equal(evaluateFilter(filter, signal({ severity: 75 }), NOW).matched, true)
})

check('AND: severity ÉS payload.openCount', () => {
  const filter = {
    op: 'and',
    rules: [
      { field: 'severity', cmp: '>=', value: 60 },
      { field: 'payload.openCount', cmp: '>', value: 5 },
    ],
  }
  assert.equal(evaluateFilter(filter, signal({ severity: 70, payload: { openCount: 3 } }), NOW).matched, false)
  assert.equal(evaluateFilter(filter, signal({ severity: 70, payload: { openCount: 9 } }), NOW).matched, true)
})

check('business-hours: munkaidőn kívül csak magas severity', () => {
  const night = new Date('2026-06-21T22:00:00.000Z') // UTC 22:00 → nem business hours
  const filter = {
    op: 'or',
    rules: [
      { op: 'and', rules: [{ field: 'businessHours', cmp: '==', value: true }] },
      { op: 'and', rules: [{ field: 'businessHours', cmp: '==', value: false }, { field: 'severity', cmp: '>=', value: 90 }] },
    ],
  }
  assert.equal(evaluateFilter(filter, signal({ severity: 70 }), night).matched, false)
  assert.equal(evaluateFilter(filter, signal({ severity: 95 }), night).matched, true)
  assert.equal(evaluateFilter(filter, signal({ severity: 70 }), NOW).matched, true) // nappal átmegy
})

check('hoursUntilDue származtatott mező', () => {
  const filter = { field: 'hoursUntilDue', cmp: '<', value: 4 }
  const soon = new Date(NOW.getTime() + 2 * 3_600_000)
  const later = new Date(NOW.getTime() + 10 * 3_600_000)
  assert.equal(evaluateFilter(filter, signal({ dueBy: soon }), NOW).matched, true)
  assert.equal(evaluateFilter(filter, signal({ dueBy: later }), NOW).matched, false)
})

console.log('=== monitor collector tenant-izoláció teszt ===')

checkAsync('deadline collector tenantId-t ad át a repositorynak', async () => {
  let seenTenantId: string | null = null
  const collector = new DeadlineCollector({
    async collectUpcomingTicketDeadlines(tenantId: string) {
      seenTenantId = tenantId
      return [
        {
          ticketId: 'ticket-a',
          tenantId,
          title: 'A tenant határidő',
          dueBy: new Date(NOW.getTime() + 2 * 3_600_000),
          state: 'ready',
        },
      ]
    },
  } as never)

  const signals = await collector.collect({ tenantId: 'tenant-a', config: { windowHours: 24 }, now: NOW })
  assert.equal(seenTenantId, 'tenant-a')
  assert.equal(signals.length, 1)
  assert.equal(signals[0].payload.tenantId, 'tenant-a')
})

checkAsync('board-backlog collector tenantId-t ad át a repositorynak', async () => {
  let seenTenantId: string | null = null
  const collector = new BoardBacklogCollector({
    async collectStaleBacklogTickets(tenantId: string) {
      seenTenantId = tenantId
      return [
        {
          ticketId: 'ticket-b',
          tenantId,
          title: 'B tenant ticket',
          state: 'awaiting_human',
          updatedAt: new Date(NOW.getTime() - 8 * 3_600_000),
          dueBy: null,
        },
      ]
    },
  } as never)

  const signals = await collector.collect({ tenantId: 'tenant-b', config: { staleHours: 4 }, now: NOW })
  assert.equal(seenTenantId, 'tenant-b')
  assert.equal(signals.length, 1)
  assert.equal(signals[0].payload.tenantId, 'tenant-b')
})

console.log('=== monitor computeNextSweepAt teszt ===')

function monitor(overrides: Partial<MonitorDefinition> = {}): MonitorDefinition {
  return {
    id: 'm1',
    tenantId: 'tenant1',
    kind: 'deadline',
    status: 'active',
    version: 1,
    title: 'm',
    description: null,
    intervalSeconds: 3600,
    nextSweepAt: NOW,
    lastSweepAt: null,
    activeWindowCron: null,
    catchupPolicy: 'run_late',
    catchupWindowSec: 900,
    collectorConfig: {},
    filterConfig: {},
    cooldownSeconds: 86_400,
    dedupKeyTemplate: null,
    openTicketType: 'monitor_alert',
    escalateAgentId: null,
    perRunBudgetUsd: null,
    notifyChannel: null,
    lockToken: null,
    lockedAt: null,
    createdById: 'u1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as MonitorDefinition
}

check('normál eset: nextSweepAt + interval (+ jitter < 30s)', () => {
  const next = computeNextSweepAt(monitor(), NOW)
  const expected = NOW.getTime() + 3_600_000
  assert.ok(next.getTime() >= expected && next.getTime() < expected + 30_000)
})

check('run_late catch-up: rég esedékes → most fut (nem a múltban)', () => {
  const longAgo = new Date(NOW.getTime() - 10 * 3_600_000)
  const next = computeNextSweepAt(monitor({ nextSweepAt: longAgo }), NOW)
  assert.ok(next.getTime() >= NOW.getTime())
})

check('skip catch-up: rég esedékes → jövőbeli slot, nem most', () => {
  const longAgo = new Date(NOW.getTime() - 10 * 3_600_000)
  const next = computeNextSweepAt(monitor({ nextSweepAt: longAgo, catchupPolicy: 'skip' }), NOW)
  assert.ok(next.getTime() >= NOW.getTime())
})

console.log('=== connector-count Tool Broker teszt ===')

checkAsync('connector-count collector mailbox_count capability-n át ad jelet', async () => {
  const calls: ToolBrokerInvokeInput[] = []
  const collector = new ConnectorCountCollector(
    {
      async invoke(input) {
        calls.push(input)
        return {
          denied: false,
          result: { count: 12, query: 'is:unread' },
          resultMeta: { count: 12 },
          latencyMs: 1,
        }
      },
    },
    {
      async findById() {
        return { id: 'agent-mailbox', currentVersion: 7 }
      },
    } as unknown as AgentRepository,
  )

  const signals = await collector.collect({
    tenantId: 'tenant-a',
    now: NOW,
    monitor: monitor({ kind: 'connector_count', escalateAgentId: 'agent-mailbox' }),
    config: {
      threshold: 5,
      query: 'is:unread',
      actingUserId: 'user-a',
      connectorId: '11111111-1111-1111-1111-111111111111',
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].tool, 'mailbox_count')
  assert.equal(calls[0].agentVersion, 7)
  assert.equal(calls[0].actingUserId, 'user-a')
  assert.equal(signals.length, 1)
  assert.equal(signals[0].payload.count, 12)
  assert.equal(signals[0].payload.threshold, 5)
  assert.equal(signals[0].dedupKeyParts.agentId, 'agent-mailbox')
})

console.log('=== monitor notification adapter teszt ===')

checkAsync('eszkalált jel notifyChannel esetén értesítést és auditot kap', async () => {
  const escalatedSignal = signal({
    dedupKeyParts: { ticketId: 'source-ticket-1' },
    severity: 91,
    title: 'Kritikus határidő',
    dueBy: new Date(NOW.getTime() + 3_600_000),
    payload: { ticketId: 'source-ticket-1' },
  })
  const definition = monitor({
    id: 'monitor-notify',
    notifyChannel: 'email:ops@example.com',
    filterConfig: { field: 'severity', cmp: '>=', value: 80 },
    dedupKeyTemplate: 'deadline:{ticketId}',
  })
  const run: MonitorRun = {
    id: 'run-notify',
    monitorId: definition.id,
    outcome: 'quiet',
    startedAt: NOW,
    finishedAt: null,
    scheduledFor: definition.nextSweepAt,
    signalCount: 0,
    matchedCount: 0,
    suppressedCount: 0,
    openedTicketIds: [],
    llmInvoked: false,
    costUsd: null,
    error: null,
  }
  const storedSignal: MonitorSignal = {
    id: 'signal-notify',
    monitorId: definition.id,
    dedupKey: 'deadline:source-ticket-1',
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastEscalatedAt: null,
    escalatedTicketId: null,
    severity: escalatedSignal.severity,
    payload: escalatedSignal.payload as Prisma.JsonObject,
  }
  const createdTickets: Array<Partial<Ticket>> = []
  const auditEvents: Array<Omit<AuditLog, 'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash'>> = []
  const notifications: MonitorNotificationInput[] = []

  const monitorRepo = {
    async findDue() {
      return [definition]
    },
    async claim() {
      return definition
    },
    async createRun() {
      return run
    },
    async upsertSignal() {
      return storedSignal
    },
    async markSignalEscalated(_id: string, ticketId: string, now: Date) {
      storedSignal.lastEscalatedAt = now
      storedSignal.escalatedTicketId = ticketId
    },
    async updateRun(_id: string, data: Partial<MonitorRun>) {
      Object.assign(run, data)
      return run
    },
    async release() {},
  } as unknown as MonitorRepository

  const ticketRepo = {
    async create(data: Partial<Ticket>) {
      const ticket = { ...data, id: 'ticket-notify', createdAt: NOW, updatedAt: NOW } as Ticket
      createdTickets.push(ticket)
      return ticket
    },
  } as unknown as TicketRepository

  const auditRepo = {
    async append(data: Omit<AuditLog, 'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash'>) {
      auditEvents.push(data)
      return {
        ...data,
        id: `audit-${auditEvents.length}`,
        seq: BigInt(auditEvents.length),
        createdAt: NOW,
        hash: 'h',
        prevHash: null,
      } as AuditLog
    },
  } as unknown as AuditRepository

  const collector: MonitorCollector = {
    kind: 'deadline',
    async collect() {
      return [escalatedSignal]
    },
  }

  const notifier: MonitorNotifier = {
    async send(input) {
      notifications.push(input)
      return { provider: 'email', messageId: 'msg-1' }
    },
  }

  const service = new MonitorService(monitorRepo, ticketRepo, auditRepo, [collector], notifier)
  const result = await service.sweepDue(NOW, 1)

  assert.equal(result[0].outcome, 'escalated')
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].channel, 'email:ops@example.com')
  assert.equal(notifications[0].dedupKey, 'deadline:source-ticket-1')
  assert.equal(auditEvents.some((e) => e.action === 'monitor.notify.sent'), true)
  const ticketPayload = createdTickets[0].payload as Record<string, unknown>
  assert.equal(ticketPayload.monitorRunId, 'run-notify')
  assert.equal(ticketPayload.dedupKey, 'deadline:source-ticket-1')
})

check('monitor_cron contextMap felold monitor/signal/payload mezőket', () => {
  const payload = resolveMonitorCronInputPayload(
    {
      contextMap: {
        ceg: 'payload.company',
        severity: 'signal.severity',
        ticketId: 'ticketId',
        runId: 'monitorRunId',
        dedup: 'dedupKey',
        ts: 'now()',
      },
    },
    {
      monitor: monitor({ id: 'monitor-process' }),
      signal: signal({
        dedupKeyParts: { ticketId: 'ticket-42' },
        severity: 88,
        payload: { company: 'Acme Kft' },
      }),
      monitorRunId: 'run-process',
      dedupKey: 'deadline:ticket-42',
      now: NOW,
    },
  )

  assert.deepEqual(payload, {
    ceg: 'Acme Kft',
    severity: 88,
    ticketId: 'ticket-42',
    runId: 'run-process',
    dedup: 'deadline:ticket-42',
    ts: NOW.toISOString(),
  })
})

checkAsync('monitor_cron trigger matched jelből Futást indít, legacy ticket nélkül', async () => {
  const escalatedSignal = signal({
    dedupKeyParts: { ticketId: 'source-ticket-2' },
    severity: 92,
    title: 'Folyamat-trigger jel',
    payload: { company: 'Globex Zrt', ticketId: 'source-ticket-2' },
  })
  const definition = monitor({
    id: 'monitor-process',
    filterConfig: { field: 'severity', cmp: '>=', value: 80 },
    dedupKeyTemplate: 'deadline:{ticketId}',
  })
  const run: MonitorRun = {
    id: 'run-process',
    monitorId: definition.id,
    outcome: 'quiet',
    startedAt: NOW,
    finishedAt: null,
    scheduledFor: definition.nextSweepAt,
    signalCount: 0,
    matchedCount: 0,
    suppressedCount: 0,
    openedTicketIds: [],
    llmInvoked: false,
    costUsd: null,
    error: null,
  }
  const storedSignal: MonitorSignal = {
    id: 'signal-process',
    monitorId: definition.id,
    dedupKey: 'deadline:source-ticket-2',
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastEscalatedAt: null,
    escalatedTicketId: null,
    severity: escalatedSignal.severity,
    payload: escalatedSignal.payload as Prisma.JsonObject,
  }
  const createdTickets: Array<Partial<Ticket>> = []
  const auditEvents: Array<Omit<AuditLog, 'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash'>> = []
  const startInputs: Array<Record<string, unknown>> = []

  const monitorRepo = {
    async findDue() {
      return [definition]
    },
    async claim() {
      return definition
    },
    async createRun() {
      return run
    },
    async upsertSignal() {
      return storedSignal
    },
    async markSignalEscalated(_id: string, ticketId: string | null, now: Date) {
      storedSignal.lastEscalatedAt = now
      storedSignal.escalatedTicketId = ticketId
    },
    async updateRun(_id: string, data: Partial<MonitorRun>) {
      Object.assign(run, data)
      return run
    },
    async release() {},
  } as unknown as MonitorRepository

  const ticketRepo = {
    async create(data: Partial<Ticket>) {
      createdTickets.push(data)
      return { ...data, id: 'should-not-open-ticket', createdAt: NOW, updatedAt: NOW } as Ticket
    },
  } as unknown as TicketRepository

  const auditRepo = {
    async append(data: Omit<AuditLog, 'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash'>) {
      auditEvents.push(data)
      return {
        ...data,
        id: `audit-process-${auditEvents.length}`,
        seq: BigInt(auditEvents.length),
        createdAt: NOW,
        hash: 'h',
        prevHash: null,
      } as AuditLog
    },
  } as unknown as AuditRepository

  const processDefinitions = {
    async listActiveMonitorCronTriggers() {
      return [
        {
          id: 'trigger-process',
          processDefinitionId: 'process-def-1',
          inputMap: { contextMap: { ceg: 'payload.company', sourceTicketId: 'ticketId' } },
        },
      ]
    },
  } as unknown as ProcessDefinitionRepository

  const processService = {
    async startProcess(input: Record<string, unknown>) {
      startInputs.push(input)
      return { id: 'process-instance-1' }
    },
  } as never

  const collector: MonitorCollector = {
    kind: 'deadline',
    async collect() {
      return [escalatedSignal]
    },
  }

  const service = new MonitorService(
    monitorRepo,
    ticketRepo,
    auditRepo,
    [collector],
    undefined,
    processDefinitions,
    processService,
  )
  const result = await service.sweepDue(NOW, 1)

  assert.equal(result[0].outcome, 'escalated')
  assert.deepEqual(result[0].startedProcessIds, ['process-instance-1'])
  assert.deepEqual(result[0].openedTicketIds, [])
  assert.equal(createdTickets.length, 0)
  assert.equal(startInputs.length, 1)
  assert.equal(startInputs[0].processDefinitionId, 'process-def-1')
  assert.equal(startInputs[0].triggerType, 'monitor_cron')
  assert.deepEqual(startInputs[0].inputPayload, { ceg: 'Globex Zrt', sourceTicketId: 'source-ticket-2' })
  assert.equal(storedSignal.lastEscalatedAt?.toISOString(), NOW.toISOString())
  assert.equal(storedSignal.escalatedTicketId, null)
  assert.equal(auditEvents.some((e) => e.action === 'monitor.process_trigger.started'), true)
})

console.log('=== valós értesítő adapter (webhook chat + routing) teszt ===')

function notificationInput(
  overrides: Partial<MonitorNotificationInput> = {},
): MonitorNotificationInput {
  return {
    channel: 'chat:ops',
    tenantId: 'tenant-1',
    monitorId: 'mon-1',
    monitorTitle: 'Határidő-figyelő',
    monitorKind: 'deadline',
    monitorRunId: 'run-1',
    dedupKey: 'deadline:t1',
    ticketId: 'ticket-1',
    signalTitle: 'Közelgő határidő',
    severity: 80,
    dueBy: new Date('2026-06-22T09:00:00.000Z'),
    payload: {},
    createdAt: NOW,
    ...overrides,
  }
}

checkAsync('webhook chat notifier allowlistolt env URL-re POST-ol + board-linket ad', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(null, { status: 200 })
  }) as unknown as typeof fetch
  const notifier = new WebhookChatNotifier({
    env: {
      MONITOR_NOTIFY_WEBHOOK_OPS: 'https://chat.example.com/hook/abc',
      NEXT_PUBLIC_APP_URL: 'https://platform.example.com/',
    },
    fetchFn,
  })

  const result = await notifier.send(notificationInput())

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://chat.example.com/hook/abc')
  const body = calls[0].body as { text: string }
  assert.match(body.text, /Határidő-figyelő/)
  assert.match(body.text, /https:\/\/platform\.example\.com\/control-plane\/board/)
  assert.match(body.text, /#ticket-1/)
  assert.equal(result.provider, 'chat')
})

checkAsync('webhook chat notifier hibát dob be nem kötött csatorna-kulcsra', async () => {
  const notifier = new WebhookChatNotifier({ env: {} })
  await assert.rejects(() => notifier.send(notificationInput({ channel: 'chat:unknown' })), /not configured/)
})

checkAsync('webhook chat notifier elutasítja a nem-https webhook URL-t', async () => {
  const notifier = new WebhookChatNotifier({
    env: { MONITOR_NOTIFY_WEBHOOK_OPS: 'http://insecure.example.com/hook' },
  })
  await assert.rejects(() => notifier.send(notificationInput()), /https/)
})

checkAsync('routing notifier a chat:-et a webhookra, az email:-t a fallbackre küldi', async () => {
  const chatCalls: MonitorNotificationInput[] = []
  const fallbackCalls: MonitorNotificationInput[] = []
  const chat: MonitorNotifier = {
    async send(input) {
      chatCalls.push(input)
      return { provider: 'chat', messageId: 'chat-1' }
    },
  }
  const fallback: MonitorNotifier = {
    async send(input) {
      fallbackCalls.push(input)
      return { provider: 'audit-only', messageId: 'audit-1' }
    },
  }
  const routing = new RoutingMonitorNotifier({ chat }, fallback)

  const chatResult = await routing.send(notificationInput({ channel: 'chat:ops' }))
  const emailResult = await routing.send(notificationInput({ channel: 'email:ops@example.com' }))

  assert.equal(chatCalls.length, 1)
  assert.equal(chatResult.provider, 'chat')
  assert.equal(fallbackCalls.length, 1)
  assert.equal(emailResult.provider, 'audit-only')
})

Promise.all(asyncChecks).then(() => {
  console.log(failures === 0 ? '\n✅ minden monitor unit-teszt zöld' : `\n❌ ${failures} teszt bukott`)
  process.exit(failures === 0 ? 0 : 1)
})
