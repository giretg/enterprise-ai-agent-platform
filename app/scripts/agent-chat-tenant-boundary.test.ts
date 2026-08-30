/**
 * AgentChat tenant-boundary regresszió.
 *
 * DB és LLM nélkül ellenőrzi, hogy a chat runtime cross-tenant agent ID esetén
 * még mellékhatás (conversation létrehozás / ticket létrehozás) előtt leáll.
 *
 * Futtatás: npm run test:agent-chat-tenant-boundary
 */
import assert from 'node:assert/strict'
import type { Agent } from '@prisma/client'
import { AgentChatRuntime } from '../src/domain/agent/agent-chat-runtime'
import type {
  AgentRepository,
  AuditRepository,
  DocumentRepository,
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

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-B',
    tenantId: 'tenant-B',
    name: 'Tenant B agent',
    roleInstruction: 'Segíts.',
    behaviorProfile: 'Pontos válaszok.',
    behaviorProfileOverlay: null,
    personaNickname: null,
    personaGreeting: null,
    personaTrait: null,
    avatarUrl: null,
    modelConfig: { provider: 'stub', model: 'stub-model' },
    status: 'active',
    currentVersion: 1,
    currentRoleInstructionVersion: 1,
    currentBehaviorProfileVersion: 1,
    currentBehaviorProfileId: null,
    role: 'worker',
    selfEvolutionProfile: null,
    memoryId: 'memory-1',
    createdAt: new Date('2026-07-09T08:00:00Z'),
    retiredAt: null,
    suspendedReason: null,
    ...overrides,
  } as Agent
}

function agentDetails(row: Agent) {
  return {
    agent: row,
    memoryContent: null,
    memoryVersion: null,
  }
}

function buildRuntime(row: Agent) {
  const calls = { createConversation: 0, createTicket: 0 }
  const agents = {
    findByIdForRuntime: async () => agentDetails(row),
  } as unknown as AgentRepository
  const conversations = {
    createConversation: async () => {
      calls.createConversation += 1
      throw new Error('createConversation should not be called')
    },
    getConversation: async () => {
      throw new Error('getConversation should not be called')
    },
    appendMessage: async () => {
      throw new Error('appendMessage should not be called')
    },
  } as unknown as ConversationService
  const tickets = {
    create: async () => {
      calls.createTicket += 1
      throw new Error('ticket create should not be called')
    },
  } as unknown as TicketRepository
  const runtime = new AgentChatRuntime(
    agents,
    { findById: async () => null } as unknown as DocumentRepository,
    tickets,
    {} as ModelGateway,
    conversations,
    {} as ToolBrokerService,
    { listToolCallsForConversation: async () => [] } as unknown as ToolBrokerRepository,
    {} as WorkspaceStorage,
    { append: async () => ({ id: 'audit-1' }) } as unknown as AuditRepository,
  )
  return { runtime, calls }
}

/** APG-08 known-value szótár: csak a beszélgetés tulajdonosa kaphat plaintext needle-t. */
function buildPrivacyMarkerRuntime(params: {
  conversation: {
    id: string
    agentId: string
    tenantId: string
    createdById: string
  }
  knownValues: Array<{ needle: string; surrogate: string; fromStructuredField: boolean }>
}) {
  let loadCalls = 0
  const conversations = {
    getConversation: async (conversationId: string, tenantId?: string | null) => {
      if (conversationId !== params.conversation.id) throw new Error('Conversation not found')
      if (tenantId !== undefined && tenantId !== params.conversation.tenantId) {
        throw new Error('Conversation not found')
      }
      return { conversation: params.conversation, messages: [] }
    },
  } as unknown as ConversationService
  const surrogateEngine = {
    loadKnownValueReplacements: async () => {
      loadCalls += 1
      return params.knownValues
    },
  }
  const runtime = new AgentChatRuntime(
    { findByIdForRuntime: async () => null } as unknown as AgentRepository,
    { findById: async () => null } as unknown as DocumentRepository,
    {} as unknown as TicketRepository,
    {} as ModelGateway,
    conversations,
    {} as ToolBrokerService,
    { listToolCallsForConversation: async () => [] } as unknown as ToolBrokerRepository,
    {} as WorkspaceStorage,
    { append: async () => ({ id: 'audit-1' }) } as unknown as AuditRepository,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    surrogateEngine as never,
    undefined,
    async () => ({
      mode: 'enforce' as const,
      policy: {
        categories: {},
        custom: {},
        patternSetVersion: 1,
        legacyToggleApplied: false,
      } as never,
    }),
  )
  return { runtime, getLoadCalls: () => loadCalls }
}

