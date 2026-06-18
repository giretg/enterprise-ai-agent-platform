/**
 * Determinisztikus parser-teszt a szöveges tool-hívás relay-hez (S6).
 * Futtatás: npm run test:gateway-relay
 *
 * A goose harness ChatGPT-OAuth útján a Gateway sima szöveget kap a modelltől;
 * ez a relay alakítja a recipe-szabta `{"tool":…,"args":{…}}` JSON-t natív
 * OpenAI `tool_calls` completionná. A teszt élő token NÉLKÜL igazolja a
 * konverzió helyességét (a végpontig tartó igazolás a live smoke dolga).
 */
import assert from 'node:assert/strict'
import {
  extractTextToolCall,
  relayTextToolCall,
  resolveGooseToolName,
  type OpenAiToolDef,
} from '../src/domain/gateway/text-tool-relay'

const TOOLS: OpenAiToolDef[] = [
  { type: 'function', function: { name: 'platform_broker__kb_search' } },
  { type: 'function', function: { name: 'platform_broker__board_write' } },
]

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

console.log('=== text-tool-relay parser teszt ===')

check('kb_search: csupasz JSON → tool_calls a prefixelt goose-névvel', () => {
  const completion = relayTextToolCall({
    content: '{"tool":"kb_search","args":{"query":"MVP cél","k":6}}',
    tools: TOOLS,
    model: 'gpt-5.5',
    usage: { promptTokens: 100, completionTokens: 10 },
  })
  assert.ok(completion, 'completion nem lehet null')
  const choice = completion.choices[0]
  assert.equal(choice.finish_reason, 'tool_calls')
  assert.equal(choice.message.content, null)
  const call = choice.message.tool_calls[0]
  assert.equal(call.function.name, 'platform_broker__kb_search')
  assert.deepEqual(JSON.parse(call.function.arguments), { query: 'MVP cél', k: 6 })
  assert.equal(completion.usage.total_tokens, 110)
})

check('board_write: code-fence-be csomagolt JSON → tool_calls', () => {
  const content = [
    'Most felírom az eredményt:',
    '```json',
    '{"tool":"board_write","args":{"ticketId":"t-1","patch":{"payload":{"answer":"x","confidence":"high"}}}}',
    '```',
  ].join('\n')
  const completion = relayTextToolCall({
    content,
    tools: TOOLS,
    model: 'gpt-5.5',
    usage: { promptTokens: 1, completionTokens: 1 },
  })
  assert.ok(completion)
  const call = completion.choices[0].message.tool_calls[0]
  assert.equal(call.function.name, 'platform_broker__board_write')
  const args = JSON.parse(call.function.arguments) as { ticketId: string }
  assert.equal(args.ticketId, 't-1')
})

check('végső szöveges válasz (nincs JSON) → null (finish_reason stop a hívónál)', () => {
  const completion = relayTextToolCall({
    content: 'Felírtam a választ a ticketre. Kész vagyok.',
    tools: TOOLS,
    model: 'gpt-5.5',
    usage: { promptTokens: 1, completionTokens: 1 },
  })
  assert.equal(completion, null)
})

check('nincs tools (nem harness hívás) → null', () => {
  const completion = relayTextToolCall({
    content: '{"tool":"kb_search","args":{"query":"x"}}',
    tools: [],
    model: 'gpt-5.5',
    usage: { promptTokens: 1, completionTokens: 1 },
  })
  assert.equal(completion, null)
})

check('ismeretlen tool (nincs a goose-listán) → null', () => {
  const completion = relayTextToolCall({
    content: '{"tool":"rm_rf","args":{"path":"/"}}',
    tools: TOOLS,
    model: 'gpt-5.5',
    usage: { promptTokens: 1, completionTokens: 1 },
  })
  assert.equal(completion, null)
})

check('inline JSON prózába ágyazva is kiolvasható', () => {
  const parsed = extractTextToolCall(
    'Rendben, keresek: {"tool":"kb_search","args":{"query":"átjárók"}} most.',
  )
  assert.ok(parsed)
  assert.equal(parsed.tool, 'kb_search')
})

check('resolveGooseToolName: pontos és __-szuffix egyezés is', () => {
  assert.equal(resolveGooseToolName(TOOLS, 'kb_search'), 'platform_broker__kb_search')
  assert.equal(
    resolveGooseToolName([{ function: { name: 'board_write' } }], 'board_write'),
    'board_write',
  )
  assert.equal(resolveGooseToolName(TOOLS, 'nincs_ilyen'), null)
})

check('args nélküli / hibás JSON → null', () => {
  assert.equal(extractTextToolCall('{"tool":"kb_search"}'), null)
  assert.equal(extractTextToolCall('csak sima szöveg'), null)
})

console.log(`\n=== Összesítés === ${failures === 0 ? 'MIND ZÖLD ✅' : `${failures} sikertelen ❌`}`)
process.exit(failures === 0 ? 0 : 1)
