/**
 * Agent API-kulcs kereső-hash — DB nélküli, tiszta logikai tesztek.
 *
 * A kulcs-invariáns: a TÁROLÁSKOR és a HITELESÍTÉSKOR használt kereső-hash ugyanabból a
 * függvényből, determinisztikusan származik — különben az O(1) indexelt megkeresés nem
 * találná meg a kulcssort, és a hitelesítés csendesen elbukna. Emellett különböző kulcsok
 * NEM ütközhetnek (különben cross-agent hitelesítés lenne lehetséges).
 *
 * Futtatás: npm run test:agent-api-key-hash
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  AGENT_API_KEY_PREFIX,
  deriveAgentApiKeyLookupHash,
  isAgentApiKeyFormat,
} from '../src/lib/agent-api-key-hash'

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
    failed += 1
  }
}

check('determinisztikus: ugyanaz a kulcs mindig ugyanazt a hash-t adja', () => {
  const key = `${AGENT_API_KEY_PREFIX}0123456789abcdef0123456789abcdef`
  assert.equal(deriveAgentApiKeyLookupHash(key), deriveAgentApiKeyLookupHash(key))
})

check('a hash a nyers kulcs SHA-256 hex lenyomata (tárolás=keresés invariáns)', () => {
  const key = `${AGENT_API_KEY_PREFIX}deadbeefdeadbeefdeadbeefdeadbeef`
  const expected = createHash('sha256').update(key).digest('hex')
  assert.equal(deriveAgentApiKeyLookupHash(key), expected)
  assert.equal(expected.length, 64)
})

check('különböző kulcsok különböző hash-t adnak (nincs cross-agent ütközés)', () => {
  const a = deriveAgentApiKeyLookupHash(`${AGENT_API_KEY_PREFIX}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)
  const b = deriveAgentApiKeyLookupHash(`${AGENT_API_KEY_PREFIX}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`)
  assert.notEqual(a, b)
})

check('egy bit eltérés is teljesen más hash-t ad (lavina-hatás)', () => {
  const a = deriveAgentApiKeyLookupHash(`${AGENT_API_KEY_PREFIX}0000000000000000000000000000000`)
  const b = deriveAgentApiKeyLookupHash(`${AGENT_API_KEY_PREFIX}0000000000000000000000000000001`)
  assert.notEqual(a, b)
})

check('formátum-őr: csak a cp_sk_ előtag fogadható el', () => {
  assert.equal(isAgentApiKeyFormat(`${AGENT_API_KEY_PREFIX}abc`), true)
  assert.equal(isAgentApiKeyFormat('Bearer cp_sk_abc'), false)
  assert.equal(isAgentApiKeyFormat('sk_live_abc'), false)
  assert.equal(isAgentApiKeyFormat(''), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
