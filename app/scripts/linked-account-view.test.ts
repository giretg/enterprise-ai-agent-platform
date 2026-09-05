import assert from 'node:assert/strict'
import {
  connectorUsageStatus,
  providerVisual,
} from '../src/components/account/linked-account-view'

assert.deepEqual(connectorUsageStatus({ assignedAgentCount: 0, capableAgentCount: 0 }), {
  usable: false,
  text: 'A fiók össze van kötve, de még nincs agenthez rendelve.',
})
assert.equal(
  connectorUsageStatus({ assignedAgentCount: 2, capableAgentCount: 0 }).usable,
  false,
)
assert.equal(
  connectorUsageStatus({ assignedAgentCount: 2, capableAgentCount: 1 }).usable,
  true,
)
assert.equal(
  connectorUsageStatus({
    assignedAgentCount: 2,
    capableAgentCount: 1,
    capableAgentDisplayNames: ['Bori'],
  }).text,
  'Bori rendelkezik a szükséges eszközjoggal.',
)
assert.equal(
  connectorUsageStatus({
    assignedAgentCount: 3,
    capableAgentCount: 2,
    capableAgentDisplayNames: ['Bori', 'Dóra'],
  }).text,
  'Bori és Dóra rendelkeznek a szükséges eszközjoggal.',
)
assert.equal(providerVisual('gmail'), 'gmail')
assert.equal(providerVisual('google_drive'), 'google_drive')
assert.equal(providerVisual('google-drive'), 'google_drive')
assert.notEqual(providerVisual('google_drive'), providerVisual('gmail'))

console.log('✅ Kapcsolt fiók használhatóság és provider-vizuál rendben')
