/**
 * Determinisztikus serializer-teszt a ChatGPT OAuth Responses bridge-hez.
 * Futtatás: npx tsx scripts/chatgpt-oauth-bridge.test.ts
 */
import assert from 'node:assert/strict'
import {
  resolveReasoningEffort,
  toResponsesRequest,
} from '../src/domain/gateway/chatgpt-oauth-bridge'
import type { GatewayMessage } from '../src/domain/gateway/model-gateway'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

console.log('=== ChatGPT OAuth bridge serializer teszt ===')

check('assistant history output_text content tipust kap', () => {
  const messages: GatewayMessage[] = [
    { role: 'system', content: 'Valaszolj magyarul.' },
    { role: 'user', content: 'Keszits jelentest.' },
    { role: 'assistant', content: 'Megprobaltam, de nincs eleg adat.' },
    { role: 'user', content: 'probald ujra' },
  ]

  const request = toResponsesRequest(messages)

  assert.equal(request.instructions, 'Valaszolj magyarul.')
  assert.deepEqual(request.input, [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Keszits jelentest.' }],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Megprobaltam, de nincs eleg adat.' }],
    },
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'probald ujra' }],
    },
  ])
})

check('assistant tool call ures szoveggel csak function_call item', () => {
  const request = toResponsesRequest([
    {
      role: 'assistant',
      toolCalls: [{ id: 'call_1', name: 'crm_search', input: { q: 'sales' } }],
    },
  ])

  assert.deepEqual(request.input, [
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'crm_search',
      arguments: '{"q":"sales"}',
    },
  ])
})

check('modelType luna/terra/sol → reasoningEffort', () => {
  assert.equal(resolveReasoningEffort('luna'), 'low')
  assert.equal(resolveReasoningEffort('terra'), 'medium')
  assert.equal(resolveReasoningEffort('sol'), 'high')
  assert.equal(resolveReasoningEffort(undefined), 'low')
  assert.equal(resolveReasoningEffort('unknown'), 'low')
})

console.log(`\n=== Osszesites === ${failures === 0 ? 'MIND ZOLD' : `${failures} sikertelen`}`)
process.exit(failures === 0 ? 0 : 1)
