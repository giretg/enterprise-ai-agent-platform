/**
 * issue #97 — Következmény-kapu + egységes becsomagolás a chat-tool-loopban.
 * Futtatás: npm run test:consequence-gate
 *
 * Élő modell / DB nélkül: a Gateway-t és a ToolBrokert befecskendezett fake-ekkel
 * helyettesítjük (az agent-tool-loop.test.ts mintájára). A fake broker a valódi
 * bizalmi regisztert használja (resolveTrustClass), így a taint/gate viselkedés
 * a tényleges besorolással igazolható.
 *
 * Forgatókönyvek (Testing Decisions):
 *  (a) tiszta forduló → mellékhatás lefut;
 *  (b) external_untrusted eredmény után mellékhatás → jóváhagyást kér, NEM fut le;
 *  (c) external_untrusted után olvasó hívás → átmegy;
 *  (d) egyetlen külső forrás több eredmény között is „tainted"-dé teszi a fordulót;
 *  (e) az external_untrusted eredmény becsomagolva (figyelmeztetés + blokk) megy a modellnek.
 */
import assert from 'node:assert/strict'
import { runAgentToolLoop } from '../src/domain/agent/chat-tool-loop'
import { resolveTrustClass } from '../src/domain/tool-broker/tool-trust-registry'
import { EXTERNAL_DATA_WARNING, EXTERNAL_DATA_OPEN } from '../src/domain/tool-broker/tool-result-envelope'
import type { ModelGateway, ModelConfig, GatewayMessage, GatewayToolCall, ToolDefinition } from '../src/domain/gateway/model-gateway'
import type { ToolBrokerService, ToolBrokerInvokeInput } from '../src/domain/tool-broker/tool-broker-service'
import type { ToolBrokerRepository } from '../src/repositories/interfaces'

