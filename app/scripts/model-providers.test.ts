/**
 * Modellforrás-katalógus: csak a gateway által hívható API-kulcsos providerek.
 * Futtatás: npm run test:model-providers
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MODEL_PROVIDER_IDS, MODEL_PROVIDERS, providerUsesThinkingProfile } from '../src/lib/model-providers'

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

check('a tenant katalógus csak Gemini és OpenRouter', () => {
  assert.deepEqual(
    MODEL_PROVIDERS.map((p) => p.value),
    ['gemini', 'openrouter'],
  )
})

check('OAuth-providerek nincsenek a gateway id-k között', () => {
  for (const id of ['chatgpt-oauth', 'claude-code-oauth', 'grok-cli-oauth']) {
    assert.equal((MODEL_PROVIDER_IDS as readonly string[]).includes(id), false, id)
  }
  assert.ok((MODEL_PROVIDER_IDS as readonly string[]).includes('ollama'))
})

check('Luna/Terra/Sol a céges API-úton no-op', () => {
  assert.equal(providerUsesThinkingProfile('openrouter'), false)
  assert.equal(providerUsesThinkingProfile('gemini'), false)
  assert.equal(providerUsesThinkingProfile('ollama'), false)
  assert.equal(providerUsesThinkingProfile('chatgpt-oauth'), false)
})

check('minden ismert provider explicit true vagy false', () => {
  for (const id of MODEL_PROVIDER_IDS) {
    assert.equal(typeof providerUsesThinkingProfile(id), 'boolean')
  }
})

check('a gondolkodási mélység a formon a primary providerhez kötött', () => {
  const form = readSrc('src/components/agents/update-model-config-form.tsx')
  assert.match(form, /providerUsesThinkingProfile\(primary\.provider\)/)
})

check('az új-agent varázsló a gondolkodási motort az adatlap űrlapjával állítja (#957)', () => {
  const wizard = readSrc('src/components/agents/create-agent-wizard.tsx')
  assert.match(wizard, /UpdateModelConfigForm/)
  assert.doesNotMatch(wizard, /providerUsesThinkingProfile/)
  assert.doesNotMatch(wizard, /ModelTypeSelectField/)
})

check('a beállítások oldalon van Gemini-kulcs panel', () => {
  const page = readSrc('src/app/control-plane/settings/page.tsx')
  assert.match(page, /GeminiKeyPanel/)
  assert.match(page, /companyKeys/)
  assert.doesNotMatch(page, /chatgpt-oauth/)
})

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott`)
  process.exit(1)
}
console.log('\nMinden teszt rendben.')
