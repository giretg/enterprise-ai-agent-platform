/**
 * Determinisztikus teszt az egységes agent tool loophoz és a /process routinghoz.
 * Futtatás: npm run test:tool-loop
 *
 * Élő modell / DB NÉLKÜL: a Gateway-t és a ToolBrokert befecskendezett fake-ekkel
 * helyettesítjük, így a loop kontextus-kezelése (chat vs. task) és a routing
 * tisztán igazolható.
 */
import assert from 'node:assert/strict'
import { runAgentToolLoop, recoverOpenAiToolCallsFromText } from '../src/domain/agent/chat-tool-loop'
import { resolveTicketProcessRoute } from '../src/lib/ticket-process-route'
import type { ModelGateway, ModelConfig, GatewayToolCall } from '../src/domain/gateway/model-gateway'
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

type FakeResponse = { content?: string; toolCalls?: GatewayToolCall[] }

function fakeGateway(responses: FakeResponse[], record: GatewayCallArgs[]): ModelGateway {
  let i = 0
  return {
    call: async (args: GatewayCallArgs) => {
      record.push(args)
      const r = responses[Math.min(i, responses.length - 1)]
      i++
      return {
        content: r.content ?? '',
        ...(r.toolCalls?.length ? { toolCalls: r.toolCalls } : {}),
        usage: { promptTokens: 1, completionTokens: 1 },
      }
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

function fakeToolBrokerResult(
  record: ToolBrokerInvokeInput[],
  result: Record<string, unknown>,
): ToolBrokerService {
  return {
    invoke: async (input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> => {
      record.push(input)
      return {
        denied: false,
        result,
        resultMeta: {},
        latencyMs: 1,
      } as unknown as ToolBrokerInvokeResult
    },
  } as unknown as ToolBrokerService
}

const fakeToolCaps = {
  findConnectorsForAgent: async () => [],
} as unknown as ToolBrokerRepository

async function main() {
  console.log('=== agent tool loop + routing teszt ===')

  await check('task mód: ticketId kontextus megy a gateway-nek és a brokernek', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          { toolCalls: [{ id: 'c1', name: 'file_read', input: { path: 'a.txt' } }] },
          { content: 'Kész a feladat.' },
        ],
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
      gateway: fakeGateway([{ content: 'Szia, miben segíthetek?' }], gwCalls),
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
      gateway: fakeGateway(
        [
          { toolCalls: [{ id: 'c1', name: 'gmail_search', input: { query: 'is:unread' } }] },
          { content: 'Megvan.' },
        ],
        gwCalls,
      ),
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

  await check('vékony fallback: beágyazott {"tool":...} JSON tool_calls nélkül is hív', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          // natív toolCalls NINCS — csak szövegbe ágyazott JSON
          { content: '{"tool":"file_read","args":{"path":"b.txt"}}' },
          { content: 'Kész.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { ticketId: 'ticket-2' },
      mode: 'task',
      messages: [{ role: 'user', content: 'olvasd be b.txt' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['file_read'],
    })

    assert.equal(result.content, 'Kész.')
    assert.equal(result.toolCallCount, 1)
    assert.equal(brokerCalls.length, 1)
    assert.equal(brokerCalls[0].tool, 'file_read')
  })

  await check('nagy tool eredmény: teljes tartalom archiválva, kontextusban csak előnézet', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const largeRows = Array.from({ length: 400 }, (_, i) => ({
      id: i + 1,
      name: `Ügyfél ${i + 1}`,
      revenue: (i + 1) * 1000,
      note: 'hosszú crm sor '.repeat(8),
    }))
    const archived: Array<{ path: string; content: string }> = []

    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          { toolCalls: [{ id: 'crm-call', name: 'http_api_get', input: { path: '/customers' } }] },
          { content: 'A teljes CRM eredményt feldolgoztam.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBrokerResult(brokerCalls, { customers: largeRows }),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-1' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'milyen ügyfelek vannak?' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['http_api_get'],
      archiveLargeToolResult: async ({ content }) => {
        archived.push({ path: '.tool-results/01-http_api_get-crm-call.json', content })
        return { path: '.tool-results/01-http_api_get-crm-call.json', bytes: Buffer.byteLength(content) }
      },
    })

    assert.equal(result.content, 'A teljes CRM eredményt feldolgoztam.')
    assert.equal(archived.length, 1)
    assert.match(archived[0].content, /Ügyfél 400/)
    const toolMessage = gwCalls[1].messages.find((m) => m.role === 'tool')
    assert.ok(toolMessage)
    assert.match(toolMessage.content, /A teljes eredmény elmentve/)
    assert.match(toolMessage.content, /tool_result_read/)
    assert.ok(!toolMessage.content.includes('Ügyfél 400'))
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

  await check('OpenAI delta-leak kimentése: töredékelt arguments összeáll', () => {
    // A valós qwen3/OpenRouter leak (conversation 1a6c23ac) pontos alakja.
    const leak =
      '[{"id":"call_8ac786bc2aff4cceb0ab88","type":"function","function":{"name":"http_api_get"},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"{\\""},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"path\\": \\"/banks/6"},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"742eee"},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"8b89"},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"ccc2f8"},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"deae2f1"},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"/crm\\"}"},"index":0}]'
    const calls = recoverOpenAiToolCallsFromText(leak)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].tool, 'http_api_get')
    assert.deepEqual(calls[0].args, { path: '/banks/6742eee8b89ccc2f8deae2f1/crm' })
  })

  await check('OpenAI delta-leak: több párhuzamos tool index külön hívás', () => {
    const leak =
      '[{"id":"a","type":"function","function":{"name":"xlsx_create","arguments":"{\\"path\\":\\"r.xlsx\\"}"},"index":0}]' +
      '[{"id":"b","type":"function","function":{"name":"http_api_get","arguments":"{\\"path\\":\\"/banks\\"}"},"index":1}]'
    const calls = recoverOpenAiToolCallsFromText(leak)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].tool, 'xlsx_create')
    assert.deepEqual(calls[1].args, { path: '/banks' })
  })

  await check('Sima szöveg nem ad hamis kimentést', () => {
    assert.equal(recoverOpenAiToolCallsFromText('Kész az Excel fájl, itt a tartalma.').length, 0)
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