let failures = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : String(e)}`)
  }
}

const MODEL_CONFIG: ModelConfig = { provider: 'chatgpt-oauth', model: 'stub' }

type GatewayCallArgs = {
  messages: GatewayMessage[]
  tools?: ToolDefinition[]
}
type FakeResponse = { content?: string; toolCalls?: GatewayToolCall[] }

function fakeGateway(responses: FakeResponse[], record: GatewayCallArgs[]): ModelGateway {
  let i = 0
  return {
    call: async (args: GatewayCallArgs) => {
      record.push(args)
      const r = responses[Math.min(i, responses.length - 1)]
      i++
      return { content: r.content ?? '', ...(r.toolCalls?.length ? { toolCalls: r.toolCalls } : {}), usage: { promptTokens: 1, completionTokens: 1 } }
    },
  } as unknown as ModelGateway
}

/** A valódi bizalmi regisztert használó fake broker; naplózza az invoke/gate hívásokat. */
function fakeToolBroker() {
  const invoked: ToolBrokerInvokeInput[] = []
  const gated: ToolBrokerInvokeInput[] = []
  const broker = {
    invoke: async (input: ToolBrokerInvokeInput) => {
      invoked.push(input)
      return {
        denied: false,
        trust: resolveTrustClass(input.tool),
        result: { ok: true },
        resultMeta: {},
        latencyMs: 1,
      }
    },
    recordConsequenceGateBlock: async (input: ToolBrokerInvokeInput) => {
      gated.push(input)
    },
  } as unknown as ToolBrokerService
  return { broker, invoked, gated }
}

const fakeToolCaps = { findConnectorsForAgent: async () => [] } as unknown as ToolBrokerRepository

function toolNames(inputs: ToolBrokerInvokeInput[]): string[] {
  return inputs.map((i) => i.tool)
}

async function runLoop(responses: FakeResponse[], allowedTools: string[], gw: GatewayCallArgs[]) {
  const { broker, invoked, gated } = fakeToolBroker()
  const result = await runAgentToolLoop({
    gateway: fakeGateway(responses, gw),
    toolBroker: broker,
    toolCaps: fakeToolCaps,
    agentId: 'agent-1',
    agentVersion: 1,
    context: { conversationId: 'conv-1' },
    mode: 'chat',
    actingUserId: 'user-1',
    messages: [{ role: 'user', content: 'feladat' }],
    modelConfig: MODEL_CONFIG,
    allowedTools: allowedTools as never,
  })
  return { result, invoked, gated }
}

async function main() {
  console.log('=== következmény-kapu + becsomagolás (issue #97) ===')

  await test('(a) tiszta forduló: a mellékhatásos hívás lefut', async () => {
    const gw: GatewayCallArgs[] = []
    const { invoked, gated } = await runLoop(
      [
        { toolCalls: [{ id: 'c1', name: 'file_write', input: { path: 'a.txt', content: 'x' } }] },
        { content: 'kész' },
      ],
      ['file_write'],
      gw,
    )
    assert.deepEqual(toolNames(invoked), ['file_write'], 'a mellékhatás lefutott')
    assert.equal(gated.length, 0, 'nincs kapu tiszta fordulóban')
  })

  await test('(b) külső eredmény UTÁN mellékhatás: jóváhagyást kér, NEM fut le', async () => {
    const gw: GatewayCallArgs[] = []
    const { invoked, gated } = await runLoop(
      [
        { toolCalls: [{ id: 'c1', name: 'gmail_search', input: { query: 'is:unread' } }] },
        { toolCalls: [{ id: 'c2', name: 'gmail_send', input: { to: 'x@y.hu' } }] },
        { content: 'kész' },
      ],
      ['gmail_search', 'gmail_send'],
      gw,
    )
    assert.deepEqual(toolNames(invoked), ['gmail_search'], 'a gmail_send NEM jutott el a broker.invoke-ig')
    assert.deepEqual(toolNames(gated), ['gmail_send'], 'a kapu blokkolta és jóváhagyást kért')
    // A modell a következő fordulóban közérthető jóváhagyás-kérést kapott indoklással.
    const toolMsg = gw[gw.length - 1].messages.find((m) => m.role === 'tool' && m.toolCallId === 'c2')
    assert.ok(toolMsg, 'van tool-üzenet a blokkolt hívásra')
    assert.match(toolMsg!.content ?? '', /JÓVÁHAGYÁS SZÜKSÉGES/)
    assert.match(toolMsg!.content ?? '', /külső/)
  })

  await test('(c) külső eredmény után OLVASÓ hívás: átmegy (a kapu nem blokkolja)', async () => {
    const gw: GatewayCallArgs[] = []
    const { invoked, gated } = await runLoop(
      [
        { toolCalls: [{ id: 'c1', name: 'http_api_get', input: { path: '/x' } }] },
        { toolCalls: [{ id: 'c2', name: 'file_read', input: { path: 'a.txt' } }] },
        { content: 'kész' },
      ],
      ['http_api_get', 'file_read'],
      gw,
    )
    assert.deepEqual(toolNames(invoked), ['http_api_get', 'file_read'], 'az olvasó hívás átment')
    assert.equal(gated.length, 0, 'olvasó hívást a kapu nem blokkol')
  })

  await test('(d) egyetlen külső forrás több eredmény között is tainteltté teszi a fordulót', async () => {
    const gw: GatewayCallArgs[] = []
    // Egy batch: belső → külső → mellékhatásos. A külső egyetlen forrás elég a tainthez.
    const { invoked, gated } = await runLoop(
      [
        {
          toolCalls: [
            { id: 'c1', name: 'kb_search', input: { query: 'policy' } },
            { id: 'c2', name: 'gmail_get_message', input: { id: 'm1' } },
            { id: 'c3', name: 'ticket_create', input: { title: 'teendő' } },
          ],
        },
        { content: 'kész' },
      ],
      ['kb_search', 'gmail_get_message', 'ticket_create'],
      gw,
    )
    assert.deepEqual(toolNames(invoked), ['kb_search', 'gmail_get_message'], 'a mellékhatásos ticket_create blokkolva')
    assert.deepEqual(toolNames(gated), ['ticket_create'])
  })

  await test('(e) az external_untrusted eredmény becsomagolva megy a modellnek', async () => {
    const gw: GatewayCallArgs[] = []
    await runLoop(
      [
        { toolCalls: [{ id: 'c1', name: 'web_search', input: { query: 'hír' } }] },
        { content: 'kész' },
      ],
      ['web_search'],
      gw,
    )
    // A web_search eredményét a második gateway-hívás előzményében találjuk.
    const toolMsg = gw[1].messages.find((m) => m.role === 'tool' && m.toolCallId === 'c1')
    assert.ok(toolMsg, 'van tool-üzenet a web_search eredményre')
    assert.ok(toolMsg!.content?.includes(EXTERNAL_DATA_WARNING), 'a figyelmeztető mondat ott van')
    assert.ok(toolMsg!.content?.includes(EXTERNAL_DATA_OPEN), 'a határolt blokk ott van')
  })

  await test('belső/trusted eredmény NINCS becsomagolva (no-op)', async () => {
    const gw: GatewayCallArgs[] = []
    await runLoop(
      [
        { toolCalls: [{ id: 'c1', name: 'kb_search', input: { query: 'policy' } }] },
        { content: 'kész' },
      ],
      ['kb_search'],
      gw,
    )
    const toolMsg = gw[1].messages.find((m) => m.role === 'tool' && m.toolCallId === 'c1')
    assert.ok(toolMsg, 'van tool-üzenet a kb_search eredményre')
    assert.ok(!toolMsg!.content?.includes(EXTERNAL_DATA_WARNING), 'belső eredményen nincs figyelmeztetés')
    assert.ok(!toolMsg!.content?.includes(EXTERNAL_DATA_OPEN), 'belső eredményen nincs blokk-határoló')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
