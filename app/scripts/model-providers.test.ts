/**
 * Modellforrás, gondolkodási profil és tartalék-modell UI.
 * Futtatás: npx tsx scripts/model-providers.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { modelConfigSummary } from '../src/lib/agent-profile-labels'
import { MODEL_PROVIDER_IDS, providerUsesThinkingProfile } from '../src/lib/model-providers'

const root = resolve(import.meta.dirname, '..')

function readSrc(rel: string) {
  return readFileSync(resolve(root, rel), 'utf8')
}

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e: unknown) {
    failures += 1
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

console.log('model-providers')

check('Luna/Terra/Sol csak a reasoninges OAuth-providereknél él', () => {
  assert.equal(providerUsesThinkingProfile('chatgpt-oauth'), true)
  assert.equal(providerUsesThinkingProfile('claude-code-oauth'), true)
  assert.equal(providerUsesThinkingProfile('grok-cli-oauth'), true)
})

check('OpenRouter, Gemini, Ollama és ismeretlen provider: no-op', () => {
  assert.equal(providerUsesThinkingProfile('openrouter'), false)
  assert.equal(providerUsesThinkingProfile('gemini'), false)
  assert.equal(providerUsesThinkingProfile('ollama'), false)
  assert.equal(providerUsesThinkingProfile('unknown-provider'), false)
})

check('minden ismert provider explicit true vagy false', () => {
  for (const id of MODEL_PROVIDER_IDS) {
    assert.equal(typeof providerUsesThinkingProfile(id), 'boolean')
  }
})

check('az összefoglaló OpenRouteren nem írja ki a Lunát', () => {
  const summary = modelConfigSummary({
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash-0731',
    modelType: 'luna',
  })
  assert.match(summary, /OpenRouter/)
  assert.match(summary, /DeepSeek V4 Flash/)
  assert.doesNotMatch(summary, /Luna/)
})

check('az összefoglaló ChatGPT OAuthnál kiírja a gondolkodási profilt', () => {
  const summary = modelConfigSummary({
    provider: 'chatgpt-oauth',
    model: 'chatgpt-oauth-default',
    modelType: 'luna',
  })
  assert.match(summary, /ChatGPT OAuth/)
  assert.match(summary, /Luna/)
  assert.doesNotMatch(summary, /tartalék/)
})

check('az összefoglaló kiírja a tartalék modellt, ha van', () => {
  const summary = modelConfigSummary({
    provider: 'chatgpt-oauth',
    model: 'chatgpt-oauth-default',
    fallbackModels: [{ provider: 'claude-code-oauth', model: 'claude-sonnet-4-6' }],
  })
  assert.match(summary, /tartalék: /)
  assert.match(summary, /Claude/)
  assert.match(summary, /Sonnet/)
})

check('a gondolkodási motor űrlap a profilt providerhez köti', () => {
  const form = readSrc('src/components/agents/update-model-config-form.tsx')
  assert.match(form, /providerUsesThinkingProfile\(provider\)/)
  assert.match(form, /ModelTypeSelectField/)
})

check('a tartalék modell ugyanazzal a ModelSelectFielddel választódik, mint az alap', () => {
  const form = readSrc('src/components/agents/update-model-config-form.tsx')
  const fallbackStart = form.indexOf('Tartalék modellek')
  assert.ok(fallbackStart >= 0)
  const fallback = form.slice(fallbackStart)
  assert.match(fallback, /ModelSelectField/)
  assert.match(fallback, /normalizeModelForProvider\(fbProvider/)
  assert.doesNotMatch(fallback, /placeholder="model"/)
  assert.doesNotMatch(fallback, /<input[\s\S]*fbModel/)
})

check('az új-agent varázsló nem tartalmazza a gondolkodási motort', () => {
  const wizard = readSrc('src/components/agents/create-agent-wizard.tsx')
  assert.doesNotMatch(wizard, /providerUsesThinkingProfile/)
  assert.doesNotMatch(wizard, /ModelTypeSelectField/)
})

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott`)
  process.exit(1)
}
console.log('\nMinden teszt rendben.')
