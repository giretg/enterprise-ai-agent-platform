/**
 * Determinisztikus serializer-teszt a Grok CLI OAuth hídhoz.
 * Futtatás: npx tsx scripts/grok-cli-oauth-bridge.test.ts
 */
import assert from 'node:assert/strict'
import {
  isGrokAccessTokenExpired,
  parseGrokAuthFile,
  resolveGrokCliModel,
  resolveGrokReasoningEffort,
  toGrokChatMessages,
} from '../src/domain/gateway/grok-cli-oauth-bridge'
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

console.log('=== Grok CLI OAuth bridge serializer teszt ===')

check('auth.json OIDC bejegyzés parse', () => {
  const entry = parseGrokAuthFile(JSON.stringify({
    'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
      key: 'access-jwt',
      refresh_token: 'refresh-xyz',
      expires_at: '2099-01-01T00:00:00.000Z',
      oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
      email: 'dev@example.com',
    },
  }))
  assert.equal(entry.accessToken, 'access-jwt')
  assert.equal(entry.refreshToken, 'refresh-xyz')
  assert.equal(entry.clientId, 'b1a00492-073a-47ea-816f-4c329264a828')
  assert.equal(isGrokAccessTokenExpired(entry), false)
})

check('lejárt expires_at', () => {
  const entry = parseGrokAuthFile(JSON.stringify({
    'https://auth.x.ai::abc': {
      key: 't',
      refresh_token: 'r',
      expires_at: '2000-01-01T00:00:00.000Z',
      oidc_client_id: 'abc',
    },
  }))
  assert.equal(isGrokAccessTokenExpired(entry), true)
})

check('gateway üzenetek → OpenAI chat messages + tool history', () => {
  const messages: GatewayMessage[] = [
    { role: 'system', content: 'Légy tömör.' },
    { role: 'user', content: 'Keress.' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'call_1', name: 'crm_search', input: { q: 'sales' } }],
    },
    { role: 'tool', toolCallId: 'call_1', toolName: 'crm_search', content: '{}' },
  ]
  assert.deepEqual(toGrokChatMessages(messages), [
    { role: 'system', content: 'Légy tömör.' },
    { role: 'user', content: 'Keress.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'crm_search', arguments: '{"q":"sales"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{}' },
  ])
})

check('modelType luna/terra/sol → reasoning effort', () => {
  assert.equal(resolveGrokReasoningEffort('luna'), 'low')
  assert.equal(resolveGrokReasoningEffort('terra'), 'high')
  assert.equal(resolveGrokReasoningEffort('sol'), 'xhigh')
  assert.equal(resolveGrokReasoningEffort(undefined), 'high')
})

check('sentinel modell feloldás', () => {
  assert.equal(resolveGrokCliModel('grok-cli-oauth-default'), 'grok-4.6')
  assert.equal(resolveGrokCliModel('grok-4.5'), 'grok-4.5')
})

console.log(`\n=== Osszesites === ${failures === 0 ? 'MIND ZOLD' : `${failures} sikertelen`}`)
process.exit(failures === 0 ? 0 : 1)
