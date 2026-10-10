/**
 * #768 — agent modell-konfig + engedett lista + tartalék-lánc (tiszta logika, DB nélkül).
 * Futtatás: npm run test:model-fallback-chain
 */
import assert from 'node:assert/strict'
import {
  buildEffectiveFallbackChain,
  classifyProviderError,
  fallbackMaxAttemptsFromEnv,
  GatewayBlockedError,
  shouldFallback,
} from '../src/domain/model-gateway/fallback-chain'
import { normalizeModelConfig, parseAgentModelConfig, resolveAgentPrimary } from '../src/lib/agent-model-config'
import { fallbackPreviewSteps } from '../src/lib/model-fallback-preview'
import { isModelAllowed, parseModelPolicy, setModelEnabled, type ModelRef } from '../src/lib/model-policy'

const gpt: ModelRef = { provider: 'chatgpt-oauth', model: 'chatgpt-oauth-default' }
const sonnet: ModelRef = { provider: 'claude-code-oauth', model: 'claude-sonnet-4-6' }
const gemini: ModelRef = { provider: 'gemini', model: 'gemini-3.5-flash' }
const grok: ModelRef = { provider: 'grok-cli-oauth', model: 'grok-4.6' }
const policy = parseModelPolicy({ enabled: [gpt, sonnet, gemini] })

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e: unknown) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

check('lánc: elsődleges → agent tartalék → globális', () => {
  const chain = buildEffectiveFallbackChain({
    primary: gpt,
    agentFallbacks: [sonnet],
    globalFallbacks: [gemini],
    policy,
    maxAttempts: 5,
  })
  assert.deepEqual(chain, [gpt, sonnet, gemini])
})

check('lánc: nem engedett modell kiesik (tartalék és elsődleges is)', () => {
  assert.deepEqual(
    buildEffectiveFallbackChain({ primary: gpt, agentFallbacks: [grok], globalFallbacks: [gemini], policy }),
    [gpt, gemini],
  )
  assert.deepEqual(
    buildEffectiveFallbackChain({ primary: grok, agentFallbacks: [sonnet], policy }),
    [sonnet],
  )
})

check('lánc: duplikátum nem ismétlődik, nem csak szomszédosan', () => {
  assert.deepEqual(
    buildEffectiveFallbackChain({
      primary: gpt,
      agentFallbacks: [sonnet, gpt],
      globalFallbacks: [sonnet, gemini],
      policy,
      maxAttempts: 5,
    }),
    [gpt, sonnet, gemini],
  )
})

check('lánc: max kísérletszám, üres policy → üres lánc', () => {
  assert.equal(
    buildEffectiveFallbackChain({ primary: gpt, agentFallbacks: [sonnet, gemini], policy, maxAttempts: 2 }).length,
    2,
  )
  assert.deepEqual(buildEffectiveFallbackChain({ primary: gpt, policy: { enabled: [] } }), [])
  assert.equal(fallbackMaxAttemptsFromEnv({ GATEWAY_FALLBACK_MAX_ATTEMPTS: '4' }), 4)
  assert.equal(fallbackMaxAttemptsFromEnv({ GATEWAY_FALLBACK_MAX_ATTEMPTS: 'x' }), 3)
})

check('váltó hiba-osztályok', () => {
  for (const msg of ['503 Service Unavailable', 'fetch failed', 'request timed out after 240000ms', '429 Too Many Requests', 'model not found: x', '404']) {
    assert.equal(shouldFallback({ error: new Error(msg), firstTokenEmitted: false }), true, msg)
  }
  assert.equal(classifyProviderError(new Error('request timed out after 240000ms')), 'provider_unavailable')
})

check('NEM váltó hiba-osztályok: auth, tartalom, blokk, keret, quota, ismeretlen', () => {
  for (const err of [
    new Error('401 Unauthorized'),
    new Error('invalid api key'),
    new Error('400 invalid_request: context length exceeded'),
    new GatewayBlockedError('napi keret elfogyott'),
    new Error('napi keret elfogyott'),
    new Error('You exceeded your current quota'),
    new Error('insufficient_quota'),
    new Error('budget exceeded'),
    new Error('failed to generate a reply'),
    new Error('valami váratlan'),
  ]) {
    assert.equal(shouldFallback({ error: err, firstTokenEmitted: false }), false, err.message)
  }
  assert.equal(classifyProviderError(new GatewayBlockedError('érzékeny tartalom')), 'blocked')
  assert.equal(classifyProviderError(new Error('You exceeded your current quota')), 'blocked')
  assert.equal(classifyProviderError(new Error('401 Unauthorized')), 'auth_error')
})

check('első token után hiba nem vált', () => {
  assert.equal(shouldFallback({ error: new Error('503 Service Unavailable'), firstTokenEmitted: true }), false)
})

check('modell-konfig: parse, alapérték az engedett lista első eleme', () => {
  assert.equal(parseAgentModelConfig(null), null)
  assert.equal(parseAgentModelConfig({ provider: 'nincs-ilyen', model: 'x' }), null)
  assert.deepEqual(resolveAgentPrimary(null, policy), gpt)
  assert.equal(resolveAgentPrimary(null, { enabled: [] }), null)
  assert.deepEqual(resolveAgentPrimary({ ...sonnet, fallbackModels: [] }, policy), sonnet)
  assert.deepEqual(resolveAgentPrimary({ ...grok, fallbackModels: [] }, policy), gpt)
})

check('modell-konfig: a tartalék nem lehet az elsődleges, duplikátum nélkül', () => {
  const cfg = normalizeModelConfig({ ...gpt, fallbackModels: [gpt, sonnet, sonnet] })
  assert.deepEqual(cfg.fallbackModels, [sonnet])
})

check('előnézet: elsődleges → tartalék lépések', () => {
  assert.deepEqual(
    fallbackPreviewSteps({
      primary: gpt,
      agentFallbacks: [sonnet],
      globalFallbacks: [gemini],
      policy,
      maxAttempts: 5,
    }),
    [
      { from: gpt, to: sonnet },
      { from: sonnet, to: gemini },
    ],
  )
})

check('policy: bekapcsolás / kikapcsolás', () => {
  const on = setModelEnabled({ enabled: [] }, grok, true)
  assert.equal(isModelAllowed(on, grok), true)
  assert.equal(isModelAllowed(setModelEnabled(on, grok, false), grok), false)
  assert.equal(isModelAllowed(parseModelPolicy({ enabled: [{ provider: 'x', model: 'y' }] }), grok), false)
})

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nmodel-fallback-chain.test.ts: OK')