async function main() {
  console.log('=== AgentChat tenant-boundary teszt ===')


  await test('sendMessageStream cross-tenant agentnél error eseménnyel áll le', async () => {
    const { runtime, calls } = buildRuntime(agent({ tenantId: 'tenant-B' }))
    const events = []
    for await (const event of runtime.sendMessageStream({
      agentId: 'agent-B',
      content: 'Szia',
      createdById: 'user-A',
      tenantId: 'tenant-A',
    })) {
      events.push(event)
    }
    assert.deepEqual(events, [{ type: 'error', message: 'Agent not found' }])
    assert.equal(calls.createConversation, 0)
    assert.equal(calls.createTicket, 0)
  })

  await test('createTaskTicket cross-tenant agentet ticket létrehozás előtt tilt', async () => {
    const { runtime, calls } = buildRuntime(agent({ tenantId: 'tenant-B' }))
    await assert.rejects(
      () =>
        runtime.createTaskTicket({
          agentId: 'agent-B',
          content: 'Készíts riportot',
          createdById: 'user-A',
          tenantId: 'tenant-A',
        }),
      /Agent not found/,
    )
    assert.equal(calls.createTicket, 0)
  })

  const conv = {
    id: 'conv-1',
    agentId: 'agent-A',
    tenantId: 'tenant-A',
    createdById: 'owner-A',
  }
  const secretValues = [
    { needle: 'SPAR Titkos Kft.', surrogate: '[[COMPANY_1]]', fromStructuredField: true },
  ]

  await test('getPrivacyMarkerContext: tulajdonos megkapja a known-value szótárat', async () => {
    const { runtime, getLoadCalls } = buildPrivacyMarkerRuntime({
      conversation: conv,
      knownValues: secretValues,
    })
    const ctx = await runtime.getPrivacyMarkerContext({
      agentId: 'agent-A',
      tenantId: 'tenant-A',
      conversationId: 'conv-1',
      requesterUserId: 'owner-A',
    })
    assert.ok(ctx)
    assert.deepEqual(ctx!.knownValues, secretValues)
    assert.equal(getLoadCalls(), 1)
  })

  await test('getPrivacyMarkerContext: idegen tenant-tag NEM kap vault plaintext szótárat (APG-08)', async () => {
    const { runtime, getLoadCalls } = buildPrivacyMarkerRuntime({
      conversation: conv,
      knownValues: secretValues,
    })
    const ctx = await runtime.getPrivacyMarkerContext({
      agentId: 'agent-A',
      tenantId: 'tenant-A',
      conversationId: 'conv-1',
      requesterUserId: 'other-user-B',
    })
    assert.ok(ctx)
    assert.deepEqual(ctx!.knownValues, [])
    assert.equal(getLoadCalls(), 0, 'loadKnownValueReplacements ne fusson idegen kérőre')
  })

  await test('getPrivacyMarkerContext: requester nélkül üres szótár', async () => {
    const { runtime, getLoadCalls } = buildPrivacyMarkerRuntime({
      conversation: conv,
      knownValues: secretValues,
    })
    const ctx = await runtime.getPrivacyMarkerContext({
      agentId: 'agent-A',
      tenantId: 'tenant-A',
      conversationId: 'conv-1',
    })
    assert.ok(ctx)
    assert.deepEqual(ctx!.knownValues, [])
    assert.equal(getLoadCalls(), 0)
  })

  if (failures > 0) {
    console.log(`\n${failures} AgentChat tenant-boundary teszt bukott.`)
    process.exit(1)
  }
  console.log('\nAgentChat tenant-boundary teszt kész.')
}

void main()
