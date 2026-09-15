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
  TOOL_RESULT_READ_TOOL_NAME,
  compactToolResultHistory,
  extractReadBackSourcePath,
  readBackPerTurnBudget,
  resolveContextCompactionLimits,
  type ContextCompactionLimits,
} from '../src/domain/agent/context-compactor'
import {
  SOURCE_INGEST_DEFAULTS,
  isRedundantSourceIngest,
  resolveSourceIngestLimits,
  sourceIngestBudget,
  toolCallSourceKey,
} from '../src/domain/agent/loop-stop-decision'
import {
  TOOL_LOOP_CHECKPOINT_PATH,
  runAgentToolLoop,
  type ChatPlatformToolName,
} from '../src/domain/agent/chat-tool-loop'
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
import { fakeToolBrokerSuccess } from './fixtures/tool-broker-result'

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
const brokerReturning = (output: unknown) =>
  ({
    invoke: async (input: ToolBrokerInvokeInput) => fakeToolBrokerSuccess(input.tool, output),
  }) as unknown as ToolBrokerService

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

  console.log('\n🧪 Visszaolvasás-fékek (tömörítés ↔ tool_result_read körforgás)\n')

  await check('a visszaolvasott szelet a FORRÁS archívumára hivatkozva kerül ki', () => {
    // A tool_result_read eredménye származtatott adat: a tartalom a forrás
    // archívumban már megvan. Ha új útvonalat kapna, archívumok archívuma
    // keletkezne — pont ez hizlalta a mért futást.
    const source = '.tool-results/http_api_get-call-0.json'
    const readBackPayload = JSON.stringify({
      path: source,
      toolName: 'http_api_get',
      offset: 0,
      limit: 40_000,
      content: 'x'.repeat(4_000),
    })
    const messages: GatewayMessage[] = [
      { role: 'user', content: 'kérdés' },
      { role: 'assistant', toolCalls: [{ id: 'r1', name: TOOL_RESULT_READ_TOOL_NAME, input: {} }] },
      { role: 'tool', toolCallId: 'r1', toolName: TOOL_RESULT_READ_TOOL_NAME, content: readBackPayload },
      { role: 'assistant', toolCalls: [{ id: 'x', name: 'kb_search', input: {} }] },
      { role: 'tool', toolCallId: 'x', toolName: 'kb_search', content: 'y'.repeat(6_000) },
    ]
    const result = compactToolResultHistory(messages, {
      ...COMPACTION_OPTIONS,
      limits: { ...TEST_LIMITS, keepRecentToolResults: 1 },
    })
    assert.equal(result.evicted.length, 1)
    assert.equal(result.evicted[0].path, source, 'a forrás útvonala, nem új archívum')
  })

  await check('a visszaolvasás stubja TILTJA az újraolvasást és a munkaterületre irányít', () => {
    const source = '.tool-results/http_api_get-call-0.json'
    const messages: GatewayMessage[] = [
      { role: 'user', content: 'kérdés' },
      { role: 'assistant', toolCalls: [{ id: 'r1', name: TOOL_RESULT_READ_TOOL_NAME, input: {} }] },
      {
        role: 'tool',
        toolCallId: 'r1',
        toolName: TOOL_RESULT_READ_TOOL_NAME,
        content: JSON.stringify({ path: source, content: 'x'.repeat(4_000) }),
      },
      { role: 'assistant', toolCalls: [{ id: 'x', name: 'kb_search', input: {} }] },
      { role: 'tool', toolCallId: 'x', toolName: 'kb_search', content: 'y'.repeat(6_000) },
    ]
    compactToolResultHistory(messages, {
      ...COMPACTION_OPTIONS,
      limits: { ...TEST_LIMITS, keepRecentToolResults: 1 },
    })
    const stub = toolContents(messages)[0]
    assert.ok(stub.startsWith(EVICTED_TOOL_RESULT_MARKER))
    assert.match(stub, /MÁR visszaolvastad/)
    assert.match(stub, /file_write/, 'a kiút konkrét: írd ki a munkaterületre')
    assert.ok(
      !/olvasd vissza a tool_result_read/.test(stub),
      'a stub nem biztathat újraolvasásra — ebből lett a körforgás',
    )
    assert.match(stub, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  await check('a forrás-útvonal kinyerése fail-soft (hibás alaknál nincs dobás)', () => {
    assert.equal(extractReadBackSourcePath('{"path":"a/b.json","x":1}'), 'a/b.json')
    assert.equal(extractReadBackSourcePath('csonkolt szöveg path nélkül'), null)
    assert.equal(extractReadBackSourcePath('HIBA: nincs ilyen elmentett tool-eredmény'), null)
  })

  await check('ugyanaz a path tooltól függetlenül ugyanaz a forrás', () => {
    assert.equal(
      toolCallSourceKey('file_read', { path: 'adat/nagy.json', offset: 0 }),
      toolCallSourceKey('tool_result_read', { path: 'adat/nagy.json', offset: 40_000 }),
    )
    assert.notEqual(
      toolCallSourceKey('load_skill_attachment', { skillVersionId: 'v1', path: 'assets/template.html' }),
      toolCallSourceKey('load_skill_attachment', { skillVersionId: 'v2', path: 'assets/template.html' }),
      'azonos relatív nevű, de más skillverzióhoz tartozó melléklet nem ugyanaz a forrás',
    )
    assert.notEqual(
      toolCallSourceKey('gmail_get_message', { id: '42' }),
      toolCallSourceKey('ticket_get', { id: '42' }),
      'az általános id mező tool-név nélkül külön entitástípusokat ütköztetne',
    )
  })

  await check('az első sikeres fallback modellre rögzül a teljes tool-loop', async () => {
    const requestedProviders: string[] = []
    const requestedFallbackCounts: number[] = []
    let call = 0
    const gateway = {
      call: async (args: { modelConfig: ModelConfig }) => {
        requestedProviders.push(args.modelConfig.provider)
        requestedFallbackCounts.push(args.modelConfig.fallbackModels?.length ?? 0)
        call += 1
        if (call === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'sticky-1', name: 'kb_search', input: { query: 'adat' } }],
            provider: 'openrouter',
            model: 'deepseek/deepseek-v4-flash-0731',
            fallbackRoute: { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' },
            usage: { promptTokens: 1, completionTokens: 1 },
          }
        }
        return {
          content: 'Kész.',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash-0731',
          usage: { promptTokens: 1, completionTokens: 1 },
        }
      },
    } as unknown as ModelGateway

    await runAgentToolLoop({
      gateway,
      toolBroker: brokerReturning({ hits: [] }),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-sticky-model' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'keress' }],
      modelConfig: {
        ...MODEL_CONFIG,
        fallbackModels: [
          { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' },
          { provider: 'openrouter', model: 'tartalek-2' },
        ],
      },
      allowedTools: ['kb_search'],
      maxTurns: 3,
    })

    assert.deepEqual(requestedProviders, ['chatgpt-oauth', 'openrouter'])
    // A pinnelt tartalék elsődleges lett, a mögötte lévő tartalék megmaradt.
    assert.deepEqual(requestedFallbackCounts, [2, 1])
  })

  await check('a sikeres elsődleges modell megtartja a vésztartalékait', async () => {
    const requestedFallbackCounts: number[] = []
    let call = 0
    const gateway = {
      call: async (args: { modelConfig: ModelConfig }) => {
        requestedFallbackCounts.push(args.modelConfig.fallbackModels?.length ?? 0)
        call += 1
        // A provider a modell-id hosszabb alakját echózza vissza — ez NEM tartalék.
        return call === 1
          ? {
              content: '',
              toolCalls: [{ id: 'primary-1', name: 'kb_search', input: { query: 'adat' } }],
              provider: MODEL_CONFIG.provider,
              model: `${MODEL_CONFIG.model}-20260601`,
            }
          : {
              content: 'Kész.',
              provider: MODEL_CONFIG.provider,
              model: `${MODEL_CONFIG.model}-20260601`,
            }
      },
    } as unknown as ModelGateway

    await runAgentToolLoop({
      gateway,
      toolBroker: brokerReturning({ hits: [] }),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-primary-model' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'keress' }],
      modelConfig: {
        ...MODEL_CONFIG,
        fallbackModels: [{ provider: 'openrouter', model: 'fallback' }],
      },
      allowedTools: ['kb_search'],
      maxTurns: 3,
    })

    assert.deepEqual(requestedFallbackCounts, [1, 1])
  })

  await check('a fallback modell a folytatási körben is megmarad', async () => {
    const workspace = new Map<string, string>()
    let firstCall = true
    const firstGateway = {
      call: async () => {
        if (firstCall) {
          firstCall = false
          return {
            content: '',
            toolCalls: [{ id: 'checkpoint-tool', name: 'kb_search', input: { query: 'adat' } }],
            provider: 'openrouter',
            model: 'deepseek/deepseek-v4-flash-0731',
            fallbackRoute: { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' },
          }
        }
        return {
          content: 'Első kör kész.',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash-0731',
        }
      },
    } as unknown as ModelGateway
    const workspaceIo = {
      writeWorkspaceFile: async (path: string, content: string) => {
        workspace.set(path, content)
        return { bytes: Buffer.byteLength(content) }
      },
      readWorkspaceFile: async (path: string) => workspace.get(path) ?? null,
      listWorkspaceFiles: async () => [...workspace.keys()],
    }

    await runAgentToolLoop({
      gateway: firstGateway,
      toolBroker: brokerReturning({ hits: [] }),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-checkpoint-model' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'keress' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['kb_search'],
      maxTurns: 3,
      ...workspaceIo,
    })
    assert.ok(workspace.has(TOOL_LOOP_CHECKPOINT_PATH))

    let resumedProvider = ''
    const resumedGateway = {
      call: async (args: { modelConfig: ModelConfig }) => {
        resumedProvider = args.modelConfig.provider
        return {
          content: 'Folytatás kész.',
          provider: args.modelConfig.provider,
          model: args.modelConfig.model,
        }
      },
    } as unknown as ModelGateway
    await runAgentToolLoop({
      gateway: resumedGateway,
      toolBroker: brokerReturning({ hits: [] }),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-checkpoint-model' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'folytasd' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['kb_search'],
      maxTurns: 2,
      resumeCheckpoint: true,
      ...workspaceIo,
    })

    assert.equal(resumedProvider, 'openrouter')
  })

  await check('a per-kör visszaolvasási keret a tömörítés keretére szorít (invariáns)', () => {
    // A védett ablak (keepRecentToolResults × egy visszaolvasás) nem lehet nagyobb
    // a teljes keretnél, különben a tömörítés sosem ér a limit alá. A mért eset:
    // 4 × 40 000 = 160 000 védett karakter 60 000-es keretnél.
    const limits: ContextCompactionLimits = {
      keepRecentToolResults: 4,
      maxToolResultChars: 60_000,
      minEvictableChars: 1_000,
    }
    const perTurn = readBackPerTurnBudget(limits)
    assert.equal(perTurn, 60_000)
    assert.ok(
      perTurn <= limits.maxToolResultChars,
      'a kör visszaolvasása nem léphet túl a tool-eredmény kereten',
    )
  })

  await check('a per-forrás keret egyszeri végigolvasást engedélyez, ismételtet nem', () => {
    const sourceChars = 40_401
    const budget = sourceIngestBudget(sourceChars)
    assert.ok(budget >= sourceChars, 'egyszer végig kell tudni olvasni')
    assert.ok(budget < sourceChars * 2, 'kétszer viszont nem')
    assert.equal(sourceIngestBudget(200), SOURCE_INGEST_DEFAULTS.minChars, 'kis forrásnál alsó korlát')
    assert.equal(
      sourceIngestBudget(null),
      SOURCE_INGEST_DEFAULTS.unknownSourceChars,
      'ismeretlen méretű forrásnak is van kerete',
    )
  })

  await check('a forrás-keret TOOL-FÜGGETLEN: bármely olvasó eszközre ugyanaz a szabály', () => {
    // Ugyanaz a fájl más eszközzel és más szelettel: a kulcs a FORRÁS, nem a hívás.
    assert.equal(
      toolCallSourceKey('file_read', { path: 'a/b.json', offset: 0, limit: 1000 }),
      toolCallSourceKey('file_read', { path: 'a/b.json', offset: 5000, limit: 200 }),
    )
    assert.notEqual(
      toolCallSourceKey('file_read', { path: 'a/b.json' }),
      toolCallSourceKey('file_read', { path: 'a/c.json' }),
    )
    // Dokumentum, URL, oldal, skill-verzió: mind stabil forrás-jelölő.
    assert.ok(toolCallSourceKey('document_read', { documentId: 'doc-1' }))
    assert.ok(toolCallSourceKey('web_fetch', { url: 'https://x.example/a' }))
    assert.ok(toolCallSourceKey('kb_get_page', { pageId: 'p-1' }))
    assert.ok(toolCallSourceKey('load_skill', { skillVersionId: 'sv-1' }))
    // Nincs forrás-jelölő (pl. keresés kulcsszóval) → a tartalom-ujjlenyomat dönt.
    assert.equal(toolCallSourceKey('kb_search', { query: 'novaj' }), null)
    assert.equal(toolCallSourceKey('web_search', undefined), null)
  })

  await check('az első végigolvasás teljes egészében legitim, a második nem', () => {
    const sourceChars = 10_000
    assert.equal(
      isRedundantSourceIngest({ ingestedCharsBefore: 0, sourceChars }),
      false,
      'induláskor sosem redundáns',
    )
    assert.equal(
      isRedundantSourceIngest({ ingestedCharsBefore: sourceChars, sourceChars }),
      false,
      'a keret az alsó korlátig ráhagyást ad — a lapozó olvasás nem büntetett',
    )
    assert.equal(
      isRedundantSourceIngest({ ingestedCharsBefore: 40_000, sourceChars }),
      true,
      'négyszer beolvasva már ismétlés',
    )
  })

  await check('a forrás-keret env-ből hangolható, védelmet kikapcsolni nem lehet', () => {
    const limits = resolveSourceIngestLimits({
      AGENT_SOURCE_INGEST_FACTOR: '3',
      AGENT_SOURCE_INGEST_MIN_CHARS: '50000',
      AGENT_SOURCE_INGEST_UNKNOWN_CHARS: 'nem-szám',
    } as unknown as NodeJS.ProcessEnv)
    assert.equal(limits.factor, 3)
    assert.equal(limits.minChars, 50_000)
    assert.equal(limits.unknownSourceChars, SOURCE_INGEST_DEFAULTS.unknownSourceChars)
    // A védelem alsó korlát alá nem vihető (0-s faktor / 0 karakter nem érvényes).
    const clamped = resolveSourceIngestLimits({
      AGENT_SOURCE_INGEST_FACTOR: '0',
      AGENT_SOURCE_INGEST_MIN_CHARS: '0',
    } as unknown as NodeJS.ProcessEnv)
    assert.equal(clamped.factor, SOURCE_INGEST_DEFAULTS.factor)
    assert.equal(clamped.minChars, SOURCE_INGEST_DEFAULTS.minChars)
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

  // ── EFF-11 (#316) — modelConfig overlay: modelConfig → env → default ───────
  // A tömörítés és a forrás-keret per-agent kapcsolója: szigorítani szabad,
  // kikapcsolni / lazítani nem. Overlay nélkül a mai (env/default) eredmény
  // bájtra ugyanaz marad.
  await check('EFF-11: tömörítés — precedencia modelConfig → env → default', () => {
    const cleanEnv = {} as NodeJS.ProcessEnv
    const fromDefault = resolveContextCompactionLimits(cleanEnv)
    assert.deepEqual(fromDefault, DEFAULT_CONTEXT_COMPACTION_LIMITS)

    const envOnly = {
      AGENT_CONTEXT_KEEP_RECENT_TOOL_RESULTS: '3',
      AGENT_CONTEXT_MAX_TOOL_RESULT_CHARS: '40000',
    } as unknown as NodeJS.ProcessEnv
    const fromEnv = resolveContextCompactionLimits(envOnly)
    assert.equal(fromEnv.keepRecentToolResults, 3)
    assert.equal(fromEnv.maxToolResultChars, 40_000)

    const fromConfig = resolveContextCompactionLimits(envOnly, DEFAULT_CONTEXT_COMPACTION_LIMITS, {
      keepRecentToolResults: 2,
      maxToolResultChars: 20_000,
    })
    assert.equal(fromConfig.keepRecentToolResults, 2, 'modelConfig szigorít az env fölött')
    assert.equal(fromConfig.maxToolResultChars, 20_000)
  })

  await check('EFF-11: tömörítés — szigoríthat, lazítani/kikapcsolni nem', () => {
    const env = {
      AGENT_CONTEXT_KEEP_RECENT_TOOL_RESULTS: '4',
      AGENT_CONTEXT_MAX_TOOL_RESULT_CHARS: '60000',
    } as unknown as NodeJS.ProcessEnv
    const baseline = resolveContextCompactionLimits(env)

    const tighter = resolveContextCompactionLimits(env, DEFAULT_CONTEXT_COMPACTION_LIMITS, {
      keepRecentToolResults: 2,
      maxToolResultChars: 30_000,
    })
    assert.equal(tighter.keepRecentToolResults, 2)
    assert.equal(tighter.maxToolResultChars, 30_000)

    const looser = resolveContextCompactionLimits(env, DEFAULT_CONTEXT_COMPACTION_LIMITS, {
      keepRecentToolResults: 99,
      maxToolResultChars: 5_000_000,
    })
    assert.deepEqual(looser, baseline, 'lazító overlay nem érvényesül')

    const off = resolveContextCompactionLimits(env, DEFAULT_CONTEXT_COMPACTION_LIMITS, {
      keepRecentToolResults: 0,
      maxToolResultChars: 0,
    })
    assert.deepEqual(off, baseline, 'kikapcsoló overlay nem érvényesül')
  })

  await check('EFF-11: tömörítés — overlay nélkül bájtra ugyanaz', () => {
    const env = {
      AGENT_CONTEXT_KEEP_RECENT_TOOL_RESULTS: '3',
      AGENT_CONTEXT_MAX_TOOL_RESULT_CHARS: '45000',
      AGENT_CONTEXT_MIN_EVICTABLE_CHARS: '800',
    } as unknown as NodeJS.ProcessEnv
    const without = resolveContextCompactionLimits(env)
    const withUndefined = resolveContextCompactionLimits(env, DEFAULT_CONTEXT_COMPACTION_LIMITS, undefined)
    const withNull = resolveContextCompactionLimits(env, DEFAULT_CONTEXT_COMPACTION_LIMITS, null)
    const withEmpty = resolveContextCompactionLimits(env, DEFAULT_CONTEXT_COMPACTION_LIMITS, {})
    assert.equal(JSON.stringify(withUndefined), JSON.stringify(without))
    assert.equal(JSON.stringify(withNull), JSON.stringify(without))
    assert.equal(JSON.stringify(withEmpty), JSON.stringify(without))
  })

  await check('EFF-11: forrás-keret — precedencia modelConfig → env → default', () => {
    const cleanEnv = {} as NodeJS.ProcessEnv
    assert.deepEqual(resolveSourceIngestLimits(cleanEnv), SOURCE_INGEST_DEFAULTS)

    const envOnly = {
      AGENT_SOURCE_INGEST_FACTOR: '3',
      AGENT_SOURCE_INGEST_MIN_CHARS: '24000',
    } as unknown as NodeJS.ProcessEnv
    const fromEnv = resolveSourceIngestLimits(envOnly)
    assert.equal(fromEnv.factor, 3)
    assert.equal(fromEnv.minChars, 24_000)

    const fromConfig = resolveSourceIngestLimits(envOnly, SOURCE_INGEST_DEFAULTS, {
      sourceIngestFactor: 1,
      sourceIngestMinChars: 12_000,
    })
    assert.equal(fromConfig.factor, 1, 'modelConfig szigorít az env fölött')
    assert.equal(fromConfig.minChars, 12_000)
  })

  await check('EFF-11: forrás-keret — szigoríthat, lazítani/kikapcsolni nem', () => {
    const env = {
      AGENT_SOURCE_INGEST_FACTOR: '2',
      AGENT_SOURCE_INGEST_MIN_CHARS: '20000',
    } as unknown as NodeJS.ProcessEnv
    const baseline = resolveSourceIngestLimits(env)

    const tighter = resolveSourceIngestLimits(env, SOURCE_INGEST_DEFAULTS, {
      sourceIngestFactor: 1,
      sourceIngestMinChars: 12_000,
    })
    assert.equal(tighter.factor, 1)
    assert.equal(tighter.minChars, 12_000)

    const looser = resolveSourceIngestLimits(env, SOURCE_INGEST_DEFAULTS, {
      sourceIngestFactor: 10,
      sourceIngestMinChars: 999_999,
    })
    assert.deepEqual(looser, baseline)

    const off = resolveSourceIngestLimits(env, SOURCE_INGEST_DEFAULTS, {
      sourceIngestFactor: 0,
      sourceIngestMinChars: 0,
    })
    assert.deepEqual(off, baseline)
  })

  await check('EFF-11: forrás-keret — overlay nélkül bájtra ugyanaz', () => {
    const env = {
      AGENT_SOURCE_INGEST_FACTOR: '2.5',
      AGENT_SOURCE_INGEST_MIN_CHARS: '15000',
    } as unknown as NodeJS.ProcessEnv
    const without = resolveSourceIngestLimits(env)
    assert.equal(
      JSON.stringify(resolveSourceIngestLimits(env, SOURCE_INGEST_DEFAULTS, undefined)),
      JSON.stringify(without),
    )
    assert.equal(
      JSON.stringify(resolveSourceIngestLimits(env, SOURCE_INGEST_DEFAULTS, null)),
      JSON.stringify(without),
    )
    assert.equal(
      JSON.stringify(resolveSourceIngestLimits(env, SOURCE_INGEST_DEFAULTS, {})),
      JSON.stringify(without),
    )
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
    // A nagy eredmények már a loop offload-előnézetével (~2,5k karakter) érkeznek,
    // ezért a tömörítési keretnek ez alá kell lőnie, hogy egyáltalán működésbe lépjen.
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
        return fakeToolBrokerSuccess(input.tool, {
          ok: true,
          status: 200,
          body: {
            rows: Array.from({ length: 300 }, (_, i) => ({
              id: page * 1000 + i,
              name: `Tulajdonos ${page}-${i}`,
              share: '1/300',
              note: 'ingatlan-nyilvántartási megjegyzés '.repeat(4),
            })),
          },
        })
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
      maxToolResultChars: 10_000,
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
      maxToolResultChars: 10_000,
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
        maxToolResultChars: 10_000,
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

  /**
   * A 2026-07-29-i eset REPRODUKCIÓJA: a modell körönként ugyanazt az archívumot
   * olvassa vissza, VÁLTOZÓ limittel. A változó limit miatt a szelet tartalma
   * körönként más, ezért sem az argumentum-alapú ismétlés-őr, sem a tartalmi
   * ujjlenyomat nem fogja meg — a mért futásban ez 132 visszaolvasást és 40 kört
   * jelentett érdemi előrehaladás nélkül. Üzletileg: a felhasználó fizetett egy
   * teljes napi keretet egy el sem készült Excelért.
   */
  async function runReadBackLivelockScenario() {
    const MAX_TURNS = 30
    const archived = new Map<string, string>()
    // A mért futás visszaolvasás-méretei (a naplóból, karakterben).
    const readLimits = [13_500, 40_000, 25_772, 12_772, 30_000, 20_000, 6_500, 39_472]
    const activities: { title: string; status: string; detail?: string }[] = []
    let gatewayCalls = 0

    const gateway = {
      call: async (args: { tools?: unknown[] }) => {
        gatewayCalls += 1
        // A záró összefoglaló hívás eszközök nélkül megy — arra prózát adunk.
        if (!args.tools) return { content: 'Összefoglaló.', usage: { promptTokens: 1, completionTokens: 1 } }
        if (gatewayCalls === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'crm-1', name: 'http_api_get', input: { path: '/rows' } }] as GatewayToolCall[],
            usage: { promptTokens: 1, completionTokens: 1 },
          }
        }
        const path = [...archived.keys()][0]
        if (!path) return { content: 'Nincs archívum.', usage: { promptTokens: 1, completionTokens: 1 } }
        return {
          content: '',
          toolCalls: [
            {
              id: `read-${gatewayCalls}`,
              name: 'tool_result_read',
              input: { path, offset: 0, limit: readLimits[(gatewayCalls - 2) % readLimits.length] },
            },
          ] as GatewayToolCall[],
          usage: { promptTokens: 1, completionTokens: 1 },
        }
      },
    } as unknown as ModelGateway

    const toolBroker = {
      invoke: async (input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> =>
        fakeToolBrokerSuccess(input.tool, {
          ok: true,
          status: 200,
          body: {
            rows: Array.from({ length: 300 }, (_, i) => ({
              id: i,
              name: `Tulajdonos ${i}`,
              share: '1/300',
              note: 'ingatlan-nyilvántartási megjegyzés '.repeat(4),
            })),
          },
        }),
    } as unknown as ToolBrokerService

    const result = await runAgentToolLoop({
      gateway,
      toolBroker,
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-livelock' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'egyeztesd a tulajdonosokat' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['http_api_get'] as ChatPlatformToolName[],
      maxTurns: MAX_TURNS,
      // A produkciós alapértékek — épp azt igazoljuk, hogy ezekkel is megáll.
      contextCompaction: DEFAULT_CONTEXT_COMPACTION_LIMITS,
      onActivity: (event) => {
        if (event.kind === 'tool') {
          activities.push({ title: event.title, status: event.status ?? '', detail: event.detail })
        }
      },
      archiveLargeToolResult: async ({ content, path, toolName, callId }) => {
        const target = path ?? `.tool-results/${toolName}-${callId}.json`
        archived.set(target, content)
        return { path: target, bytes: Buffer.byteLength(content) }
      },
    })

    const reads = activities.filter((a) => a.title === 'tool_result_read')
    return {
      result,
      gatewayCalls,
      maxTurns: MAX_TURNS,
      readsDone: reads.filter((a) => a.status === 'done').length,
      readsSkipped: reads.filter((a) => a.status === 'skipped').length,
    }
  }

  await check('visszaolvasásba ragadt futás magától megáll (nem a kör-limitnél)', async () => {
    const run = await runReadBackLivelockScenario()
    assert.equal(run.result.status, 'exhausted')
    assert.equal(
      run.result.reason,
      'no_progress',
      `a zsákutca-őrnek kell leállítania, nem a kör-limitnek (kapott: ${run.result.reason})`,
    )
    assert.ok(
      run.gatewayCalls < run.maxTurns / 2,
      `a kör-limit felét sem érheti el (${run.gatewayCalls} hívás / ${run.maxTurns} kör)`,
    )
    console.log(`     ↳ ${run.gatewayCalls} modellhívás a ${run.maxTurns} kör-limitből`)
  })

  await check('egy archívum nagyjából egyszer olvasható végig, utána a hívás kimarad', async () => {
    const run = await runReadBackLivelockScenario()
    assert.ok(run.readsDone > 0, 'a legitim visszaolvasás nem tiltható')
    assert.ok(run.readsDone <= 5, `a végigolvasás után nincs újraolvasás (${run.readsDone} sikeres)`)
    assert.ok(run.readsSkipped > 0, 'a keret felett a hívás kimarad')
    console.log(`     ↳ visszaolvasás: ${run.readsDone} lefutott, ${run.readsSkipped} kimaradt`)
  })

  await check('a visszaolvasás beszámít a tool-büdzsébe', async () => {
    const run = await runReadBackLivelockScenario()
    // Korábban a tool_result_read ág a számláló ELŐTT lépett ki, így egy 132
    // visszaolvasásos futás is 1 eszközhívásnak látszott — a büdzsé-őr vak volt rá.
    assert.ok(
      run.result.toolCallCount > run.readsDone,
      `a lefutott visszaolvasások + a broker-hívás mind számít (${run.result.toolCallCount})`,
    )
  })

  console.log('\n🧪 A fék általánossága: ugyanez más eszköz-mintákkal is megáll\n')

  /**
   * Általános livelock-próba: a modell körönként UGYANAZT a hívást adja vissza,
   * változó argumentummal (tehát változó tartalommal). A `makeCall` adja a minta
   * eszközét. Az állítás minden mintára ugyanaz: a futás korlátos, és NEM a
   * kör-limit állítja meg. Ez a kérdés lényege — a fék nem egy konkrét eszközre
   * (`tool_result_read`) szól, hanem az „egy helyben járás" mintájára.
   */
  async function runRepeatingCallScenario(input: {
    allowedTools: ChatPlatformToolName[]
    makeCall: (turn: number) => GatewayToolCall
    brokerResult?: (turn: number) => unknown
    loadSkill?: Parameters<typeof runAgentToolLoop>[0]['loadSkill']
  }) {
    const MAX_TURNS = 30
    let gatewayCalls = 0
    let brokerCalls = 0

    const gateway = {
      call: async (args: { tools?: unknown[] }) => {
        gatewayCalls += 1
        if (!args.tools) return { content: 'Összefoglaló.', usage: { promptTokens: 1, completionTokens: 1 } }
        return {
          content: '',
          toolCalls: [input.makeCall(gatewayCalls)] as GatewayToolCall[],
          usage: { promptTokens: 1, completionTokens: 1 },
        }
      },
    } as unknown as ModelGateway

    const toolBroker = {
      invoke: async (): Promise<ToolBrokerInvokeResult> => {
        brokerCalls += 1
        return {
          denied: false,
          result: input.brokerResult?.(brokerCalls) ?? { ok: true },
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
      context: { conversationId: 'conv-generic-livelock' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'dolgozz' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: input.allowedTools,
      maxTurns: MAX_TURNS,
      contextCompaction: DEFAULT_CONTEXT_COMPACTION_LIMITS,
      ...(input.loadSkill ? { loadSkill: input.loadSkill } : {}),
      archiveLargeToolResult: async ({ content, path, toolName, callId }) => ({
        path: path ?? `.tool-results/${toolName}-${callId}.json`,
        bytes: Buffer.byteLength(content),
      }),
    })

    return { result, gatewayCalls, maxTurns: MAX_TURNS }
  }

  /** A négy mintára ugyanazt állítjuk — a fék nem eszköz-specifikus. */
  const genericPatterns: {
    name: string
    run: () => Promise<{ result: Awaited<ReturnType<typeof runAgentToolLoop>>; gatewayCalls: number; maxTurns: number }>
  }[] = [
    {
      name: 'ugyanaz a fájl változó offsettel (broker-ág, file_read)',
      run: () =>
        runRepeatingCallScenario({
          allowedTools: ['file_read'] as ChatPlatformToolName[],
          // Változó offset → változó tartalom → a tartalom-ujjlenyomat mindig „új".
          makeCall: (turn) => ({
            id: `fr-${turn}`,
            name: 'file_read',
            input: { path: 'adat/nagy.json', offset: turn * 1_000, limit: 40_000 },
          }),
          brokerResult: (n) => ({ chunk: `sor-${n} `.repeat(5_000) }),
        }),
    },
    {
      name: 'ugyanannak a skillnek az újratöltése (belső eszköz, load_skill)',
      run: () =>
        runRepeatingCallScenario({
          allowedTools: ['file_read'] as ChatPlatformToolName[],
          makeCall: (turn) => ({
            id: `ls-${turn}`,
            name: 'load_skill',
            input: { skillVersionId: 'sv-1' },
          }),
          loadSkill: async () => ({ ok: true, instructions: 'skill-instrukció '.repeat(400) }),
        }),
    },
    {
      name: 'nem engedélyezett eszköz ismételt hívása (elutasított ág)',
      run: () =>
        runRepeatingCallScenario({
          allowedTools: ['file_read'] as ChatPlatformToolName[],
          makeCall: (turn) => ({ id: `nx-${turn}`, name: 'docx_create', input: { title: `t-${turn}` } }),
        }),
    },
    {
      name: 'ugyanannak a dokumentumnak a végtelen lapozása (documentId-forrás)',
      run: () =>
        runRepeatingCallScenario({
          allowedTools: ['document_read'] as ChatPlatformToolName[],
          makeCall: (turn) => ({
            id: `dr-${turn}`,
            name: 'document_read',
            input: { documentId: 'doc-1', page: turn },
          }),
          brokerResult: (n) => ({ page: n, text: `oldal-${n} `.repeat(5_000) }),
        }),
    },
  ]

  for (const pattern of genericPatterns) {
    await check(`livelock megáll — ${pattern.name}`, async () => {
      const run = await pattern.run()
      assert.equal(run.result.status, 'exhausted')
      assert.notEqual(
        run.result.reason,
        'max_turns_exhausted',
        'a kör-limit a végső háló, nem a fék — valamelyik előrehaladás-őrnek kell fognia',
      )
      assert.ok(
        run.gatewayCalls <= run.maxTurns / 2,
        `korlátos futás (${run.gatewayCalls} hívás / ${run.maxTurns} kör-limit)`,
      )
      console.log(`     ↳ ${run.gatewayCalls} kör, leállás: ${run.result.reason}`)
    })
  }

  console.log(failures === 0 ? '\n✅ Minden teszt zöld\n' : `\n❌ ${failures} teszt bukott\n`)
  if (failures > 0) process.exit(1)
}

void main()
