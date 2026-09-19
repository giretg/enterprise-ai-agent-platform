/**
 * A Konnektorok varázsló LLM-felfedezés és sandbox nélkül jött vissza.
 * Futtatás: npx tsx scripts/connector-manager-wizard.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const panel = readFileSync(resolve(root, 'src/app/control-plane/provisioning/provisioning-panel.tsx'), 'utf8')
const actions = readFileSync(resolve(root, 'src/app/actions/provisioning.ts'), 'utf8')

assert.match(panel, /createStep === 'basics'/)
assert.match(panel, /connectionKind === 'self_updating'/)
assert.match(panel, /draftConfigFromOpenApi/)
assert.doesNotMatch(panel, /az asszisztens LLM-et/)
assert.doesNotMatch(panel, /discoverConnectorFromName/)
assert.doesNotMatch(panel, /CodeSandboxConnectorForm/)
assert.doesNotMatch(panel, /sourceMethod === 'discover'/)
assert.match(actions, /tryExtractConnectorConfigFromOpenApiAsync/)
assert.doesNotMatch(actions, /provisioningAssistant/)
assert.match(panel, /confirmDialog/)

console.log('connector-manager-wizard teszt zöld')
