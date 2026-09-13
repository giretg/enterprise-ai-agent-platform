/**
 * Chatből létrejövő agent-feladat azonnal indítási kísérletet kap — a dispatcher
 * worker LISTEN/cron-jától függetlenül, de a System-oldali vészfék betartásával.
 * A skill-promóció és a chat „Feladat” gomb ugyanazt a varratot használja.
 *
 * Futtatás: npm run test:chat-task-immediate-dispatch
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Agent } from '@prisma/client'
import { AgentChatRuntime } from '../src/domain/agent/agent-chat-runtime'
import type { AgentAccessService } from '../src/domain/agent-access/agent-access-service'
import type { ConversationService } from '../src/domain/conversation/conversation-service'
import type { ModelGateway } from '../src/domain/gateway/model-gateway'
import type { ToolBrokerService } from '../src/domain/tool-broker/tool-broker-service'
import type { WorkspaceStorage } from '../src/domain/file-editor/workspace-storage'
import type {
  AgentRepository,
  AuditRepository,
  DocumentRepository,
  TicketRepository,
  ToolBrokerRepository,
} from '../src/repositories/interfaces'

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

function agentRow(): Agent {
  return {
    id: 'agent-1',
    tenantId: 'tenant-1',
    name: 'Réka',
    roleInstruction: 'Segíts.',
    behaviorProfile: 'Pontos válaszok.',
    behaviorProfileOverlay: null,
    personaNickname: 'Réka',
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
    createdAt: new Date('2026-09-11T08:00:00Z'),
    retiredAt: null,
    suspendedReason: null,
  } as unknown as Agent
}

function buildRuntime(options?: {
  dispatchTicket?: (ticketId: string) => Promise<unknown>
  executeAfter?: Date | null
}) {
  const dispatched: string[] = []
  const ticket = {
    id: 'ticket-chat-1',
    conversationId: 'conv-1',
    state: 'ready',
    executeAfter: options?.executeAfter ?? null,
  }
  const agents = {
    findByIdForRuntime: async () => ({
      agent: agentRow(),
      memoryContent: null,
      memoryVersion: null,
    }),
  } as unknown as AgentRepository
  const conversations = {
    createConversation: async () => ({ id: 'conv-1' }),
    getConversation: async () => ({
      conversation: { agentId: 'agent-1', projectKey: '__general__' },
    }),
    postTaskCard: async () => ({ id: 'msg-1' }),
  } as unknown as ConversationService
  const tickets = {
    create: async () => ticket,
  } as unknown as TicketRepository
  const dispatchTicket =
    options?.dispatchTicket ??
    (async (ticketId: string) => {
      dispatched.push(ticketId)
      return { ticketId, status: 'started' }
    })

  const runtime = new AgentChatRuntime(
    agents,
    { findById: async () => null, findByIds: async () => [] } as unknown as DocumentRepository,
    tickets,
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
    { assertCanAccessAgent: async () => ({ allowed: true }) } as unknown as AgentAccessService,
    undefined,
    undefined,
    undefined,
    undefined,
    dispatchTicket,
  )
  return { runtime, dispatched, ticket }
}

async function main() {
  console.log('=== Chat-feladat azonnali indítás ===')

  await test('createTaskTicket azonnal dispatcheli a ready ticketet', async () => {
    const { runtime, dispatched } = buildRuntime()
    const created = await runtime.createTaskTicket({
      agentId: 'agent-1',
      content: 'a Vino Trade -ről',
      createdById: 'user-1',
      tenantId: 'tenant-1',
    })
    assert.equal(created.id, 'ticket-chat-1')
    assert.deepEqual(dispatched, ['ticket-chat-1'])
  })

  await test('a dispatch hibája nem buktatja el a ticket felvételét', async () => {
    const { runtime } = buildRuntime({
      dispatchTicket: async () => {
        throw new Error('dispatcher down')
      },
    })
    const previous = console.error
    console.error = () => {}
    try {
      const created = await runtime.createTaskTicket({
        agentId: 'agent-1',
        content: 'a Vino Trade -ről',
        createdById: 'user-1',
        tenantId: 'tenant-1',
      })
      assert.equal(created.id, 'ticket-chat-1')
    } finally {
      console.error = previous
    }
  })

  await test('jövőbeli executeAfter esetén nem indul azonnal', async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000)
    const { runtime, dispatched } = buildRuntime({ executeAfter: later })
    await runtime.createTaskTicket({
      agentId: 'agent-1',
      content: 'később',
      createdById: 'user-1',
      tenantId: 'tenant-1',
      executeAfter: later,
    })
    assert.deepEqual(dispatched, [])
  })

  await test('skill-promóció ugyanazt a varratot hívja, a dispatcher vészfék megkerülése nélkül', () => {
    const runtimeSrc = readFileSync(
      resolve(import.meta.dirname, '../src/domain/agent/agent-chat-runtime.ts'),
      'utf8',
    )
    const promotionFn = runtimeSrc.slice(
      runtimeSrc.indexOf('private async trySkillTaskPromotion'),
      runtimeSrc.indexOf('async createTaskTicket'),
    )
    const createTaskFn = runtimeSrc.slice(
      runtimeSrc.indexOf('async createTaskTicket'),
      runtimeSrc.indexOf('private async tryStartChatTriggeredProcess'),
    )
    assert.match(promotionFn, /this\.triggerImmediateDispatch\(ticket/)
    assert.match(createTaskFn, /this\.triggerImmediateDispatch\(ticket/)

    const composition = readFileSync(
      resolve(import.meta.dirname, '../src/domain/index.ts'),
      'utf8',
    )
    const chatCtor = composition.slice(composition.indexOf('const agentChatRuntime = new AgentChatRuntime'))
    const chatCtorBody = chatCtor.slice(0, chatCtor.indexOf('const channelTurnService'))
    assert.match(chatCtorBody, /dispatcherService\.dispatchTicket\(ticketId\)/)
    assert.doesNotMatch(chatCtorBody, /bypassEnabledCheck:\s*true/)
  })

  if (failures > 0) {
    console.log(`\n${failures} chat-feladat azonnali indítás teszt bukott.`)
    process.exit(1)
  }
  console.log('\nChat-feladat azonnali indítás teszt kész.')
}

void main()
