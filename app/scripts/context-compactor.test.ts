/**
 * Kontextus-tömörítés (context-compactor) determinisztikus tesztje.
 * Futtatás: npm run test:context-compactor
 *
 * Élő modell és DB NÉLKÜL: a tiszta tömörítő függvényt közvetlenül, a
 * bekötést pedig fake gateway/broker mellett futtatott tool-loopon át igazoljuk.
 * A lényegi állítás üzleti: egy hosszú, sok eszközhívásos futás promptja NEM
 * nőhet korlátlanul, és a kiszervezett eredmény vissza kell hogy legyen olvasható.
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_CONTEXT_COMPACTION_LIMITS,
  EVICTED_TOOL_RESULT_MARKER,
  compactToolResultHistory,
  resolveContextCompactionLimits,
  type ContextCompactionLimits,
} from '../src/domain/agent/context-compactor'
import { runAgentToolLoop, type ChatPlatformToolName } from '../src/domain/agent/chat-tool-loop'
import type {
  GatewayMessage,
  GatewayToolCall,
  ModelConfig,
  ModelGateway,
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
const fakeToolCaps = { findConnectorsForAgent: async () => [] } as unknown as ToolBrokerRepository

const TEST_LIMITS: ContextCompactionLimits = {
  keepRecentToolResults: 2,
  maxToolResultChars: 5_000,
  minEvictableChars: 500,
}

const COMPACTION_OPTIONS = {
  limits: TEST_LIMITS,
  readableBack: true,
  readMaxLimit: 40_000,
  pathFor: ({ toolName, toolCallId }: { toolName: string; toolCallId: string }) =>
    `.tool-results/${toolName}-${toolCallId}.json`,
}

/** `count` tool-eredmény, mindegyik `chars` hosszú, egy lezárt körből. */
function historyWithToolResults(count: number, chars: number): GatewayMessage[] {
  const messages: GatewayMessage[] = [{ role: 'user', content: 'kérdés' }]
  for (let i = 0; i < count; i += 1) {
    messages.push({
      role: 'assistant',
      toolCalls: [{ id: `call-${i}`, name: 'http_api_get', input: {} }],
    })
    messages.push({
      role: 'tool',
      toolCallId: `call-${i}`,
      toolName: 'http_api_get',
      content: `sor-${i} `.repeat(Math.ceil(chars / 7)).slice(0, chars),
    })
  }
  // Lezáró asszisztens-üzenet: minden tool-eredmény egy KORÁBBI körből való.
  messages.push({ role: 'assistant', toolCalls: [{ id: 'call-last', name: 'kb_search', input: {} }] })
  messages.push({ role: 'tool', toolCallId: 'call-last', toolName: 'kb_search', content: 'friss' })
  return messages
}

function toolContents(messages: GatewayMessage[]): string[] {
  return messages.filter((m) => m.role === 'tool').map((m) => (m.role === 'tool' ? m.content : ''))
}

