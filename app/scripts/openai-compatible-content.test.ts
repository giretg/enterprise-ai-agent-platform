/**
 * Determinisztikus parser-teszt az OpenAI-kompatibilis provider válaszaihoz.
 * Futtatás: npx tsx scripts/openai-compatible-content.test.ts
 */
import assert from 'node:assert/strict'
import { extractOpenAiCompatibleContent } from '../src/domain/gateway/model-gateway'

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

console.log('=== OpenAI-kompatibilis content parser teszt ===')

check('klasszikus chat completions content string', () => {
  assert.equal(
    extractOpenAiCompatibleContent({
      choices: [{ message: { content: 'Szia, miben segithetek?' } }],
    }),
    'Szia, miben segithetek?',
  )
})

check('OpenAI-style tombos text content', () => {
  assert.equal(
    extractOpenAiCompatibleContent({
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: 'Elso mondat. ' },
              { type: 'text', text: 'Masodik mondat.' },
            ],
          },
        },
      ],
    }),
    'Elso mondat. Masodik mondat.',
  )
})

check('OpenRouter/GPT-OSS reasoning fallback, ha content null', () => {
  assert.equal(
    extractOpenAiCompatibleContent({
      choices: [{ message: { content: null, reasoning: 'A valasz reasoning mezoben erkezett.' } }],
    }),
    'A valasz reasoning mezoben erkezett.',
  )
})

check('legacy completions text fallback', () => {
  assert.equal(
    extractOpenAiCompatibleContent({
      choices: [{ text: 'Legacy text valasz.' }],
    }),
    'Legacy text valasz.',
  )
})

check('ures valasz ures marad', () => {
  assert.equal(
    extractOpenAiCompatibleContent({
      choices: [{ message: { content: '  ', reasoning: '' }, finish_reason: 'stop' }],
    }),
    '',
  )
})

console.log(`\n=== Osszesites === ${failures === 0 ? 'MIND ZOLD' : `${failures} sikertelen`}`)
process.exit(failures === 0 ? 0 : 1)
