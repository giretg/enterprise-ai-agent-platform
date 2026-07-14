/**
 * Unit tesztek a provisioning-asszisztens emberi hibaüzenet-formázójához.
 * Futtatás: npm run test:provisioning-errors
 */
import assert from 'node:assert/strict'
import { formatProvisioningAssistantError } from '../src/domain/provisioning/provisioning-assistant-errors'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures++
    console.error(`  ✗ ${name}`)
    console.error(e)
  }
}

check('schema mismatch: magyar, következő lépéssel, nincs PARSE_FAILED', () => {
  const msg = formatProvisioningAssistantError('PARSE_FAILED', 'schema mismatch', 'doc')
  assert.match(msg, /nem felel meg a várt connector-sémának/i)
  assert.match(msg, /Következő lépés:/)
  assert.doesNotMatch(msg, /PARSE_FAILED/)
})

check('discover + NO_TRUSTED_SOURCE: domain vagy kézi doksi', () => {
  const msg = formatProvisioningAssistantError(
    'NO_TRUSTED_SOURCE',
    'no official/vendor_doc source found',
    'discover',
  )
  assert.match(msg, /ismert API-doksi domain/i)
  assert.match(msg, /API-doksi/i)
})

check('fetch + INVALID_URL https', () => {
  const msg = formatProvisioningAssistantError('INVALID_URL', 'only https urls are allowed', 'fetch')
  assert.match(msg, /https/i)
  assert.match(msg, /openapi/i)
})

check('DISCOVERY_DISABLED flag off', () => {
  const msg = formatProvisioningAssistantError('DISCOVERY_DISABLED', 'web_discovery flag off')
  assert.match(msg, /ki van kapcsolva/i)
  assert.match(msg, /web_discovery/i)
})

if (failures > 0) {
  console.error(`\n${failures} hiba`)
  process.exit(1)
}
console.log('\nMinden teszt sikeres.')
