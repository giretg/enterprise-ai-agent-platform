/**
 * Determinisztikus teszt az egységes agent tool loophoz és a /process routinghoz.
 * Futtatás: npm run test:tool-loop
 *
 * Élő modell / DB NÉLKÜL: a Gateway-t és a ToolBrokert befecskendezett fake-ekkel
 * helyettesítjük, így a loop kontextus-kezelése (chat vs. task) és a routing
 * tisztán igazolható.
 */
import assert from 'node:assert/strict'
import { runAgentToolLoop } from '../src/domain/agent/chat-tool-loop'
import { resolveTicketProcessRoute } from '../src/lib/ticket-process-route'
import type { ModelGateway, ModelConfig } from '../src/domain/gateway/model-gateway'
import type {
  ToolBrokerService,
  ToolBrokerInvokeInput,
  ToolBrokerInvokeResult,
} from '../src/domain/tool-broker/tool-broker-service'
import type { ToolBrokerRepository } from '../src/repositories/interfaces'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✅ ${name}`))
    .catch((e) => {
      failures++
      console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

const MODEL_CONFIG: ModelConfig = { provider: 'chatgpt-oauth', model: 'stub' }

type GatewayCallArgs = {
  agentId: string
  ticketId?: string
  conversationId?: string
  messages: Array<{ role: string; content: string }>
  modelConfig: ModelConfig
}

function fakeGateway(responses: string[], record: GatewayCallArgs[]): ModelGateway {
  let i = 0
  return {
    call: async (args: GatewayCallArgs) => {
      record.push(args)
      const content = responses[Math.min(i, responses.length - 1)]
      i++
      return { content, usage: { promptTokens: 1, completionTokens: 1 } }
    },
  } as unknown as ModelGateway
}

function fakeToolBroker(record: ToolBrokerInvokeInput[]): ToolBrokerService {
  return {
    invoke: async (input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> => {
      record.push(input)
      return {
        denied: false,
        result: { ok: true },
        resultMeta: {},
        latencyMs: 1,
      } as unknown as ToolBrokerInvokeResult
    },
  } as unknown as ToolBrokerService
}

const fakeToolCaps = {} as unknown as ToolBrokerRepository

async function main() {
  console.log('=== agent tool loop + routing teszt ===')

  await check('task mód: ticketId kontextus megy a gateway-nek és a brokernek', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        ['{"tool":"file_read","args":{"path":"a.txt"}}', 'Kész a feladat.'],
        gwCalls,
      ),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 3,
      context: { ticketId: 'ticket-1' },
      mode: 'task',
      messages: [{ role: 'user', content: 'olvasd be a.txt' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['file_read'],
    })

    assert.equal(result.content, 'Kész a feladat.')
    assert.equal(result.toolCallCount, 1)
    assert.equal(brokerCalls.length, 1)
    assert.equal(brokerCalls[0].ticketId, 'ticket-1')
    assert.equal(brokerCalls[0].conversationId, undefined)
    assert.equal(brokerCalls[0].tool, 'file_read')
    // a gateway is ticketId kontextust kapott (guardrail / audit célból)
    assert.equal(gwCalls[0].ticketId, 'ticket-1')
    assert.equal(gwCalls[0].conversationId, undefined)
  })

  await check('chat mód: conversationId + actingUserId propagál', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway(['Szia, miben segíthetek?'], gwCalls),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-1' },
      mode: 'chat',
      actingUserId: 'user-1',
      messages: [{ role: 'user', content: 'szia' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: [],
    })

    assert.equal(result.content, 'Szia, miben segíthetek?')
    assert.equal(result.toolCallCount, 0)
    assert.equal(brokerCalls.length, 0)
    assert.equal(gwCalls[0].conversationId, 'conv-1')
    assert.equal(gwCalls[0].ticketId, undefined)
  })

  await check('chat mód: az actingUserId átmegy a tool invoke-ba', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    await runAgentToolLoop({
      gateway: fakeGateway(['{"tool":"gmail_search","args":{"query":"is:unread"}}', 'Megvan.'], gwCalls),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-1' },
      mode: 'chat',
      actingUserId: 'user-1',
      messages: [{ role: 'user', content: 'leveleim' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['gmail_search'],
    })

    assert.equal(brokerCalls.length, 1)
    assert.equal(brokerCalls[0].conversationId, 'conv-1')
    assert.equal(brokerCalls[0].actingUserId, 'user-1')
  })

  await check('routing: hiányzó / üres / wiki source → wiki', () => {
    assert.equal(resolveTicketProcessRoute(undefined), 'wiki')
    assert.equal(resolveTicketProcessRoute(null), 'wiki')
    assert.equal(resolveTicketProcessRoute({}), 'wiki')
    assert.equal(resolveTicketProcessRoute({ source: 'wiki' }), 'wiki')
    assert.equal(resolveTicketProcessRoute({ source: '' }), 'wiki')
    assert.equal(resolveTicketProcessRoute([{ source: 'agent_chat' }]), 'wiki')
  })

  await check('routing: agent_chat / agent_tool / agent_ask → general', () => {
    assert.equal(resolveTicketProcessRoute({ source: 'agent_chat' }), 'general')
    assert.equal(resolveTicketProcessRoute({ source: 'agent_tool' }), 'general')
    assert.equal(resolveTicketProcessRoute({ source: 'agent_ask' }), 'general')
    assert.equal(resolveTicketProcessRoute({ source: 'delegation' }), 'general')
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
