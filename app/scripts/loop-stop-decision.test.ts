/**
 * chat-agent-turn-resilience-spec.md §7 / E7 — a tool-loop leállási
 * döntéshozójának determinisztikus tesztje.
 * Futtatás: npm run test:loop-stop
 *
 * Élő modell és DB NÉLKÜL: a Gateway és a ToolBroker fake-elve, az óra
 * injektálva — így a faliórai időkorlát, a tool-büdzsé és az előrehaladás-hiány
 * mindhárom ága időzítés-függetlenül igazolható.
 */
import assert from 'node:assert/strict'
import {
  LOOP_GUARD_DEFAULTS,
  describeLoopStop,
  evaluateLoopContinuation,
  resolveLoopGuardLimits,
  trackTurnProgress,
  type LoopGuardLimits,
} from '../src/domain/agent/loop-stop-decision'
import { runAgentToolLoop, type ChatPlatformToolName } from '../src/domain/agent/chat-tool-loop'
import type {
  GatewayMessage,
  GatewayToolCall,
  ModelConfig,
  ModelGateway,
  ToolDefinition,
} from '../src/domain/gateway/model-gateway'
import type {
  ToolBrokerInvokeInput,
  ToolBrokerInvokeResult,
  ToolBrokerService,
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
const ALLOWED_TOOLS: ChatPlatformToolName[] = ['kb_search']

const fakeToolCaps = {
  findConnectorsForAgent: async () => [],
} as unknown as ToolBrokerRepository

type GatewayCallArgs = {
  messages: GatewayMessage[]
  tools?: ToolDefinition[]
}

/** Minden körben ugyanazt a tool-hívást kéri, de VÁLTOZÓ argumentummal — így a
 *  meglévő, per-argumentum ismétlés-guard (REPEAT_LIMIT) nem fog rajta. */
function repeatingToolGateway(options: { assistantText?: string } = {}): ModelGateway {
  let call = 0
  return {
    call: async (args: GatewayCallArgs) => {
      // Az utolsó (tool nélküli) záró hívásban már nincs `tools` — sima szöveg.
      if (!args.tools) return { content: 'Összefoglaló a részeredményről.' }
      call += 1
      const toolCalls: GatewayToolCall[] = [
        { id: `call-${call}`, name: 'kb_search', input: { query: `kérdés ${call}` } },
      ]
      return { content: options.assistantText ?? '', toolCalls }
    },
  } as unknown as ModelGateway
}

function constantResultBroker(record: ToolBrokerInvokeInput[]): ToolBrokerService {
  return {
    invoke: async (input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> => {
      record.push(input)
      return {
        denied: false,
        result: { hits: [{ id: 'doc-1', title: 'Ugyanaz a találat' }] },
        resultMeta: {},
        latencyMs: 1,
      } as unknown as ToolBrokerInvokeResult
    },
  } as unknown as ToolBrokerService
}

function runLoop(params: {
  gateway: ModelGateway
  toolBroker: ToolBrokerService
  maxTurns?: number
  modelConfig?: ModelConfig
  now?: () => number
}) {
  return runAgentToolLoop({
    gateway: params.gateway,
    toolBroker: params.toolBroker,
    toolCaps: fakeToolCaps,
    agentId: 'agent-1',
    agentVersion: 1,
    context: { conversationId: 'conv-1' },
    mode: 'chat',
    messages: [{ role: 'user', content: 'Keresd ki a szabályzatot.' }],
    modelConfig: params.modelConfig ?? MODEL_CONFIG,
    allowedTools: ALLOWED_TOOLS,
    maxTurns: params.maxTurns ?? 10,
    ...(params.now ? { now: params.now } : {}),
  })
}

const LIMITS: LoopGuardLimits = {
  maxTurns: 20,
  maxWallClockMs: 180_000,
  maxToolCalls: 60,
  maxNoProgressTurns: 3,
}

async function main() {
  console.log('=== loop-leállási döntéshozó (spec §7 / E7) ===')

  // --- 1. A tiszta döntéshozó ---

  await check('folytatható, amíg egyik küszöb sincs elérve', () => {
    const decision = evaluateLoopContinuation({
      turn: 3,
      elapsedMs: 1_000,
      toolCallCount: 4,
      noProgressTurns: 1,
      cancelRequested: false,
      limits: LIMITS,
    })
    assert.equal(decision.continue, true)
  })

  await check('a megszakítás-kérés mindent megelőz', () => {
    const decision = evaluateLoopContinuation({
      turn: 99,
      elapsedMs: 10_000_000,
      toolCallCount: 999,
      noProgressTurns: 99,
      cancelRequested: true,
      limits: LIMITS,
    })
    assert.deepEqual(decision, { continue: false, reason: 'cancelled' })
  })

  await check('kör-limit → max_turns_exhausted', () => {
    const decision = evaluateLoopContinuation({
      turn: 20,
      elapsedMs: 0,
      toolCallCount: 0,
      noProgressTurns: 0,
      cancelRequested: false,
      limits: LIMITS,
    })
    assert.deepEqual(decision, { continue: false, reason: 'max_turns_exhausted' })
  })

  await check('faliórai korlát → wallclock_timeout', () => {
    const decision = evaluateLoopContinuation({
      turn: 0,
      elapsedMs: 180_000,
      toolCallCount: 0,
      noProgressTurns: 0,
      cancelRequested: false,
      limits: LIMITS,
    })
    assert.deepEqual(decision, { continue: false, reason: 'wallclock_timeout' })
  })

  await check('tool-büdzsé → tool_budget (a kör-limittől függetlenül)', () => {
    const decision = evaluateLoopContinuation({
      turn: 0,
      elapsedMs: 0,
      toolCallCount: 60,
      noProgressTurns: 0,
      cancelRequested: false,
      limits: LIMITS,
    })
    assert.deepEqual(decision, { continue: false, reason: 'tool_budget' })
  })

  await check('előrehaladás-hiány → no_progress', () => {
    const decision = evaluateLoopContinuation({
      turn: 0,
      elapsedMs: 0,
      toolCallCount: 0,
      noProgressTurns: 3,
      cancelRequested: false,
      limits: LIMITS,
    })
    assert.deepEqual(decision, { continue: false, reason: 'no_progress' })
  })

  // --- 2. Az előrehaladás-mérleg ---

  await check('új asszisztens-szöveg nullázza a zsákutca-számlálót', () => {
    assert.equal(
      trackTurnProgress(2, { hadAssistantText: true, toolResultCount: 2, newToolResultCount: 0 }),
      0,
    )
  })

  await check('új tool-eredmény nullázza a zsákutca-számlálót', () => {
    assert.equal(
      trackTurnProgress(2, { hadAssistantText: false, toolResultCount: 2, newToolResultCount: 1 }),
      0,
    )
  })

  await check('csak már látott eredmény → nő a számláló', () => {
    assert.equal(
      trackTurnProgress(1, { hadAssistantText: false, toolResultCount: 2, newToolResultCount: 0 }),
      2,
    )
  })

  await check('tool nélküli kör nem számít zsákutcának', () => {
    assert.equal(
      trackTurnProgress(1, { hadAssistantText: false, toolResultCount: 0, newToolResultCount: 0 }),
      1,
    )
  })

  // --- 3. Konfiguráció ---

  await check('alapértékek, ha nincs konfiguráció', () => {
    const limits = resolveLoopGuardLimits(undefined, 20)
    assert.equal(limits.maxWallClockMs, LOOP_GUARD_DEFAULTS.maxWallClockMs)
    assert.equal(limits.maxToolCalls, LOOP_GUARD_DEFAULTS.maxToolCalls)
    assert.equal(limits.maxNoProgressTurns, LOOP_GUARD_DEFAULTS.maxNoProgressTurns)
    assert.equal(limits.maxTurns, 20)
  })

  await check('modelConfig felülírja az alapértéket, clamp-elve', () => {
    const limits = resolveLoopGuardLimits(
      { maxToolWallClockMs: 30_000, maxToolCalls: 1, maxNoProgressTurns: 999 },
      20,
    )
    assert.equal(limits.maxWallClockMs, 30_000)
    assert.equal(limits.maxToolCalls, 5, 'a túl kicsi büdzsé a minimumra kerül')
    assert.equal(limits.maxNoProgressTurns, 20, 'a túl nagy érték a maximumra kerül')
  })

  await check('env változó a modelConfig hiányában érvényesül', () => {
    process.env.AGENT_LOOP_MAX_TOOL_CALLS = '25'
    try {
      assert.equal(resolveLoopGuardLimits({}, 20).maxToolCalls, 25)
      assert.equal(resolveLoopGuardLimits({ maxToolCalls: 40 }, 20).maxToolCalls, 40)
    } finally {
      delete process.env.AGENT_LOOP_MAX_TOOL_CALLS
    }
  })

  // --- 4. Loop-integráció: a három új feltétel ---

  await check('faliórai korlát leállítja a loopot (wallclock_timeout)', async () => {
    // Minden óraolvasás 40 mp-et léptet; a limit 60 mp → a 2. kör elején lejár.
    let clock = 0
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runLoop({
      gateway: repeatingToolGateway({ assistantText: 'Dolgozom rajta.' }),
      toolBroker: constantResultBroker(brokerCalls),
      modelConfig: { ...MODEL_CONFIG, maxToolWallClockMs: 60_000 } as ModelConfig,
      now: () => {
        clock += 40_000
        return clock
      },
    })
    assert.equal(result.status, 'exhausted')
    assert.equal(result.reason, 'wallclock_timeout')
    assert.match(result.content, /időkorlátot/)
    assert.ok(result.content.includes('Összefoglaló a részeredményről.'), 'a részválasz megmarad')
  })

  await check('tool-büdzsé leállítja a loopot (tool_budget)', async () => {
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runLoop({
      gateway: repeatingToolGateway({ assistantText: 'Még keresek.' }),
      toolBroker: constantResultBroker(brokerCalls),
      // A kör-limit bőven magasabb: bizonyítja, hogy a büdzsé önálló dimenzió.
      maxTurns: 40,
      modelConfig: { ...MODEL_CONFIG, maxToolCalls: 5 } as ModelConfig,
    })
    assert.equal(result.status, 'exhausted')
    assert.equal(result.reason, 'tool_budget')
    assert.equal(brokerCalls.length, 5, 'pontosan a büdzsé mennyi tool-hívás futott le')
    assert.equal(result.toolCallCount, 5)
    assert.match(result.content, /eszközhívási keret/)
  })

  await check('előrehaladás-hiány leállítja a loopot (no_progress)', async () => {
    // Nincs asszisztens-szöveg, és minden kör UGYANAZT az eredményt kapja vissza
    // — de VÁLTOZÓ argumentumokkal, tehát a REPEAT_LIMIT nem fog rajta.
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runLoop({
      gateway: repeatingToolGateway(),
      toolBroker: constantResultBroker(brokerCalls),
      maxTurns: 30,
    })
    assert.equal(result.status, 'exhausted')
    assert.equal(result.reason, 'no_progress')
    // 1 új eredményt hozó kör + 3 zsákutca-kör után áll le.
    assert.equal(brokerCalls.length, 4)
    assert.match(result.content, /nem haladtam előre/)
    const queries = brokerCalls.map((c) => (c.args as { query?: string }).query)
    assert.equal(new Set(queries).size, 4, 'az argumentumok körönként változtak')
  })

  await check('az ismétlés-guard változatlan, és utána a no_progress zárja le', async () => {
    // Azonos argumentumok → a REPEAT_LIMIT után minden hívás kimarad; a csupa
    // kihagyott kör is zsákutca, így végül a no_progress állítja le a loopot.
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const gateway = {
      call: async (args: GatewayCallArgs) => {
        if (!args.tools) return { content: 'Nem jutottam tovább.' }
        return {
          content: '',
          toolCalls: [{ id: 'same', name: 'kb_search', input: { query: 'ugyanaz' } }],
        }
      },
    } as unknown as ModelGateway

    const result = await runLoop({
      gateway,
      toolBroker: constantResultBroker(brokerCalls),
      maxTurns: 30,
    })
    assert.equal(brokerCalls.length, 3, 'a REPEAT_LIMIT változatlanul 3 hívás után fog')
    assert.equal(result.status, 'exhausted')
    assert.equal(result.reason, 'no_progress')
  })

  // --- 5. A meglévő viselkedés változatlan ---

  await check('kör-limit kimerülése továbbra is max_turns_exhausted, extra jelölés nélkül', async () => {
    const brokerCalls: ToolBrokerInvokeInput[] = []
    // Körönként ÚJ eredmény → nincs no_progress; kis maxTurns → a kör-limit fogy el.
    let seq = 0
    const gateway = {
      call: async (args: GatewayCallArgs) => {
        if (!args.tools) return { content: 'Ennyit sikerült.' }
        seq += 1
        return {
          content: '',
          toolCalls: [{ id: `c-${seq}`, name: 'kb_search', input: { query: `q${seq}` } }],
        }
      },
    } as unknown as ModelGateway
    const broker = {
      invoke: async (input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> => {
        brokerCalls.push(input)
        return {
          denied: false,
          result: { hits: [{ id: `doc-${brokerCalls.length}` }] },
          resultMeta: {},
          latencyMs: 1,
        } as unknown as ToolBrokerInvokeResult
      },
    } as unknown as ToolBrokerService

    const result = await runLoop({ gateway, toolBroker: broker, maxTurns: 3 })
    assert.equal(result.status, 'exhausted')
    assert.equal(result.reason, 'max_turns_exhausted')
    assert.equal(brokerCalls.length, 3)
    assert.equal(result.content, 'Ennyit sikerült.', 'a kör-limit ága szó szerint változatlan')
  })

  await check('a max_turns ágnak nincs hétköznapi jelölése, a három újnak van', () => {
    assert.equal(describeLoopStop('max_turns_exhausted', LIMITS), null)
    assert.equal(describeLoopStop('cancelled', LIMITS), null)
    for (const reason of ['wallclock_timeout', 'tool_budget', 'no_progress'] as const) {
      const notice = describeLoopStop(reason, LIMITS)
      assert.ok(notice && notice.length > 40, `${reason}: van önmagyarázó szöveg`)
    }
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
