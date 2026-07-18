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
import type { ModelGateway } from '../src/domain/gateway/model-gateway'
import type { ToolBrokerService } from '../src/domain/tool-broker/tool-broker-service'
import type { WorkspaceStorage } from '../src/domain/file-editor/workspace-storage'

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

/** Megvárja a leválasztott futás hatását (a futás nem a fogyasztóhoz kötött). */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('időtúllépés a futás bevárásakor')
    await new Promise<void>((r) => setTimeout(r, 5))
  }
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
    allowSensitiveExternalModel: false,
    selfEvolutionProfile: null,
    memoryId: 'memory-1',
    createdAt: new Date('2026-07-18T08:00:00Z'),
    retiredAt: null,
    suspendedReason: null,
  } as Agent
}

/** A `create`/`finalize` hívásokat rögzítő, memóriában élő forduló-tár. */
function fakeTurnRepository(options: { failOnCreate?: Error; active?: AgentTurn } = {}) {
  const created: Array<Parameters<AgentTurnRepository['create']>[0]> = []
  const finalized: Array<{ id: string } & FinalizeAgentTurnInput> = []
  const heartbeats: Array<{ id: string; lockToken: string }> = []
  const repo: AgentTurnRepository = {
    async create(data) {
      if (options.failOnCreate) throw options.failOnCreate
      created.push(data)
      return { id: `turn-${created.length}`, status: data.status ?? 'running' } as AgentTurn
    },
    async findById() {
      return null
    },
    async findActiveByConversation() {
      return options.active ?? null
    },
    async acquireLock() {
      return null
    },
    async releaseLock() {},
    async heartbeat(id, lockToken) {
      heartbeats.push({ id, lockToken })
      return null
    },
    async finalize(id, data) {
      finalized.push({ id, ...data })
      return null
    },
    async findStale() {
      return []
    },
  }
  return { repo, created, finalized, heartbeats }
}

