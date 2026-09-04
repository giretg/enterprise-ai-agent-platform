/**
 * Determinisztikus serializer-teszt a Claude Code OAuth hídhoz.
 * Futtatás: npx tsx scripts/claude-code-oauth-bridge.test.ts
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_CODE_IDENTITY_PROMPT,
  assertClaudeCodeCredentialFilePrivate,
  parseClaudeCodeCredentialJson,
  resolveClaudeCodeModel,
  resolveClaudeThinkingBudget,
  toAnthropicRequest,
} from '../src/domain/gateway/claude-code-oauth-bridge'
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

console.log('=== Claude Code OAuth bridge serializer teszt ===')

check('az első system-blokk a Claude Code identitás', () => {
  const request = toAnthropicRequest([
    { role: 'system', content: 'Válaszolj magyarul.' },
    { role: 'user', content: 'Szia' },
  ])
  assert.equal(request.system[0]?.text, CLAUDE_CODE_IDENTITY_PROMPT)
  assert.equal(request.system[1]?.text, 'Válaszolj magyarul.')
  assert.deepEqual(request.messages, [{ role: 'user', content: 'Szia' }])
})

check('assistant tool call → tool_use, tool eredmény → tool_result', () => {
  const messages: GatewayMessage[] = [
    { role: 'user', content: 'Keress.' },
    {
      role: 'assistant',
      content: 'Megnézem.',
      toolCalls: [{ id: 'call_1', name: 'crm.search', input: { q: 'sales' } }],
    },
    { role: 'tool', toolCallId: 'call_1', toolName: 'crm.search', content: '{"n":1}' },
  ]
  const request = toAnthropicRequest(messages)
  assert.deepEqual(request.messages, [
    { role: 'user', content: 'Keress.' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Megnézem.' },
        { type: 'tool_use', id: 'call_1', name: 'crm_search', input: { q: 'sales' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"n":1}' }],
    },
  ])
})

check('modelType → thinking budget', () => {
  assert.equal(resolveClaudeThinkingBudget('luna'), null)
  assert.equal(resolveClaudeThinkingBudget(undefined), null)
  assert.equal(resolveClaudeThinkingBudget('terra'), 2_048)
  assert.equal(resolveClaudeThinkingBudget('sol'), 6_144)
})

check('sentinel modell feloldás', () => {
  assert.equal(resolveClaudeCodeModel('claude-code-oauth-default'), 'claude-sonnet-4-6')
  assert.equal(resolveClaudeCodeModel('claude-opus-4-6'), 'claude-opus-4-6')
})

check('credentials JSON parse', () => {
  const tokens = parseClaudeCodeCredentialJson(JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-test',
      refreshToken: 'sk-ant-ort01-test',
      expiresAt: 1_800_000_000_000,
      subscriptionType: 'max',
    },
  }))
  assert.equal(tokens.accessToken, 'sk-ant-oat01-test')
  assert.equal(tokens.refreshToken, 'sk-ant-ort01-test')
  assert.equal(tokens.subscriptionType, 'max')
})

check('a fájlos OAuth credential nem lehet group/world olvasható', () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-oauth-'))
  const filePath = join(directory, 'credentials.json')
  try {
    writeFileSync(filePath, JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } }), { mode: 0o600 })

    chmodSync(filePath, 0o644)
    assert.throws(
      () => assertClaudeCodeCredentialFilePrivate(filePath),
      /must not be readable by group or others/,
    )

    chmodSync(filePath, 0o600)
    assert.doesNotThrow(() => assertClaudeCodeCredentialFilePrivate(filePath))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

console.log(`\n=== Osszesites === ${failures === 0 ? 'MIND ZOLD' : `${failures} sikertelen`}`)
process.exit(failures === 0 ? 0 : 1)
