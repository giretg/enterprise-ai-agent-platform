/**
 * `agent_ask` határidő (B) + a delegáció-keret előkapuja (A).
 *
 * Üzleti háttér: a delegált agent futása a HÍVÓ fordulójának faliórájából
 * fogy. Mért eset (2026-07-31): négy kérdés 136 másodpercet vitt el egy 180
 * másodperces keretből, két forduló emiatt futott ki az időből, és a
 * felhasználónak háromszor kellett „folytasd"-ot írnia ahhoz, hogy egyáltalán
 * választ kapjon. Az itteni két fék ezt előzi meg:
 *  - A: ha nincs elég keret, a kérdés el sem indul;
 *  - B: ha menet közben lejár, a várást elengedjük — a ticket megmarad, a
 *    válasz a következő fordulóban jelenik meg.
 *
 * Futtatás: npx tsx scripts/agent-ask-deadline.test.ts
 */
import assert from 'node:assert/strict'
import {
  DELEGATION_DEADLINE,
  raceDelegationDeadline,
} from '../src/lib/delegation-deadline'
import { runAgentToolLoop } from '../src/domain/agent/chat-tool-loop'
import type {
  ModelGateway,
  ModelConfig,
  GatewayMessage,
  GatewayToolCall,
  ToolDefinition,
} from '../src/domain/gateway/model-gateway'
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
  messages: GatewayMessage[]
  modelConfig: ModelConfig
  tools?: ToolDefinition[]
}

function fakeGateway(
  responses: Array<{ content?: string; toolCalls?: GatewayToolCall[] }>,
  record: GatewayCallArgs[],
): ModelGateway {
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

const fakeToolCaps = { findConnectorsForAgent: async () => [] } as unknown as ToolBrokerRepository

function recordingBroker(record: ToolBrokerInvokeInput[]): ToolBrokerService {
  return {
    invoke: async (input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> => {
      record.push(input)
      return {
        denied: false,
        result: { ok: true, completed: true, answer: 'kész' },
        resultMeta: {},
        latencyMs: 1,
      } as unknown as ToolBrokerInvokeResult
    },
  } as unknown as ToolBrokerService
}

async function main() {
  console.log('=== agent_ask határidő + keret-kapu ===')

  // ── B: raceDelegationDeadline ────────────────────────────────────────────
  await check('határidő nélkül végigvárja a delegációt', async () => {
    const result = await raceDelegationDeadline(Promise.resolve('kész'), undefined)
    assert.equal(result, 'kész')
  })

  await check('a határidő előtt beérkező válasz nyer', async () => {
    const result = await raceDelegationDeadline(
      new Promise((resolve) => setTimeout(() => resolve('kész'), 5)),
      Date.now() + 5_000,
    )
    assert.equal(result, 'kész')
  })

  await check('a határidő lejárta elengedi a várást', async () => {
    const started = Date.now()
    const slow = new Promise((resolve) => setTimeout(() => resolve('késő'), 5_000))
    const result = await raceDelegationDeadline(slow, Date.now() + 20)
    assert.equal(result, DELEGATION_DEADLINE)
    assert.ok(Date.now() - started < 1_000, 'nem várta ki a lassú futást')
  })

  await check('már lejárt keretnél azonnal határidőt ad', async () => {
    const result = await raceDelegationDeadline(Promise.resolve('kész'), Date.now() - 1)
    assert.equal(result, DELEGATION_DEADLINE)
  })

  await check('az elengedett futás hibája nem borítja fel a hívót', async () => {
    const failing = new Promise((_, reject) => setTimeout(() => reject(new Error('bumm')), 15))
    const result = await raceDelegationDeadline(failing, Date.now() + 5)
    assert.equal(result, DELEGATION_DEADLINE)
    // A hívó elnyeli az elengedett ág hibáját; itt csak azt igazoljuk, hogy a
    // versenyeztető maga nem dob. Egy tick várás, hogy a rejection be tudjon futni.
    failing.catch(() => {})
    await new Promise((r) => setTimeout(r, 30))
  })

  // ── A: keret-előkapu a tool-loopban ──────────────────────────────────────
  await check('kevés maradék keretnél az agent_ask el sem indul', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    // 100 s keret, amiből 71 s eltelt → 29 s marad, ami a 60 s-os
    // delegáció-küszöb alatt van, de a forduló maga még nem futott ki az időből.
    let clockCalls = 0
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [
              {
                id: 'ask-1',
                name: 'agent_ask',
                input: { targetAgentId: 'agent-2', question: 'Mi a riport formátuma?' },
              },
            ],
          },
          { content: 'A meglévőkből válaszolok.' },
        ],
        gwCalls,
      ),
      toolBroker: recordingBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-deadline' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'kérdezd meg Ákost' }],
      modelConfig: { ...MODEL_CONFIG, maxToolWallClockMs: 100_000 } as ModelConfig,
      allowedTools: ['agent_ask'],
      // Az első hívás a forduló kezdete (startedAt), utána állandó 71 s.
      now: () => {
        clockCalls += 1
        return clockCalls === 1 ? 0 : 71_000
      },
    })

    assert.equal(result.content, 'A meglévőkből válaszolok.')
    assert.equal(brokerCalls.length, 0, 'a delegáció nem indulhat el')
    const toolMessage = gwCalls[1].messages.find((m) => m.role === 'tool')
    assert.ok(toolMessage)
    assert.match(toolMessage.content, /\[LIMIT\]/)
    assert.match(toolMessage.content, /Ne kérdezz most agentet/)
  })

  await check('bőséges keretnél az agent_ask lefut és határidőt kap', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [
              {
                id: 'ask-1',
                name: 'agent_ask',
                input: { targetAgentId: 'agent-2', question: 'Mi a riport formátuma?' },
              },
            ],
          },
          { content: 'Megvan.' },
        ],
        gwCalls,
      ),
      toolBroker: recordingBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-deadline-ok' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'kérdezd meg Ákost' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['agent_ask'],
    })

    assert.equal(result.content, 'Megvan.')
    assert.equal(brokerCalls.length, 1, 'a delegáció elindul')
    assert.equal(brokerCalls[0].tool, 'agent_ask')
    assert.equal(
      typeof brokerCalls[0].deadlineAt,
      'number',
      'a hívó maradék kerete átmegy a brokerhez',
    )
    assert.ok(
      brokerCalls[0].deadlineAt! > Date.now(),
      'a határidő a jövőben van',
    )
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt bukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