function buildRuntime(options: {
  turns?: AgentTurnRepository
  replyChunks?: string[]
  streamError?: Error
  /** Engedélyezett capability → a forduló a tool-loop ágon fut. */
  withTools?: boolean
}) {
  const messages: Message[] = []
  let seq = 0
  const conversations = {
    createConversation: async () => ({ id: 'conv-1' }),
    getConversation: async () => ({
      conversation: { id: 'conv-1', agentId: 'agent-1', projectKey: '__general__' },
      messages: messages.map((m) => ({ ...m, content: '', contentDeletedAt: null })),
    }),
    appendMessage: async (params: {
      role: string
      onPersisted?: (message: Message) => void
    }) => {
      seq += 1
      const message = {
        id: `${params.role}-msg-${seq}`,
        conversationId: 'conv-1',
        seq,
        role: params.role,
        createdAt: new Date(Date.now() + seq * 1000),
      } as unknown as Message
      messages.push(message)
      params.onPersisted?.(message)
      return message
    },
  } as unknown as ConversationService

  const gateway = {
    async *callStream() {
      if (options.streamError) throw options.streamError
      for (const chunk of options.replyChunks ?? ['Szia! ', 'Miben segíthetek?']) {
        yield chunk
      }
    },
    async call() {
      if (options.streamError) throw options.streamError
      return {
        content: (options.replyChunks ?? ['Szia! ', 'Miben segíthetek?']).join(''),
        usage: { promptTokens: 1, completionTokens: 1 },
      }
    },
  } as unknown as ModelGateway

  const toolCaps = {
    findCapabilitiesForAgent: async () =>
      options.withTools ? [{ allowed: true, toolName: 'file_read' }] : [],
    findCapability: async () => null,
    findConnectorsForAgent: async () => [],
    findDocumentsForConnector: async () => [],
    listToolCallsForConversation: async () => [],
  } as unknown as ToolBrokerRepository

  const runtime = new AgentChatRuntime(
    {
      findByIdWithDetails: async () => ({
        agent: agentRow(),
        memoryContent: null,
        memoryVersion: null,
        recipe: null,
        resources: [],
        apiKeyPreview: null,
        behaviorProfileLink: null,
      }),
      findMany: async () => [],
    } as unknown as AgentRepository,
    { findById: async () => null } as unknown as DocumentRepository,
    {} as TicketRepository,
    gateway,
    conversations,
    {} as ToolBrokerService,
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
  )
  return { runtime, messages }
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
    const { runtime } = buildRuntime({
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

  await test('ütköző lock: nem indul második futtatás', async () => {
    const turns = fakeTurnRepository({
      failOnCreate: new ActiveAgentTurnExistsError('conv-1'),
    })
    const { runtime, messages } = buildRuntime({ turns: turns.repo })

    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)

    assert.ok(
      !events.some((e) => e.type === 'done'),
      'a forduló el sem indul, ha a tulajdonjogot nem sikerült megszerezni',
    )
    assert.ok(events.some((e) => e.type === 'error'))
    assert.ok(
      !messages.some((m) => m.role === 'agent'),
      'nem keletkezik versengő agent-válasz',
    )
    assert.equal(turns.finalized.length, 0, 'nincs mit lezárni, ha a rekord nem jött létre')
  })

  await test('FAIL-SOFT: egyéb DB-hiba esetén a chat rekord nélkül fut tovább', async () => {
    const turns = fakeTurnRepository({ failOnCreate: new Error('DB unavailable') })
    const { runtime, messages } = buildRuntime({ turns: turns.repo })

    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)

    // A forduló-rekord megfigyelhetőségi réteg: a hibája nem buktathatja a chatet.
    const doneEvent = events.find((e) => e.type === 'done')
    assert.ok(doneEvent, 'a chat a rekord nélkül is done-nal zárul')
    assert.ok(messages.some((m) => m.role === 'agent'))
    assert.equal(turns.finalized.length, 0, 'nincs mit lezárni, ha a rekord nem jött létre')
  })

  await test('a tool-loop körönként életjelet ír a forduló-rekordra', async () => {
    const turns = fakeTurnRepository()
    const { runtime } = buildRuntime({ turns: turns.repo, withTools: true })

    for await (const _event of runtime.sendMessageStream(turnParams())) {
      // végigfogyasztjuk
    }

    assert.ok(turns.heartbeats.length >= 1, 'legalább egy kör → legalább egy életjel')
    assert.equal(turns.heartbeats[0].id, 'turn-1')
    assert.equal(
      turns.heartbeats[0].lockToken,
      turns.created[0].lockToken,
      'az életjel a saját lock-tokenjével megy — csak a tulajdonos frissíthet',
    )
  })

  await test('D11: a nem-streamelő út UGYANAZON a lezáró ponton ír', async () => {
    const turns = fakeTurnRepository()
    const { runtime, messages } = buildRuntime({ turns: turns.repo })

    const result = await runtime.sendMessage(turnParams())

    assert.equal(result.reply, 'Szia! Miben segíthetek?')
    assert.equal(turns.created.length, 1, 'a nem-streamelő út is nyit forduló-rekordot')
    assert.equal(turns.finalized.length, 1)
    assert.equal(turns.finalized[0].status, 'completed')
    assert.equal(
      turns.finalized[0].assistantMessageId,
      result.messageId,
      'a rekord a visszaadott agent-üzenetre mutat',
    )
    assert.equal(messages.filter((m) => m.role === 'agent').length, 1)
  })

  await test('elhalt forduló: az indítás visszaveszi a heartbeat nélkül maradt rekordot', async () => {
    const stale = {
      id: 'turn-stale',
      status: 'running',
      heartbeatAt: new Date(Date.now() - 10 * 60_000),
    } as AgentTurn
    const turns = fakeTurnRepository({ active: stale })
    const { runtime } = buildRuntime({ turns: turns.repo })

    const events = []
    for await (const event of runtime.sendMessageStream(turnParams())) events.push(event)

    // A crash-elt futás nem zárhatja be örökre a beszélgetést.
    assert.ok(
      turns.finalized.some((f) => f.id === 'turn-stale' && f.reason === 'watchdog'),
      'a halott forduló lezárul',
    )
    assert.ok(events.some((e) => e.type === 'done'), 'az új forduló elindul és lefut')
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
