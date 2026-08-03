/**
 * Stuck-thinking detektor + tool-loop bekötés.
 * Futtatás: npx tsx scripts/stuck-final-answer.test.ts
 */
import assert from 'node:assert/strict'
import {
  STUCK_THINKING_FALLBACK_MESSAGE,
  detectStuckFinalAnswer,
} from '../src/domain/agent/stuck-final-answer'
import {
  STUCK_THINKING_FALLBACK_MESSAGE as LOOP_FALLBACK,
  runAgentToolLoop,
  type ChatPlatformToolName,
} from '../src/domain/agent/chat-tool-loop'
import type {
  GatewayMessage,
  ModelConfig,
  ModelGateway,
  ToolDefinition,
} from '../src/domain/gateway/model-gateway'
import type {
  ToolBrokerInvokeResult,
  ToolBrokerService,
} from '../src/domain/tool-broker/tool-broker-service'
import type { ToolBrokerRepository } from '../src/repositories/interfaces'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const MODEL_CONFIG: ModelConfig = { provider: 'chatgpt-oauth', model: 'stub' }
const ALLOWED_TOOLS: ChatPlatformToolName[] = ['kb_search']
const fakeToolCaps = {
  findConnectorsForAgent: async () => [],
} as unknown as ToolBrokerRepository

function stuckMonologue(): string {
  const block =
    'A tree-paths.json fájlban kell keresnem. De nincs file_read eszközöm. ' +
    'A tool_result_extract csak mezőkivonatot ad. A kézikönyv base64-ben van. ' +
    'Nem tudom dekódolni közvetlenül. A tool_result_read a nyers JSON-t adja. ' +
    'Nem praktikus. Inkább keressük a riport kódot. A content base64.\n\n'
  return block.repeat(12)
}

