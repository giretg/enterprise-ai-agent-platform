/**
 * A chat-runtime perzisztált forduló-rekordjának életciklusa
 * (chat-agent-turn-resilience-spec.md §4/§5.1, issue #59).
 *
 * DB és LLM nélkül fut: in-memory fake `AgentTurnRepository` mellett hajtja végig
 * a `sendMessageStream` valódi generátorát, és azt igazolja, hogy
 *  - minden fordulóra keletkezik rekord, a user-üzenet azonosítójával;
 *  - a forduló a végén TERMINÁLIS állapotra zárul (a keletkezett agent-üzenet
 *    azonosítójával), hibánál `failed`, a stream eldobásakor pedig szintén zárul;
 *  - a rekord hibája NEM változtatja meg a chat viselkedését (fail-soft).
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
        status: data.status ?? 'running',
        userMessageId: data.userMessageId ?? null,
        lockToken: data.lockToken ?? null,
        partialText: '',
        activities: [],
        // A séma szerint NOT NULL, `now()` alapértékkel — a foglalás
        // stale-ellenőrzése ezt olvassa, ezért a fake-ben is jelen kell lennie.
        heartbeatAt: new Date(),
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
    async releaseLock() {},
    async heartbeat(id, lockToken, now) {
      heartbeats.push({ id, lockToken })
      const row = rowsById.get(id)
      if (row) Object.assign(row, { heartbeatAt: now })
      return row ?? null
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
    async finalize(id, data) {
      finalized.push({ id, ...data })
      const row = rowsById.get(id)
      if (row) {
        Object.assign(row, {
          status: data.status,
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
    async findLatestTerminalByConversation() {
      return null
    },
  }
  /** Az aktív forduló életjelét `ms` ezredmásodperccel korábbra állítja. */
  const ageActiveTurn = (conversationId: string, ms: number) => {
    const row = activeByConversation.get(conversationId)
    if (row) Object.assign(row, { heartbeatAt: new Date(Date.now() - ms) })
  }
  return { repo, created, finalized, progress, ageActiveTurn, heartbeats }
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
}) {
  const messages: Array<Message & { content: string }> = []
  let seq = 0
  const conversations = {
    createConversation: async () => ({ id: 'conv-1' }),
    getConversation: async () => ({
      conversation: { id: 'conv-1', agentId: 'agent-1', projectKey: '__general__' },
      messages: messages.map((m) => ({ ...m, content: '', contentDeletedAt: null })),
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
    assert.equal(record.status, 'running')
    assert.ok(record.lockToken, 'az indító process azonnal claimeli a fordulót')
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



  await test('FAIL-SOFT: a rekord létrehozásának hibája nem változtatja meg a chatet', async () => {
    // Nem ütközés, hanem elérhetetlen rekord-tár: a chatnek ettől mennie kell.
    const turns = fakeTurnRepository({
      failOnCreate: new Error('agent_turns tábla elérhetetlen'),
    })
    const { runtime, messages } = buildRuntime({ turns: turns.repo })

    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)

    // A forduló ugyanúgy végigfut és perzisztálja az agent-választ.
    const doneEvent = events.find((e) => e.type === 'done')
    assert.ok(doneEvent, 'a chat a rekord nélkül is done-nal zárul')
    assert.ok(messages.some((m) => m.role === 'agent'))
    assert.equal(turns.finalized.length, 0, 'nincs mit lezárni, ha a rekord nem jött létre')
  })

  await test('a tool-loop körönként életjelet ír a forduló-rekordra', async () => {
    const turns = fakeTurnRepository()
    const { runtime } = buildRuntime({ turns: turns.repo, withTools: true })

    // végigfogyasztjuk a streamet, hogy a loop minden köre lefusson
    for await (const _event of runtime.sendMessageStream(turnParams())) void _event

    assert.ok(turns.heartbeats.length >= 1, 'legalább egy kör → legalább egy életjel')
    assert.equal(turns.heartbeats[0].id, 'turn-1')
    assert.equal(
      turns.heartbeats[0].lockToken,
      turns.created[0].lockToken,
      'az életjel a saját lock-tokenjével megy — csak a tulajdonos frissíthet',
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

  await test('bekötetlen forduló-tár esetén a chat változatlanul működik', async () => {
    const { runtime } = buildRuntime({})
    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)
    assert.ok(events.some((e) => e.type === 'done'))
  })

  if (failures > 0) {
    console.log(`\n${failures} forduló-rekord teszt bukott.`)
    process.exit(1)
  }
  console.log('\nChat forduló-rekord teszt kész.')
}

void main()
