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
    recipe: null,
    resources: [],
    apiKeyPreview: null,
    behaviorProfileLink: null,
  }
}

function buildRuntime(row: Agent) {
  const calls = { createConversation: 0, createTicket: 0 }
  const agents = {
    findByIdWithDetails: async () => agentDetails(row),
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

async function main() {
  console.log('=== AgentChat tenant-boundary teszt ===')

  await test('sendMessage cross-tenant agentet opak Agent not found hibával tilt', async () => {
    const { runtime, calls } = buildRuntime(agent({ tenantId: 'tenant-B' }))
    await assert.rejects(
      () =>
        runtime.sendMessage({
          agentId: 'agent-B',
          content: 'Szia',
          createdById: 'user-A',
          tenantId: 'tenant-A',
        }),
      /Agent not found/,
    )
    assert.equal(calls.createConversation, 0)
    assert.equal(calls.createTicket, 0)
  })

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

  if (failures > 0) {
    console.log(`\n${failures} AgentChat tenant-boundary teszt bukott.`)
    process.exit(1)
  }
  console.log('\nAgentChat tenant-boundary teszt kész.')
}

void main()