async function main() {
  console.log('stuck-final-answer')

  await test('rövid válasz nem stuck', () => {
    assert.equal(detectStuckFinalAnswer('A riporting menüpont X, Y, Z riportokat ad.').stuck, false)
  })

  await test('ismétlődő meta-töprengés stuck', () => {
    const v = detectStuckFinalAnswer(stuckMonologue())
    assert.equal(v.stuck, true)
  })

  await test('kódot magyarázó hosszú válasz NEM stuck', () => {
    // Pont az a válasz, amiért a GitHub-olvasás készült: az eszköznevek és a
    // „base64” szó jogosan szerepelnek benne. Ezt nem szabad eldobni.
    const answer =
      'A `http_api_get` hívás a GitHub Contents API-t szólítja meg, és a válasz `content` mezője base64-ben érkezik.\n\n' +
      'A platform ezt a `decodeGitHubContentsBody` függvényben dekódolja UTF-8-ra, mielőtt a modell megkapná. ' +
      'Így a `tool_result_read` eszközre nincs is szükség a szokásos méretű forrásfájloknál.\n\n' +
      '```ts\n' +
      'const body = decodeGitHubContentsBody(JSON.parse(text))\n'.repeat(6) +
      '```\n\n' +
      'A `file_read` ezzel szemben a munkaterületi fájlokat olvassa, tehát a kettő nem keverendő. ' +
      'A nagy válaszokat a rendszer a `.tool-results/` könyvtárba archiválja, és a nyers JSON ott marad meg, ' +
      'így a későbbi fordulók is hozzáférnek anélkül, hogy a teljes tartalom a kontextusban ülne.\n\n' +
      'A könyvtárlistáknál a platform elhagyja a bejegyzésenkénti három redundáns URL-mezőt, mert azok ' +
      'ugyanarra az erőforrásra mutatnak, mint a megmaradó hivatkozások, viszont a lista méretét megduplázzák. ' +
      'A fájlnév, az útvonal, a típus és a méret marad, ezekből dől el, melyik fájlt érdemes megnyitni.\n\n' +
      'A méret-kaput a rendszer a ténylegesen visszaadott alakra méri, nem a nyers válaszra: a base64 ' +
      'kódolás nagyjából egyharmaddal növeli a hosszat, ezért a nyers hosszal mérve egy hiánytalanul ' +
      'átadott forrásfájl is túllépné a küszöböt, és a felhasználó azt a jelzést kapná, hogy hiányos adatot lát.\n\n' +
      'A `tool_result_extract` akkor kerül elő, amikor egy lekérdezés több ezer soros nyilvántartást ad ' +
      'vissza: ilyenkor a teljes tábla a munkaterületre kerül, és az eszköz csak a kért mezőket emeli ki ' +
      'belőle. Forráskódnál erre nincs szükség, mert egy modul mérete jellemzően elfér a válaszban, és a ' +
      'darabolás inkább rontaná az áttekinthetőséget, mint javítaná.\n\n' +
      'A base64 kódolás egyébként azért kerül a válaszba, mert a Contents API bináris fájlokat is tud ' +
      'szolgáltatni, és egyetlen egységes mezőben adja vissza mindkettőt. A platform ezért a dekódolás ' +
      'után megnézi, hogy a bájtok szövegnek látszanak-e, és bináris tartalomnál a mezőt inkább elhagyja, ' +
      'mint hogy értelmezhetetlen karaktereket adjon át.\n\n' +
      'A jogosultságokat a connector oldalán a repository-hatókör őrzi: a hívás útvonalából kiolvasott ' +
      'owner/repo párost a rendszer összeveti az engedélyezett listával, és a listán kívüli repository-t ' +
      'akkor is elutasítja, ha a token egyébként hozzáférne. Ez a határ független attól, hogy a modell ' +
      'melyik végpontot próbálja hívni, tehát a fastruktúra és a fájltartalom is ugyanazt a szűrőt kapja.\n\n' +
      'Összefoglalva: a fájlok tartalma közvetlenül olvasható, külön dekódolási lépés nélkül, a fastruktúra ' +
      'pedig egyetlen hívással lekérhető, ha előbb el kell dönteni, melyik fájl a releváns.'
    // A puszta hossz + eszköznév-találat régen elég volt a „stuck” ítélethez —
    // ezért a szöveg szándékosan hosszabb a 2500-as meta-küszöbnél.
    assert.ok(answer.length > 2_500, `a teszt szövege elég hosszú (${answer.length})`)
    assert.equal(detectStuckFinalAnswer(answer).stuck, false)
  })

  await test('loop exportálja ugyanazt a fallback üzenetet', () => {
    assert.equal(LOOP_FALLBACK, STUCK_THINKING_FALLBACK_MESSAGE)
  })

  await test('tool loop: stuck válasz → fallback (retry után is stuck)', async () => {
    let calls = 0
    const gateway = {
      call: async (args: { messages: GatewayMessage[]; tools?: ToolDefinition[] }) => {
        calls += 1
        if (!args.tools) return { content: 'Összefoglaló.' }
        return { content: stuckMonologue() }
      },
    } as unknown as ModelGateway

    const broker = {
      invoke: async (): Promise<ToolBrokerInvokeResult> => {
        throw new Error('broker should not be called')
      },
    } as unknown as ToolBrokerService

    const result = await runAgentToolLoop({
      agentId: 'agent-1',
      agentVersion: 1,
      gateway,
      toolBroker: broker,
      toolCaps: fakeToolCaps,
      modelConfig: MODEL_CONFIG,
      allowedTools: ALLOWED_TOOLS,
      mode: 'chat',
      context: { conversationId: 'conv-stuck-1' },
      messages: [{ role: 'user', content: 'mit csinál a riporting menüpont?' }],
      maxTurns: 5,
    })

    assert.equal(result.status, 'completed')
    assert.equal(result.content, STUCK_THINKING_FALLBACK_MESSAGE)
    assert.ok(calls >= 2, `expected >=2 gateway calls, got ${calls}`)
  })

  await test('tool loop: normális rövid válasz átmegy', async () => {
    const gateway = {
      call: async () => ({
        content: 'A reporting menüpont összesített kimutatásokat ad: forgalom, készlet, partner.',
      }),
    } as unknown as ModelGateway

    const broker = {
      invoke: async (): Promise<ToolBrokerInvokeResult> => {
        throw new Error('unused')
      },
    } as unknown as ToolBrokerService

    const result = await runAgentToolLoop({
      agentId: 'agent-1',
      agentVersion: 1,
      gateway,
      toolBroker: broker,
      toolCaps: fakeToolCaps,
      modelConfig: MODEL_CONFIG,
      allowedTools: ALLOWED_TOOLS,
      mode: 'chat',
      context: { conversationId: 'conv-ok-1' },
      messages: [{ role: 'user', content: 'mi a reporting?' }],
      maxTurns: 5,
    })

    assert.equal(result.status, 'completed')
    assert.match(result.content, /reporting/i)
    assert.notEqual(result.content, STUCK_THINKING_FALLBACK_MESSAGE)
  })

  if (failures > 0) {
    console.error(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nall passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
