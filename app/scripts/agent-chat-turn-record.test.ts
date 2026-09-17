/**
 * A chat-runtime perzisztált forduló-rekordjának életciklusa
 * (chat-agent-turn-resilience-spec.md §4/§5.1, issue #59).
 *
 * DB és LLM nélkül fut: in-memory fake `AgentTurnRepository` mellett hajtja végig
 * a `sendMessageStream` valódi generátorát, és azt igazolja, hogy
 *  - minden fordulóra keletkezik rekord, a user-üzenet azonosítójával;
 *  - a forduló a végén TERMINÁLIS állapotra zárul (a keletkezett agent-üzenet
 *    azonosítójával), hibánál `failed`, a stream eldobásakor pedig szintén zárul;
 *  - a rekord hibája (#516) NEM hamis elfogadás: rekord nélkül nincs futás.
 *
 * A DB-szintű aktív-forduló invariánst (D7) a `agent-turn-repository.test.ts`
 * bizonyítja valódi Postgres ellen — azt fake nem tudja igazolni.
 *
 * Futtatás: npm run test:agent-turn-record
 */
import assert from 'node:assert/strict'
import type { Agent, AgentTurn, Message } from '@prisma/client'
import { AgentChatRuntime } from '../src/domain/agent/agent-chat-runtime'
import { ActiveAgentTurnExistsError } from '../src/repositories/interfaces'
import type {
  AgentRepository,
  AgentTurnRepository,
  AuditRepository,
  DocumentRepository,
  FinalizeAgentTurnInput,
  TicketRepository,
  ToolBrokerRepository,
} from '../src/repositories/interfaces'
import type { ConversationService } from '../src/domain/conversation/conversation-service'
import type { GatewayToolCall, ModelGateway } from '../src/domain/gateway/model-gateway'
import type { ToolBrokerService } from '../src/domain/tool-broker/tool-broker-service'
import type { WorkspaceStorage } from '../src/domain/file-editor/workspace-storage'
import { AgentAccessService } from '../src/domain/agent-access/agent-access-service'
import type { ChatTurnLauncher } from '../src/domain/agent/chat-turn-launcher'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK ${name}`)
  } catch (e) {
    failures += 1
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Korlátozás nélküli tenant-gráf a fókusztesztekhez (#142). A hozzáférési döntés
 * saját, dedikált tesztje a `scripts/agent-access-graph.test.ts` — itt csak az a
 * dolga, hogy a chat-út ne fail-closed módon álljon meg.
 */
function permissiveAgentAccess(): AgentAccessService {
  return new AgentAccessService({
    agents: {
      findById: async (id) => ({
        id,
        name: 'Teszt agent',
        personaNickname: null,
        personaTrait: null,
        role: 'worker',
        status: 'active',
        tenantId: 'tenant-1',
        hiddenFromOperators: false,
        inboundRestricted: false,
        outboundRestricted: false,
        taskOnly: false,
      }),
      listForTenant: async () => [],
      setRestrictions: async () => ({
        previous: { inboundRestricted: false, outboundRestricted: false },
        next: { inboundRestricted: false, outboundRestricted: false },
      }),
    },
    grants: {
      findEdge: async () => null,
      listBySubject: async () => [],
      listByTarget: async () => [],
      listAgentEdgesForTenant: async () => [],
      listForTenant: async () => [],
      upsertEdge: async () => ({ ok: false, reason: 'no_verb' }) as never,
      deleteEdge: async () => ({ ok: false, reason: 'not_found' }) as never,
    },
    audit: { append: async () => ({}) as never },
  })
}

function agentRow(): Agent {
  return {
    id: 'agent-1',
    tenantId: 'tenant-1',
    name: 'Teszt agent',
    roleInstruction: 'Segíts.',
    behaviorProfile: 'Pontos válaszok.',
    behaviorProfileOverlay: null,
    personaNickname: null,
    personaGreeting: null,
    personaTrait: null,
    avatarUrl: null,
    modelConfig: { provider: 'stub', model: 'stub-model' },
    status: 'active',
    currentVersion: 3,
    currentRoleInstructionVersion: 1,
    currentBehaviorProfileVersion: 1,
    currentBehaviorProfileId: null,
    role: 'worker',
    systemRole: null,
    allowSensitiveExternalModel: false,
    hiddenFromOperators: false,
    taskOnly: false,
    operatorCanManageSkills: false,
    inboundRestricted: false,
    outboundRestricted: false,
    selfEvolutionProfile: null,
    memoryId: 'memory-1',
    createdAt: new Date('2026-07-18T08:00:00Z'),
    retiredAt: null,
    suspendedReason: null,
  } as Agent
}

/** Megvárja a leválasztott futás hatását (a futás nem a fogyasztóhoz kötött). */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('időtúllépés a futás bevárásakor')
    await new Promise<void>((r) => setTimeout(r, 5))
  }
}

/**
 * A `create`/`finalize` hívásokat rögzítő, memóriában élő forduló-tár. A DB
 * részleges egyedi indexét utánozza: beszélgetésenként legfeljebb egy aktív
 * forduló, a másodikra `ActiveAgentTurnExistsError` (D7) — így az E5 eset
 * (párhuzamos küldés) valódi Postgres nélkül is végigjátszható.
 */
function fakeTurnRepository(options: { failOnCreate?: Error } = {}) {
  const created: Array<Parameters<AgentTurnRepository['create']>[0]> = []
  const finalized: Array<{ id: string } & FinalizeAgentTurnInput> = []
  const progress: Array<{
    id: string
    lockToken: string
    partialText?: string
    activities?: unknown
  }> = []
  const activeByConversation = new Map<string, AgentTurn>()
  const rowsById = new Map<string, AgentTurn>()
  const inputById = new Map<string, Parameters<AgentTurnRepository['create']>[0]>()
  const heartbeats: Array<{ id: string; lockToken: string }> = []
  const claimed: Array<{ id: string; ownerToken: string }> = []
  const repo: AgentTurnRepository = {
    async create(data) {
      if (options.failOnCreate) throw options.failOnCreate
      if (activeByConversation.has(data.conversationId)) {
        throw new ActiveAgentTurnExistsError(data.conversationId)
      }
      created.push(data)
      const id = `turn-${created.length}`
      inputById.set(id, data)
      const row = {
        id,
        conversationId: data.conversationId,
        tenantId: data.tenantId,
        agentId: data.agentId,
        agentVersion: data.agentVersion,
        createdById: data.createdById,
        status: data.status ?? 'running',
        userMessageId: data.userMessageId ?? null,
        lockToken: data.lockToken ?? null,
        input: data.input ?? null,
        partialText: '',
        activities: [],
        startedAt: new Date(),
        // A séma szerint NOT NULL, `now()` alapértékkel — a foglalás
        // stale-ellenőrzése ezt olvassa, ezért a fake-ben is jelen kell lennie.
        heartbeatAt: new Date(),
        launchId: data.launchId ?? null,
        launchAttemptCount: 0,
        launchNextRetryAt: null,
        launchProviderRef: null,
        launchReservedAt: null,
        cancelRequested: false,
      } as unknown as AgentTurn
      activeByConversation.set(data.conversationId, row)
      rowsById.set(id, row)
      return row
    },
    async findById(id) {
      return rowsById.get(id) ?? null
    },
    async findActiveByConversation(conversationId) {
      return activeByConversation.get(conversationId) ?? null
    },
    async listActiveByTenant() {
      return [...activeByConversation.values()]
    },
    async listRecentTerminalByTenant() {
      return []
    },
    async attachUserMessage(id, userMessageId) {
      const input = inputById.get(id)
      if (input) input.userMessageId = userMessageId
      const row = rowsById.get(id)
      if (row) Object.assign(row, { userMessageId })
    },
    async acquireLock() {
      return null
    },
    async claim(id, ownerToken, now, launchId) {
      const row = rowsById.get(id)
      if (
        !row ||
        row.status !== 'queued' ||
        row.lockToken !== null ||
        row.launchId !== launchId ||
        row.cancelRequested
      ) {
        return null
      }
      claimed.push({ id, ownerToken })
      Object.assign(row, { status: 'running', lockToken: ownerToken, lockedAt: now, heartbeatAt: now })
      return row
    },
    async recordLaunchAttempt(id, data) {
      const row = rowsById.get(id)
      if (!row || row.status !== 'queued') return null
      Object.assign(row, {
        launchId: data.launchId,
        launchNextRetryAt: data.nextRetryAt,
        launchAttemptCount: data.incrementAttempt
          ? (row.launchAttemptCount ?? 0) + 1
          : row.launchAttemptCount,
        ...(data.providerRef !== undefined ? { launchProviderRef: data.providerRef } : {}),
      })
      return row
    },
    async reserveLaunchCapacity(id, data, now) {
      const row = rowsById.get(id)
      if (!row || row.status !== 'queued' || row.launchId) return 'not_waiting'
      Object.assign(row, {
        launchId: data.launchId,
        launchReservedAt: now,
        launchNextRetryAt: data.nextRetryAt,
        launchAttemptCount: (row.launchAttemptCount ?? 0) + 1,
      })
      return 'reserved'
    },
    async findQueuedForLaunch(now, limit) {
      return [...rowsById.values()]
        .filter(
          (row) =>
            row.status === 'queued' &&
            row.userMessageId &&
            (row.launchNextRetryAt == null || row.launchNextRetryAt <= now),
        )
        .slice(0, limit)
    },
    async releaseLock() {},
    async heartbeat(id, lockToken, now) {
      heartbeats.push({ id, lockToken })
      const row = rowsById.get(id)
      if (!row || row.lockToken !== lockToken) return null
      if (!activeByConversation.has(row.conversationId)) return null
      Object.assign(row, { heartbeatAt: now })
      return row
    },
    async updateProgress(id, lockToken, data) {
      const row = rowsById.get(id)
      if (!row || row.lockToken !== lockToken) return null
      if (!activeByConversation.has(row.conversationId)) return null
      progress.push({ id, lockToken, ...data })
      if (data.partialText !== undefined) Object.assign(row, { partialText: data.partialText })
      if (data.activities !== undefined) Object.assign(row, { activities: data.activities })
      return row
    },
    async requestCancel(id, byUserId, now = new Date()) {
      const row = rowsById.get(id)
      if (!row || !activeByConversation.has(row.conversationId)) return null
      Object.assign(row, {
        cancelRequested: true,
        cancelRequestedById: byUserId,
        cancelRequestedAt: now,
      })
      return row
    },
    async isCancelRequested(id) {
      const row = rowsById.get(id)
      return Boolean(row?.cancelRequested && activeByConversation.has(row.conversationId))
    },
    async finalize(id, data, lockToken) {
      const row = rowsById.get(id)
      if (!row || !activeByConversation.has(row.conversationId)) return null
      if (lockToken !== undefined && row.lockToken !== lockToken) return null
      finalized.push({ id, ...data })
      {
        Object.assign(row, {
          status: data.status,
          reason: data.reason ?? null,
          error: data.error ?? null,
          partialText: data.partialText ?? row.partialText,
          activities: data.activities ?? row.activities,
          assistantMessageId: data.assistantMessageId ?? null,
          lockToken: null,
        })
        activeByConversation.delete(row.conversationId)
      }
      return row ?? null
    },
    async findStale() {
      return []
    },
    async findOwnedStartedBefore() {
      return []
    },
    async findLatestTerminalByConversation() {
      return null
    },
  }
  /** Az aktív forduló életjelét `ms` ezredmásodperccel korábbra állítja. */
  const ageActiveTurn = (conversationId: string, ms: number) => {
    const row = activeByConversation.get(conversationId)
    if (row) Object.assign(row, { heartbeatAt: new Date(Date.now() - ms) })
  }
  return { repo, created, finalized, progress, ageActiveTurn, heartbeats, claimed, rowsById }
}

function buildRuntime(options: {
  turns?: AgentTurnRepository
  replyChunks?: string[]
  streamError?: Error
  /** A megadott chunkok után dob — stream közbeni részválasz-vesztés regressziójához. */
  streamErrorAfterChunks?: Error
  /** Engedélyezett capability → a forduló a tool-loop ágon fut. */
  withTools?: boolean
  /**
   * Körönként kiadott tool-hívások (index = hányadik modellhívás). Ahol nincs
   * bejegyzés, a modell sima szöveggel válaszol és a loop lezárul.
   */
  modelToolCalls?: Array<GatewayToolCall[] | undefined>
  /** Ezekre a file_read path-okra a broker elutasítást ad — a deniedCount méréséhez. */
  deniedPaths?: string[]
  /** C1: időközben megérkezett, még meg nem jelenített delegációs ticketek. */
  returnedDelegations?: Array<{ id: string; title: string; payload: Record<string, unknown> }>
  /** #516: saját indító (pl. „másik processz" szimulálásához). */
  launcher?: ChatTurnLauncher
  /** #516: közös beszélgetés-tár két runtime-példány között. */
  messages?: Array<Message & { content: string }>
}) {
  const messages: Array<Message & { content: string }> = options.messages ?? []
  let seq = 0
  const conversations = {
    createConversation: async () => ({ id: 'conv-1' }),
    getConversation: async () => ({
      conversation: { id: 'conv-1', agentId: 'agent-1', projectKey: '__general__' },
      messages: messages.map((m) => ({ ...m, contentDeletedAt: null })),
    }),
    appendMessage: async (params: {
      role: string
      content: string
      onPersisted?: (message: Message) => void
    }) => {
      seq += 1
      const message = {
        id: `${params.role}-msg-${seq}`,
        conversationId: 'conv-1',
        seq,
        role: params.role,
        content: params.content,
        createdAt: new Date(Date.now() + seq * 1000),
      } as unknown as Message & { content: string }
      messages.push(message)
      params.onPersisted?.(message)
      return message
    },
  } as unknown as ConversationService

  let modelCallIndex = 0
  const gatewayCalls: Array<{ messages: Array<{ role: string; content?: string }> }> = []
  const gateway = {
    async *callStream(args: { messages: Array<{ role: string; content?: string }> }) {
      gatewayCalls.push({ messages: args?.messages ?? [] })
      if (options.streamError) throw options.streamError
      for (const chunk of options.replyChunks ?? ['Szia! ', 'Miben segíthetek?']) {
        yield chunk
      }
      if (options.streamErrorAfterChunks) throw options.streamErrorAfterChunks
    },
    async call(args: { messages: Array<{ role: string; content?: string }> }) {
      gatewayCalls.push({ messages: args?.messages ?? [] })
      if (options.streamError) throw options.streamError
      const scripted = options.modelToolCalls?.[modelCallIndex]
      modelCallIndex += 1
      if (scripted && scripted.length > 0) {
        return { content: '', toolCalls: scripted, usage: { promptTokens: 1, completionTokens: 1 } }
      }
      return {
        content: (options.replyChunks ?? ['Szia! ', 'Miben segíthetek?']).join(''),
        usage: { promptTokens: 1, completionTokens: 1 },
      }
    },
  } as unknown as ModelGateway

  const deniedPaths = new Set(options.deniedPaths ?? [])
  const toolBroker = {
    invoke: async (input: { args?: { path?: string } }) =>
      deniedPaths.has(input.args?.path ?? '')
        ? { denied: true, reason: 'policy', resultMeta: {}, latencyMs: 1 }
        : { denied: false, result: { ok: true }, resultMeta: {}, latencyMs: 1 },
  } as unknown as ToolBrokerService

  const toolCaps = {
    findCapabilitiesForAgent: async () =>
      options.withTools ? [{ allowed: true, toolName: 'file_read' }] : [],
    findCapability: async () => null,
    findConnectorsForAgent: async () => [],
    findDocumentsForConnector: async () => [],
    listToolCallsForConversation: async () => [],
  } as unknown as ToolBrokerRepository

  // C1: megérkezett delegációk beemelése. A `surfaced` az idempotencia-jelölés —
  // enélkül ugyanaz a válasz minden fordulóban újra a promptba kerülne.
  const surfaced: string[] = []
  const tickets = {
    listReturnedDelegationsForConversation: async () => options.returnedDelegations ?? [],
    markDelegationSurfaced: async (ticketId: string) => {
      surfaced.push(ticketId)
    },
  } as unknown as TicketRepository

  const runtime = new AgentChatRuntime(
    {
      findByIdForRuntime: async () => ({
        agent: agentRow(),
        memoryContent: null,
        memoryVersion: null,
      }),
      findMany: async () => [],
      findById: async (id: string) => ({ id, name: 'Ákos' }),
    } as unknown as AgentRepository,
    { findById: async () => null } as unknown as DocumentRepository,
    tickets,
    gateway,
    conversations,
    toolBroker,
    toolCaps,
    { list: async () => [] } as unknown as WorkspaceStorage,
    { append: async () => ({ id: 'audit-1' }) } as unknown as AuditRepository,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.turns,
    undefined,
    // #142 — a chat-indítás user→agent `address` kaput kap. Bekötetlen gráf-
    // szolgáltatásnál a chat FAIL-CLOSED módon nem indul el, ezért a fókusztesztek
    // egy korlátozás nélküli (C4 alapértékű) tenant-gráfot kapnak.
    permissiveAgentAccess(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.launcher,
  )
  return { runtime, messages, gatewayCalls, surfaced }
}

function turnParams() {
  return {
    agentId: 'agent-1',
    content: 'Szia',
    createdById: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conv-1',
  }
}

async function main() {
  console.log('=== Chat forduló-rekord teszt ===')

  await test('sikeres forduló: rekord létrejön és completed állapotra zárul', async () => {
    const turns = fakeTurnRepository()
    const { runtime } = buildRuntime({ turns: turns.repo })

    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)

    assert.equal(turns.created.length, 1, 'pontosan egy forduló-rekord keletkezik')
    const record = turns.created[0]
    assert.equal(record.conversationId, 'conv-1')
    assert.equal(record.tenantId, 'tenant-1')
    assert.equal(record.agentId, 'agent-1')
    assert.equal(record.agentVersion, 3)
    assert.equal(record.createdById, 'user-1')
    // #516: a rekord `queued`, lock nélkül jön létre; a tulajdonjogot a
    // futtatómag szerzi meg atomi claimmel.
    assert.equal(record.status, 'queued')
    assert.equal(record.lockToken, undefined)
    assert.equal((record.input as { v: number }).v, 1, 'verziózott bemenet a rekordon')
    // A rekord a forduló user-üzenetére mutat.
    const userMessageEvent = events.find((e) => e.type === 'meta')
    assert.equal(record.userMessageId, userMessageEvent?.userMessageId)

    assert.equal(turns.finalized.length, 1, 'a forduló pontosan egyszer zárul')
    const closed = turns.finalized[0]
    assert.equal(closed.id, 'turn-1')
    assert.equal(closed.status, 'completed')
    assert.equal(closed.reason, undefined)
    // A lezárt rekord a keletkezett agent-üzenetre mutat vissza.
    const doneEvent = events.find((e) => e.type === 'done')
    assert.ok(doneEvent, 'a stream done eseménnyel zárul')
    assert.equal(closed.assistantMessageId, doneEvent.messageId)
    assert.equal(closed.partialText, 'Szia! Miben segíthetek?')
  })

  await test('modellhiba: a forduló failed állapotra zárul, a hibaüzenettel', async () => {
    const turns = fakeTurnRepository()
    const { runtime, messages } = buildRuntime({
      turns: turns.repo,
      streamError: new Error('gateway timeout'),
    })

    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)

    assert.deepEqual(
      events.filter((e) => e.type === 'error').map((e) => e.message),
      ['gateway timeout'],
    )
    assert.equal(turns.finalized.length, 1)
    assert.equal(turns.finalized[0].status, 'failed')
    assert.equal(turns.finalized[0].reason, 'error')
    assert.equal(turns.finalized[0].error, 'gateway timeout')
    assert.ok(
      messages.some((message) => message.role === 'agent' && message.content.includes('gateway timeout')),
      'a hiba lezáró üzenete a beszélgetésben is megmarad',
    )
  })

  await test('stream közbeni hiba: a már megjelent részválasz bekerül a lezáró üzenetbe', async () => {
    const turns = fakeTurnRepository()
    const partial = 'A feldolgozásból eddig 176 sort sikerült párosítani.'
    const { runtime, messages } = buildRuntime({
      turns: turns.repo,
      replyChunks: [partial],
      streamErrorAfterChunks: new Error('provider stream interrupted'),
    })

    for await (const _ of runtime.sendMessageStream(turnParams())) void _

    const failedMessage = messages.find((message) => message.role === 'agent')
    assert.ok(failedMessage, 'hiba esetén lezáró agent-üzenet készül')
    assert.ok(
      failedMessage!.content.includes(partial),
      'a felhasználó által már látott részválasz nem veszhet el újratöltéskor',
    )
    assert.equal(turns.finalized[0].partialText, partial)
  })

  await test('tool-loop hiba: nem marad néma a beszélgetés', async () => {
    const turns = fakeTurnRepository()
    const budgetError =
      'Gateway budget gate: Token limit exceeded: 10140654/10000000 per day (scope=agent)'
    const { runtime, messages } = buildRuntime({
      turns: turns.repo,
      withTools: true,
      streamError: new Error(budgetError),
    })

    for await (const _ of runtime.sendMessageStream(turnParams())) void _

    const failedMessage = messages.find((message) => message.role === 'agent')
    assert.ok(failedMessage, 'a tool-loop hibaága is lezáró üzenetet ír')
    assert.ok(failedMessage!.content.includes('keret'))
    assert.ok(!failedMessage!.content.includes('Gateway budget gate'))
  })

  await test('eldobott stream: a forduló befut és completed állapotra zárul (#60/E1)', async () => {
    const turns = fakeTurnRepository()
    const { runtime, messages } = buildRuntime({ turns: turns.repo })

    // A kliens lecsatlakozása: a fogyasztó az első token után elhagyja a ciklust.
    // A generátor `finally`-ága CSAK a feliratkozást bontja — a futás megy tovább.
    const seen: string[] = []
    for await (const event of runtime.sendMessageStream(turnParams())) {
      seen.push(event.type)
      if (event.type === 'token') break
    }
    assert.equal(seen[0], 'turn', 'a stream első eseménye a forduló azonosítója')
    await waitUntil(() => turns.finalized.length === 1)

    assert.equal(turns.created.length, 1)
    assert.equal(turns.finalized.length, 1, 'a rekord pontosan egyszer zárul')
    assert.equal(turns.finalized[0].status, 'completed')
    assert.ok(
      turns.finalized[0].assistantMessageId,
      'a lezárt rekord a keletkezett agent-üzenetre mutat',
    )
    assert.ok(
      messages.some((m) => m.role === 'agent'),
      'a válasz a lecsatlakozás ellenére bekerül a beszélgetésbe',
    )
  })

  await test('E5: két párhuzamos küldés — pontosan egy indul el, a másik ütközést kap', async () => {
    const turns = fakeTurnRepository()
    const { runtime, messages } = buildRuntime({ turns: turns.repo })

    const drain = async () => {
      const events = []
      for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)
      return events
    }
    const [a, b] = await Promise.all([drain(), drain()])

    const conflicts = [...a, ...b].filter((e) => e.type === 'conflict')
    const dones = [...a, ...b].filter((e) => e.type === 'done')
    assert.equal(dones.length, 1, 'pontosan egy forduló fut le')
    assert.equal(conflicts.length, 1, 'a másik küldés ütközést kap')
    // A kliens az azonosítóval találja meg a már futó fordulót (D7 / §6.3).
    assert.equal(conflicts[0].activeTurnId, 'turn-1')
    assert.equal(conflicts[0].conversationId, 'conv-1')

    // Az elutasított küldés nem hagy árva felhasználói üzenetet a beszélgetésben.
    assert.equal(
      messages.filter((m) => m.role === 'user').length,
      1,
      'csak a nyertes küldés user-üzenete perzisztálódik',
    )
    assert.equal(turns.created.length, 1, 'egyetlen forduló-rekord keletkezik')
  })

  await test('terminális forduló után az új küldés normálisan indul', async () => {
    const turns = fakeTurnRepository()
    const { runtime } = buildRuntime({ turns: turns.repo })

    for await (const _ of runtime.sendMessageStream(turnParams())) void _
    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)

    assert.ok(!events.some((e) => e.type === 'conflict'), 'a felszabadult hely újra foglalható')
    assert.ok(events.some((e) => e.type === 'done'))
    assert.equal(turns.created.length, 2)
  })

  await test('elhalt forduló: az életjel nélkül maradt rekordot a foglalás visszaveszi', async () => {
    // A D7 egy zár, és zár nem létezik lejárat nélkül: ha egy futás crash/deploy
    // miatt `running` állapotban ragad, e nélkül a beszélgetés VÉGLEG zárva
    // maradna — minden további küldés ütközést kapna.
    const turns = fakeTurnRepository()
    const { runtime } = buildRuntime({ turns: turns.repo })

    // Egy „félbemaradt" forduló: a rekord aktív, de rég nem adott életjelet.
    await turns.repo.create({
      conversationId: 'conv-1',
      tenantId: null,
      agentId: 'agent-1',
      agentVersion: 1,
      createdById: 'user-1',
      status: 'running',
    })
    turns.ageActiveTurn('conv-1', 10 * 60_000)

    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)

    assert.ok(!events.some((e) => e.type === 'conflict'), 'az elhalt forduló nem blokkolhat')
    assert.ok(events.some((e) => e.type === 'done'), 'az új forduló lefut')
    const reclaimed = turns.finalized.find((f) => f.id === 'turn-1')
    assert.equal(reclaimed?.status, 'failed')
    assert.equal(reclaimed?.reason, 'watchdog', 'a visszavétel őszintén jelölve van')
  })

  await test('friss életjelű forduló NEM vehető vissza', async () => {
    // A stale-ág ellenpróbája: ami él, azt nem szabad kiütni — különben két
    // párhuzamos futás írna ugyanabba a beszélgetésbe.
    const turns = fakeTurnRepository()
    const { runtime } = buildRuntime({ turns: turns.repo })

    await turns.repo.create({
      conversationId: 'conv-1',
      tenantId: null,
      agentId: 'agent-1',
      agentVersion: 1,
      createdById: 'user-1',
      status: 'running',
    })
    turns.ageActiveTurn('conv-1', 5_000)

    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)

    assert.ok(events.some((e) => e.type === 'conflict'), 'az élő forduló ütközést ad')
    assert.equal(turns.finalized.length, 0, 'élő fordulót nem zárunk le')
  })

  await test('#517: queued, régi heartbeatű forduló nem watchdog — 409, a launch-helyreállításé', async () => {
    const turns = fakeTurnRepository()
    const { runtime } = buildRuntime({ turns: turns.repo })
    await turns.repo.create({
      conversationId: 'conv-1',
      tenantId: null,
      agentId: 'agent-1',
      agentVersion: 1,
      createdById: 'user-1',
      status: 'queued',
      userMessageId: 'msg-queued',
      input: { v: 1, content: 'Szia', attachmentDocumentIds: [] },
    })
    turns.ageActiveTurn('conv-1', 10 * 60_000)

    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)

    assert.ok(events.some((e) => e.type === 'conflict'), 'a queued foglalás ütközést ad')
    assert.equal(turns.finalized.length, 0, 'queued sort nem zár a 120s watchdog')
  })



  await test('#516: a rekord létrehozásának hibája = nincs hamis elfogadás, nincs futás', async () => {
    // Elérhetetlen rekord-tár: tartós bemenet nélkül a futás nem indulhat el,
    // és a felhasználó sem kaphat „elfogadva" visszajelzést.
    const turns = fakeTurnRepository({
      failOnCreate: new Error('agent_turns tábla elérhetetlen'),
    })
    const { runtime, messages } = buildRuntime({ turns: turns.repo })

    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)

    assert.deepEqual(
      events.map((e) => e.type),
      ['error'],
      'se turn, se meta — a kliens nem tarthatja meg elfogadottként',
    )
    assert.equal(messages.length, 0, 'user-üzenet sem perzisztálódik rekord nélkül')
    assert.equal(turns.finalized.length, 0)
  })

  await test('a tool-loop körönként életjelet ír a forduló-rekordra', async () => {
    const turns = fakeTurnRepository()
    const { runtime } = buildRuntime({ turns: turns.repo, withTools: true })

    // végigfogyasztjuk a streamet, hogy a loop minden köre lefusson
    for await (const _event of runtime.sendMessageStream(turnParams())) void _event

    assert.ok(turns.heartbeats.length >= 1, 'legalább egy kör → legalább egy életjel')
    assert.equal(turns.heartbeats[0].id, 'turn-1')
    // #516: a token a futtatómag claimjéből származik, nem a foglalásból.
    assert.ok(turns.claimed[0]?.ownerToken, 'a futtató saját tulajdonos-tokent vált a claimkor')
    assert.equal(
      turns.heartbeats[0].lockToken,
      turns.claimed[0].ownerToken,
      'az életjel a saját tulajdonos-tokenjével megy — csak a tulajdonos frissíthet',
    )
  })

  await test('#63: futó forduló mellett a rekord részszöveget és aktivitást tükröz', async () => {
    const turns = fakeTurnRepository()
    // Hosszú válasz → karakter-küszöb feletti flush a stream közben.
    const longReply = `Első szó ${'x'.repeat(220)} utolsó.`
    const { runtime } = buildRuntime({
      turns: turns.repo,
      withTools: true,
      replyChunks: [longReply],
    })

    // A fogyasztó csak az első activity-ig olvas — a futás megy tovább.
    for await (const event of runtime.sendMessageStream(turnParams())) {
      if (event.type === 'activity') break
    }

    await waitUntil(() =>
      turns.progress.some((p) => Array.isArray(p.activities) && (p.activities as unknown[]).length > 0),
    )

    const mid = await turns.repo.findById('turn-1')
    assert.ok(mid, 'a futó forduló rekordja visszaolvasható')
    assert.ok(Array.isArray(mid!.activities) && (mid!.activities as unknown[]).length > 0,
      'aktivitások a rekordon vannak futás közben')

    await waitUntil(async () => {
      const row = await turns.repo.findById('turn-1')
      return Boolean(row?.partialText && row.partialText.length > 0)
    })
    const withText = await turns.repo.findById('turn-1')
    assert.ok(
      (withText?.partialText?.length ?? 0) > 0,
      'a részszöveg a rekordon van a stream közben',
    )

    await waitUntil(() => turns.finalized.length === 1)
  })

  await test('a lezárt rekord a valós kör- és eszközhívás-számot mutatja', async () => {
    const turns = fakeTurnRepository()
    const { runtime } = buildRuntime({
      turns: turns.repo,
      withTools: true,
      // 1. kör: két file_read (az egyiket a policy elutasítja), 2. kör: szöveges válasz.
      modelToolCalls: [
        [
          { id: 'call-ok', name: 'file_read', input: { path: 'a.txt' } },
          { id: 'call-denied', name: 'file_read', input: { path: 'b.txt' } },
        ],
      ],
      deniedPaths: ['b.txt'],
    })

    for await (const _ of runtime.sendMessageStream(turnParams())) void _

    assert.equal(turns.finalized.length, 1)
    const closed = turns.finalized[0]
    // E nélkül a rekord nullát mutatna: az üzemeltető a hibakereső exportban nem
    // látja, mire ment el a forduló kerete, és a prompt-eval red-line üres
    // méréssel fut.
    assert.equal(closed.toolCallCount, 2, 'mindkét eszközhívás számít')
    assert.equal(closed.deniedCount, 1, 'az elutasított hívás külön is látszik')
    assert.equal(closed.turnCount, 2, 'két megkezdett kör: tool-kör + záró válasz')
  })

  await test('C1: időközben megérkezett delegált válasz bekerül a következő fordulóba', async () => {
    const turns = fakeTurnRepository()
    const { runtime, gatewayCalls, surfaced } = buildRuntime({
      turns: turns.repo,
      returnedDelegations: [
        {
          id: 'deleg-1',
          title: 'Delegálás: riport formátum',
          payload: {
            delegation: true,
            delegationReturned: true,
            question: 'Milyen formátumú a /reports/query q paramétere?',
            answer: 'base64url(JSON), period objektummal.',
            answeredByAgentId: 'agent-2',
            confidence: 'high',
          },
        },
      ],
    })

    for await (const _ of runtime.sendMessageStream(turnParams())) void _

    const systemText = gatewayCalls
      .flatMap((call) => call.messages)
      .filter((m) => m.role === 'system')
      .map((m) => m.content ?? '')
      .join('\n')
    // Üzletileg ez a lényeg: a felhasználó kérdésére nem csend a válasz — a
    // közben megérkezett delegált válasz eljut az agenthez.
    assert.match(systemText, /base64url\(JSON\)/)
    assert.match(systemText, /Ákos/, 'a megkérdezett agent neve is látszik')
    assert.match(systemText, /NE kérdezd meg ugyanazt/)
    // ...és pontosan egyszer: a megjelenítettet megjelöljük.
    assert.deepEqual(surfaced, ['deleg-1'])
  })

  await test('C1: üres válaszú delegáció nem kerül a promptba', async () => {
    const { runtime, gatewayCalls, surfaced } = buildRuntime({
      turns: fakeTurnRepository().repo,
      returnedDelegations: [
        {
          id: 'deleg-empty',
          title: 'Delegálás: semmi',
          payload: { delegation: true, delegationReturned: true, question: 'k', answer: '  ' },
        },
      ],
    })

    for await (const _ of runtime.sendMessageStream(turnParams())) void _

    const systemText = gatewayCalls
      .flatMap((call) => call.messages)
      .filter((m) => m.role === 'system')
      .map((m) => m.content ?? '')
      .join('\n')
    assert.doesNotMatch(systemText, /Időközben megérkezett válaszok/)
    assert.deepEqual(surfaced, [], 'nem jelölünk meg olyat, ami meg sem jelent')
  })

  await test('C1: vegyes delegációknál csak a ténylegesen átadott válasz jelölhető meg', async () => {
    const { runtime, gatewayCalls, surfaced } = buildRuntime({
      turns: fakeTurnRepository().repo,
      returnedDelegations: [
        {
          id: 'deleg-ready',
          title: 'Delegálás: kész',
          payload: { delegation: true, delegationReturned: true, question: 'kész?', answer: 'Igen.' },
        },
        {
          id: 'deleg-empty',
          title: 'Delegálás: még nincs válasz',
          payload: { delegation: true, delegationReturned: true, question: 'később?', answer: '  ' },
        },
      ],
    })

    for await (const _ of runtime.sendMessageStream(turnParams())) void _

    const systemText = gatewayCalls
      .flatMap((call) => call.messages)
      .filter((m) => m.role === 'system')
      .map((m) => m.content ?? '')
      .join('\n')
    assert.match(systemText, /Igen\./)
    assert.deepEqual(surfaced, ['deleg-ready'], 'a később érkező válasz maradjon megjeleníthető')
  })

  await test('tool nélküli forduló nulla számlálókkal zárul', async () => {
    const turns = fakeTurnRepository()
    const { runtime } = buildRuntime({ turns: turns.repo })

    for await (const _ of runtime.sendMessageStream(turnParams())) void _

    assert.equal(turns.finalized.length, 1)
    assert.equal(turns.finalized[0].toolCallCount, 0)
    assert.equal(turns.finalized[0].deniedCount, 0)
  })

  await test('#63: szűrendő tartalom nem kerül nyersen a rekordra', async () => {
    const turns = fakeTurnRepository()
    const pan = '4111 1111 1111 1111'
    const { runtime } = buildRuntime({
      turns: turns.repo,
      replyChunks: [`A kártyaszám ${pan} — ${'y'.repeat(200)}`],
    })

    for await (const _ of runtime.sendMessageStream(turnParams())) void _

    assert.equal(turns.finalized.length, 1)
    const closed = turns.finalized[0]
    assert.equal(closed.partialText?.includes(pan), false, 'nyers PAN nem a rekordon')
    assert.ok(closed.partialText?.includes('«redaktált:'), 'redakciós jelölő a lezárt rekordon')

    for (const write of turns.progress) {
      if (write.partialText === undefined) continue
      assert.equal(
        write.partialText.includes(pan),
        false,
        'köztes snapshot sem tartalmaz nyers PAN-t',
      )
    }
  })

  await test('#63: hosszú válasznál a snapshot-írások a küszöb nagyságrendje', async () => {
    const turns = fakeTurnRepository()
    // ~10 szó × ~40 karakter → ~400 karakter, szó-chunkolással több flush.
    const words = Array.from({ length: 40 }, (_, i) => `szó${i}${'z'.repeat(30)}`)
    const { runtime } = buildRuntime({
      turns: turns.repo,
      replyChunks: [words.join(' ')],
    })

    for await (const _ of runtime.sendMessageStream(turnParams())) void _

    const partialWrites = turns.progress.filter((p) => p.partialText !== undefined).length
    const tokenEvents = 40 // chunkForStreaming szóhatáronként
    assert.ok(
      partialWrites > 0 && partialWrites < tokenEvents,
      `írások (${partialWrites}) a tokenek (${tokenEvents}) alatt, küszöb-nagyságrend`,
    )
  })

  await test('#516: bekötetlen forduló-tár esetén a chat egyértelmű hibával áll le', async () => {
    const { runtime } = buildRuntime({})
    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)
    assert.deepEqual(events.map((e) => e.type), ['error'])
  })

  // ── #516: tartós bemenet + közös futtatómag ──────────────────────────────

  await test('#516: a fogadás csak a rekordot, bemenetet és user-üzenetet írja — a futás a launcheré', async () => {
    const turns = fakeTurnRepository()
    const launched: string[] = []
    const launcher: ChatTurnLauncher = {
      async launch({ turnId }) {
        launched.push(turnId)
        return { launchId: 'launch-1', outcome: 'accepted' }
      },
      async reconcile() {
        return { state: 'not_found' }
      },
    }
    const { runtime, messages, gatewayCalls } = buildRuntime({ turns: turns.repo, launcher })

    const events = []
    for await (const event of runtime.sendMessageStream({ ...turnParams(), modelContextPrefix: '[külső app: rendelés #42]' })) {
      events.push(event)
    }

    // A stream a tartós fogadás után lezárul (turn + meta) — ez NEM a munka vége.
    assert.deepEqual(events.map((e) => e.type), ['turn', 'meta'])
    assert.deepEqual(launched, ['turn-1'])
    assert.equal(gatewayCalls.length, 0, 'a kérés-úton nincs modellhívás')
    const row = turns.rowsById.get('turn-1')!
    assert.equal(row.status, 'queued')
    assert.equal(row.userMessageId, messages[0].id, 'a user-üzenet a rekordhoz kötve')
    const input = row.input as { v: number; content: string; modelContextPrefix?: string }
    assert.equal(input.v, 1)
    assert.equal(input.content, 'Szia')
    assert.equal(input.modelContextPrefix, '[külső app: rendelés #42]')
  })

  await test('#516: ÚJ PROCESSZ — a mag csak a turnId-ból, a mentett bemenetből rekonstruál és lefut', async () => {
    const turns = fakeTurnRepository()
    const launcher: ChatTurnLauncher = {
      async launch() {
        return { launchId: 'launch-1', outcome: 'accepted' }
      },
      async reconcile() {
        return { state: 'not_found' }
      },
    }
    const shared: Array<Message & { content: string }> = []
    const requester = buildRuntime({ turns: turns.repo, launcher, messages: shared })
    for await (const _ of requester.runtime.sendMessageStream({
      ...turnParams(),
      modelContextPrefix: '[külső app: rendelés #42]',
    })) void _

    // „Másik processz": friss runtime-példány, closure nélkül, ugyanaz a DB.
    const storedLaunchId = turns.rowsById.get('turn-1')!.launchId!
    const worker = buildRuntime({ turns: turns.repo, messages: shared })
    const events: Array<{ type: string }> = []
    await worker.runtime.runReservedTurn({ turnId: 'turn-1', launchId: storedLaunchId }, (e) => {
      events.push(e)
    })

    assert.ok(events.some((e) => e.type === 'done'), 'a futás done-nal zárul')
    assert.equal(worker.gatewayCalls.length, 1, 'a worker hívja a modellt')
    const userPrompt = worker.gatewayCalls[0].messages.find((m) => m.role === 'user')?.content ?? ''
    assert.ok(
      userPrompt.includes('[külső app: rendelés #42]'),
      'a privát modellkontextus a mentett bemenetből visszakerül a promptba',
    )
    assert.ok(shared.some((m) => m.role === 'agent'), 'az agent-válasz a beszélgetésbe kerül')
    const row = turns.rowsById.get('turn-1')!
    assert.equal(row.status, 'completed')
    assert.equal(turns.claimed.length, 1)
    assert.notEqual(turns.claimed[0].ownerToken, storedLaunchId, 'a tulajdonos-token ≠ indítási azonosító')
    assert.equal(turns.finalized[0].assistantMessageId, shared.find((m) => m.role === 'agent')!.id)
  })

  await test('#516: dupla indítás — a második futtató claim nélkül, mellékhatás nélkül kilép', async () => {
    const turns = fakeTurnRepository()
    const launcher: ChatTurnLauncher = {
      async launch() {
        return { launchId: 'launch-1', outcome: 'accepted' }
      },
      async reconcile() {
        return { state: 'not_found' }
      },
    }
    const shared: Array<Message & { content: string }> = []
    const requester = buildRuntime({ turns: turns.repo, launcher, messages: shared })
    for await (const _ of requester.runtime.sendMessageStream(turnParams())) void _

    const launchId = turns.rowsById.get('turn-1')!.launchId!
    const a = buildRuntime({ turns: turns.repo, messages: shared })
    const b = buildRuntime({ turns: turns.repo, messages: shared })
    await Promise.all([
      a.runtime.runReservedTurn({ turnId: 'turn-1', launchId }),
      b.runtime.runReservedTurn({ turnId: 'turn-1', launchId }),
    ])

    assert.equal(turns.claimed.length, 1, 'pontosan egy claim')
    assert.equal(a.gatewayCalls.length + b.gatewayCalls.length, 1, 'egyetlen modellhívás')
    assert.equal(shared.filter((m) => m.role === 'agent').length, 1, 'egyetlen agent-válasz')
  })

  await test('#516: ismeretlen bemeneti verzió egyértelmű hiba, a rekord nem claimelődik', async () => {
    const turns = fakeTurnRepository()
    await turns.repo.create({
      conversationId: 'conv-1',
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      agentVersion: 3,
      createdById: 'user-1',
      status: 'queued',
      userMessageId: 'user-msg-0',
      input: { v: 99, content: 'x', attachmentDocumentIds: [] },
    })
    const { runtime, gatewayCalls, messages } = buildRuntime({ turns: turns.repo })
    const events: Array<{ type: string; message?: string }> = []
    await runtime.runReservedTurn({ turnId: 'turn-1', launchId: 'launch-1' }, (e) => {
      events.push(e)
    })
    assert.equal(turns.claimed.length, 0)
    assert.equal(gatewayCalls.length, 0)
    const row = turns.rowsById.get('turn-1')!
    assert.equal(row.status, 'failed', 'a beszélgetés D7-zárolása feloldódik')
    assert.equal(row.reason, 'error')
    assert.match(row.error ?? '', /Ismeretlen bemeneti verzió: 99/)
    assert.ok(events.some((e) => e.type === 'error' && /Ismeretlen bemeneti verzió: 99/.test(e.message ?? '')))
    assert.ok(messages.some((m) => m.role === 'agent'), 'a felhasználó látja a hibát, nem némán áll meg')
  })

  await test('#516: hiányzó user-üzenet — nem claimel, a queued zárolás feloldódik', async () => {
    const turns = fakeTurnRepository()
    await turns.repo.create({
      conversationId: 'conv-1',
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      agentVersion: 3,
      createdById: 'user-1',
      status: 'queued',
      input: { v: 1, content: 'Szia', attachmentDocumentIds: [] },
    })
    const { runtime, gatewayCalls } = buildRuntime({ turns: turns.repo })
    await runtime.runReservedTurn({ turnId: 'turn-1', launchId: 'launch-1' })
    assert.equal(turns.claimed.length, 0)
    assert.equal(gatewayCalls.length, 0)
    assert.equal(turns.rowsById.get('turn-1')!.status, 'failed')
    assert.equal(await turns.repo.findActiveByConversation('conv-1'), null)
  })

  await test('#516: tulajdonvesztés után nincs új modellhívás, és a régi tulajdonos nem ír végállapotot', async () => {
    const turns = fakeTurnRepository()
    // A watchdog / másik futtató a MÁSODIK életjel előtt átveszi a fordulót:
    // token nélküli (reclaim) lezárás, ahogy a watchdog teszi.
    const originalHeartbeat = turns.repo.heartbeat.bind(turns.repo)
    let lostAtCall = 0
    turns.repo.heartbeat = async (id, token, now) => {
      if (turns.heartbeats.length === 1) {
        await turns.repo.finalize(id, { status: 'failed', reason: 'watchdog', error: 'reclaimed' })
        lostAtCall = turns.heartbeats.length + 1
      }
      return originalHeartbeat(id, token, now)
    }
    const shared: Array<Message & { content: string }> = []
    const { runtime, gatewayCalls } = buildRuntime({
      turns: turns.repo,
      withTools: true,
      messages: shared,
      // 3 kör: két tool-hívás, majd szöveg — de a 2. körnél elveszik a tulajdonjog.
      modelToolCalls: [
        [{ id: 'c1', name: 'file_read', input: { path: 'a.txt' } }],
        [{ id: 'c2', name: 'file_read', input: { path: 'b.txt' } }],
        undefined,
      ],
    })
    const events: Array<{ type: string; message?: string }> = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)

    assert.equal(lostAtCall, 2, 'a tulajdonjog a 2. életjelnél veszett el')
    assert.equal(gatewayCalls.length, 1, 'a tulajdonvesztés után nincs új modellhívás')
    const errorEvent = events.find((e) => e.type === 'error')
    assert.ok(errorEvent && /tulajdonjoga elveszett/.test(errorEvent.message ?? ''))
    const row = turns.rowsById.get('turn-1')!
    assert.equal(row.status, 'failed')
    assert.equal(row.reason, 'watchdog', 'a régi tulajdonos nem írja felül a végállapotot')
    assert.equal(
      turns.finalized.filter((f) => f.id === 'turn-1').length,
      1,
      'csak a reclaim lezárása íródott',
    )
    assert.ok(!shared.some((m) => m.role === 'agent'), 'a régi tulajdonos nem ír lezáró üzenetet')
  })

  await test('#517: átmeneti launch-hiba a fogadás után nem zárja le a fordulót', async () => {
    const turns = fakeTurnRepository()
    const launcher: ChatTurnLauncher = {
      async launch() {
        throw new Error('upstream timeout')
      },
      async reconcile() {
        return { state: 'not_found' }
      },
    }
    const { runtime } = buildRuntime({ turns: turns.repo, launcher })
    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)
    assert.deepEqual(events.map((e) => e.type), ['turn', 'meta'])
    const row = turns.rowsById.get('turn-1')!
    assert.equal(row.status, 'queued')
    assert.ok(row.launchId)
    assert.equal(row.launchAttemptCount, 1)
    assert.equal(turns.finalized.length, 0)
  })

  await test('#519: Stop után a késői worker nem claimel és nem indít eszközt', async () => {
    const turns = fakeTurnRepository()
    const launcher: ChatTurnLauncher = {
      async launch() {
        return { launchId: 'launch-1', outcome: 'accepted' }
      },
      async reconcile() {
        return { state: 'not_found' }
      },
    }
    const shared: Array<Message & { content: string }> = []
    const requester = buildRuntime({ turns: turns.repo, launcher, messages: shared })
    for await (const _ of requester.runtime.sendMessageStream(turnParams())) void _

    const launchId = turns.rowsById.get('turn-1')!.launchId!
    assert.ok(await turns.repo.requestCancel('turn-1', 'user-1'))
    const worker = buildRuntime({ turns: turns.repo, messages: shared })
    await worker.runtime.runReservedTurn({ turnId: 'turn-1', launchId })

    assert.equal(turns.claimed.length, 0, 'Stop után nincs claim')
    assert.equal(worker.gatewayCalls.length, 0, 'késői worker nem indít modell-/eszközhívást')
    assert.equal(turns.rowsById.get('turn-1')!.status, 'cancelled')
  })

  if (failures > 0) {
    console.log(`\n${failures} forduló-rekord teszt bukott.`)
    process.exit(1)
  }
  console.log('\nChat forduló-rekord teszt kész.')
}

void main()