async function main() {
  console.log('\n🧪 Kontextus-tömörítés\n')

  await check('keret alatt nem nyúl hozzá az előzményhez', () => {
    const messages = historyWithToolResults(3, 800)
    const before = toolContents(messages)
    const result = compactToolResultHistory(messages, COMPACTION_OPTIONS)
    assert.equal(result.evicted.length, 0)
    assert.equal(result.freedChars, 0)
    assert.deepEqual(toolContents(messages), before)
  })

  await check('keret felett a LEGRÉGEBBI eredmények kerülnek ki, a friss kettő marad', () => {
    const messages = historyWithToolResults(6, 2_000)
    const result = compactToolResultHistory(messages, COMPACTION_OPTIONS)

    assert.ok(result.evicted.length > 0, 'kellett volna kiszervezni')
    assert.ok(result.freedChars > 0)
    const contents = toolContents(messages)
    // A `keepRecentToolResults` legfrissebb (a záró kb_search-öt is beleértve) érintetlen.
    assert.ok(!contents[contents.length - 1].startsWith(EVICTED_TOOL_RESULT_MARKER))
    assert.ok(!contents[contents.length - 2].startsWith(EVICTED_TOOL_RESULT_MARKER))
    // A legrégebbi viszont ki van szervezve.
    assert.ok(contents[0].startsWith(EVICTED_TOOL_RESULT_MARKER))
    assert.match(contents[0], /tool_result_read/)
    assert.match(contents[0], /\.tool-results\/http_api_get-call-0\.json/)
  })

  await check('a kiszervezés a TELJES tartalmat visszaadja a hívónak (nem vész el)', () => {
    const messages = historyWithToolResults(6, 2_000)
    const originals = toolContents(messages)
    const result = compactToolResultHistory(messages, COMPACTION_OPTIONS)
    for (const item of result.evicted) {
      assert.ok(originals.includes(item.content), 'a visszaadott tartalom az eredeti')
      assert.ok(item.content.length >= TEST_LIMITS.minEvictableChars)
    }
  })

  await check('az üzenetszerkezet sértetlen: darabszám, sorrend, tool-hívás párosítás', () => {
    const messages = historyWithToolResults(6, 2_000)
    const roles = messages.map((m) => m.role)
    const ids = messages.filter((m) => m.role === 'tool').map((m) => (m.role === 'tool' ? m.toolCallId : ''))
    compactToolResultHistory(messages, COMPACTION_OPTIONS)
    assert.deepEqual(messages.map((m) => m.role), roles, 'egyetlen üzenet sem tűnhet el')
    assert.deepEqual(
      messages.filter((m) => m.role === 'tool').map((m) => (m.role === 'tool' ? m.toolCallId : '')),
      ids,
      'a toolCallId párosítás nem sérülhet (az API különben elutasítaná a kérést)',
    )
  })

  await check('a jelen kör még ki nem értékelt eredményeit sosem szervezi ki', () => {
    const messages: GatewayMessage[] = [
      { role: 'user', content: 'kérdés' },
      { role: 'assistant', toolCalls: [{ id: 'a', name: 'http_api_get', input: {} }] },
      { role: 'tool', toolCallId: 'a', toolName: 'http_api_get', content: 'x'.repeat(9_000) },
      // Jelen kör: az asszisztens most kérte, a modell még NEM látta az eredményt.
      { role: 'assistant', toolCalls: [{ id: 'b', name: 'http_api_get', input: {} }] },
      { role: 'tool', toolCallId: 'b', toolName: 'http_api_get', content: 'y'.repeat(9_000) },
      { role: 'tool', toolCallId: 'c', toolName: 'http_api_get', content: 'z'.repeat(9_000) },
    ]
    const result = compactToolResultHistory(messages, {
      ...COMPACTION_OPTIONS,
      limits: { ...TEST_LIMITS, keepRecentToolResults: 1 },
    })
    const contents = toolContents(messages)
    assert.equal(result.evicted.length, 1, 'csak a lezárt kör eredménye eshet ki')
    assert.ok(contents[0].startsWith(EVICTED_TOOL_RESULT_MARKER))
    assert.equal(contents[1], 'y'.repeat(9_000), 'a jelen kör kötege érintetlen')
    assert.equal(contents[2], 'z'.repeat(9_000))
  })

  await check('a már kiszervezett eredményt nem szervezi ki újra', () => {
    const messages = historyWithToolResults(8, 2_000)
    const first = compactToolResultHistory(messages, COMPACTION_OPTIONS)
    const second = compactToolResultHistory(messages, COMPACTION_OPTIONS)
    assert.ok(first.evicted.length > 0)
    assert.equal(second.evicted.length, 0, 'a stub nem szervezhető ki mégegyszer')
  })

  await check('visszaolvasás nélküli futásban a stub nem ígér tool_result_read-et', () => {
    const messages = historyWithToolResults(6, 2_000)
    compactToolResultHistory(messages, { ...COMPACTION_OPTIONS, readableBack: false })
    const stub = toolContents(messages).find((c) => c.startsWith(EVICTED_TOOL_RESULT_MARKER))
    assert.ok(stub)
    assert.ok(!stub.includes('tool_result_read'))
    assert.match(stub, /futtasd újra az eszközt/)
  })

  await check('env felülbírálás érvényesül, érvénytelen érték az alapértékre esik vissza', () => {
    const limits = resolveContextCompactionLimits({
      AGENT_CONTEXT_KEEP_RECENT_TOOL_RESULTS: '2',
      AGENT_CONTEXT_MAX_TOOL_RESULT_CHARS: '20000',
      AGENT_CONTEXT_MIN_EVICTABLE_CHARS: 'nem-szám',
    } as unknown as NodeJS.ProcessEnv)
    assert.equal(limits.keepRecentToolResults, 2)
    assert.equal(limits.maxToolResultChars, 20_000)
    assert.equal(limits.minEvictableChars, DEFAULT_CONTEXT_COMPACTION_LIMITS.minEvictableChars)
  })

  console.log('\n🧪 Bekötés a tool-loopba\n')

  /**
   * Egy hosszú, sok eszközhívásos futás: körönként egy nagy lekérdezés, majd a
   * végén a modell VISSZAOLVASSA a legelső, addigra kiszervezett eredményt.
   * `limits: null` = gyakorlatilag kikapcsolt tömörítés (kontrollfutás).
   */
  async function runLongScenario(
    limits: ContextCompactionLimits,
    options: { archiveSucceeds?: boolean } = {},
  ) {
    const TURNS = 8
    const promptSizes: number[] = []
    const archived = new Map<string, string>()
    const brokerCalls: ToolBrokerInvokeInput[] = []
    let readBack: string | null = null
    let evictedStubSeen = false
    let call = 0

    const gateway = {
      call: async (args: { messages: GatewayMessage[] }) => {
        evictedStubSeen ||= args.messages.some(
          (message) =>
            message.role === 'tool' && message.content.startsWith(EVICTED_TOOL_RESULT_MARKER),
        )
        promptSizes.push(
          args.messages.reduce((sum, m) => sum + ((m as { content?: string }).content?.length ?? 0), 0),
        )
        call += 1
        if (call <= TURNS) {
          return {
            content: '',
            toolCalls: [
              { id: `crm-${call}`, name: 'http_api_get', input: { path: `/rows?page=${call}` } },
            ] as GatewayToolCall[],
            usage: { promptTokens: 1, completionTokens: 1 },
          }
        }
        if (call === TURNS + 1 && archived.size > 0) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'read-1',
                name: 'tool_result_read',
                input: { path: [...archived.keys()][0], offset: 0, limit: 200 },
              },
            ] as GatewayToolCall[],
            usage: { promptTokens: 1, completionTokens: 1 },
          }
        }
        // A visszaolvasás eredménye az utolsó tool-üzenetben érkezik vissza.
        const lastTool = [...args.messages].reverse().find((m) => m.role === 'tool')
        if (lastTool?.role === 'tool' && lastTool.toolName === 'tool_result_read') {
          readBack = lastTool.content
        }
        return { content: 'Kész a feldolgozás.', usage: { promptTokens: 1, completionTokens: 1 } }
      },
    } as unknown as ModelGateway

    // Körönként MÁS oldal jön vissza — különben az előrehaladás-figyelő
    // (helyesen) zsákutcaként állítaná le a futást, és nem a tömörítést mérnénk.
    const toolBroker = {
      invoke: async (input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> => {
        brokerCalls.push(input)
        const page = brokerCalls.length
        return {
          denied: false,
          result: {
            rows: Array.from({ length: 300 }, (_, i) => ({
              id: page * 1000 + i,
              name: `Tulajdonos ${page}-${i}`,
              share: '1/300',
              note: 'ingatlan-nyilvántartási megjegyzés '.repeat(4),
            })),
          },
          resultMeta: {},
          latencyMs: 1,
        } as unknown as ToolBrokerInvokeResult
      },
    } as unknown as ToolBrokerService

    const result = await runAgentToolLoop({
      gateway,
      toolBroker,
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-compaction' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'egyeztesd a tulajdonosokat' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['http_api_get'] as ChatPlatformToolName[],
      maxTurns: TURNS + 3,
      contextCompaction: limits,
      archiveLargeToolResult: async ({ content, path, toolName, callId }) => {
        const target = path ?? `.tool-results/${toolName}-${callId}.json`
        if (options.archiveSucceeds === false) return null
        archived.set(target, content)
        return { path: target, bytes: Buffer.byteLength(content) }
      },
    })

    return {
      result,
      promptSizes,
      archived,
      readBack,
      evictedStubSeen,
      totalPromptChars: promptSizes.reduce((a, b) => a + b, 0),
    }
  }

  await check('hosszú futás: a tömörítés érdemben csökkenti a prompt-forgalmat', async () => {
    // Kontroll: akkora keret, hogy sosem lép működésbe.
    const off = await runLongScenario({
      keepRecentToolResults: 4,
      maxToolResultChars: 100_000_000,
      minEvictableChars: 1_000,
    })
    const on = await runLongScenario({
      keepRecentToolResults: 2,
      maxToolResultChars: 30_000,
      minEvictableChars: 500,
    })

    assert.equal(off.result.content, 'Kész a feldolgozás.')
    assert.equal(on.result.content, 'Kész a feldolgozás.', 'a tömörítés nem törheti meg a futást')
    assert.ok(
      on.totalPromptChars < off.totalPromptChars * 0.75,
      `legalább negyedével kisebb prompt-forgalom (tömörítve=${on.totalPromptChars}, tömörítés nélkül=${off.totalPromptChars})`,
    )
    assert.ok(
      Math.max(...on.promptSizes) < Math.max(...off.promptSizes),
      'a csúcs-promptméret is alacsonyabb',
    )
    console.log(
      `     ↳ prompt-forgalom: ${off.totalPromptChars} → ${on.totalPromptChars} karakter ` +
        `(csúcs ${Math.max(...off.promptSizes)} → ${Math.max(...on.promptSizes)})`,
    )
  })

  await check('a kiszervezett tartalom a tool_result_read-del visszaolvasható', async () => {
    const on = await runLongScenario({
      keepRecentToolResults: 2,
      maxToolResultChars: 30_000,
      minEvictableChars: 500,
    })
    assert.ok(on.archived.size > 0, 'a kiszervezett eredmény archívumba került')
    assert.ok(on.readBack, 'a modell visszakapta a kiszervezett tartalmat')
    const payload = JSON.parse(on.readBack) as { content: string; totalChars: number }
    assert.ok(payload.totalChars > 0)
    assert.match(payload.content, /Tulajdonos 1-/, 'az ELSŐ kör eredménye olvasható vissza')
  })

  await check('archiválási hiba után nem marad hamis elmentési stub a promptban', async () => {
    const failed = await runLongScenario(
      {
        keepRecentToolResults: 2,
        maxToolResultChars: 30_000,
        minEvictableChars: 500,
      },
      { archiveSucceeds: false },
    )
    assert.equal(failed.archived.size, 0, 'a fake archiváló nem mentett tartalmat')
    assert.equal(
      failed.evictedStubSeen,
      false,
      'a modell nem kaphat olyan stubot, amely nem létező workspace-fájlra hivatkozik',
    )
  })

  console.log(failures === 0 ? '\n✅ Minden teszt zöld\n' : `\n❌ ${failures} teszt bukott\n`)
  if (failures > 0) process.exit(1)
}

void main()
