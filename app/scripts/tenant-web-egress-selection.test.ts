import assert from 'node:assert/strict'
import { selectActiveTenantWebEgress } from '../src/domain/agent-access/tenant-web-egress-selection'
import { isWebEgressAgent } from '../src/lib/platform-agent-registry'

let failures = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name}\n      ${error instanceof Error ? error.message : error}`)
  }
}

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

console.log('\nTenant Web-Egress kiválasztás')

test('a tenant saját aktív példányát választja', () => {
  const own = { id: 'own', tenantId: TENANT_A, status: 'active', systemRole: 'web_egress' }
  assert.equal(selectActiveTenantWebEgress(TENANT_A, [own]), own)
})

test('nem esik vissza másik tenant aktív Web-Egress példányára', () => {
  const foreign = { id: 'foreign', tenantId: TENANT_B, status: 'active', systemRole: 'web_egress' }
  assert.equal(selectActiveTenantWebEgress(TENANT_A, [foreign]), null)
})

test('nem esik vissza régi platform-szintű példányra sem', () => {
  const legacyPlatform = { id: 'platform', tenantId: null, status: 'active', systemRole: 'web_egress' }
  assert.equal(selectActiveTenantWebEgress(TENANT_A, [legacyPlatform]), null)
})

test('inaktív saját példány mellett is fail-closed', () => {
  const inactiveOwn = { id: 'inactive-own', tenantId: TENANT_A, status: 'suspended', systemRole: 'web_egress' }
  const foreign = { id: 'foreign', tenantId: TENANT_B, status: 'active', systemRole: 'web_egress' }
  assert.equal(selectActiveTenantWebEgress(TENANT_A, [inactiveOwn, foreign]), null)
})

test('tenant-kontextus nélkül nincs kiválasztás', () => {
  const platform = { id: 'platform', tenantId: null, status: 'active', systemRole: 'web_egress' }
  assert.equal(selectActiveTenantWebEgress(null, [platform]), null)
})

test('névazonos, de nem rendszer-szerepű agent nem Web-Egress principal', () => {
  assert.equal(isWebEgressAgent({ systemRole: null }), false)
  assert.equal(isWebEgressAgent({ systemRole: 'web_egress' }), true)
})

if (failures > 0) {
  console.error(`\n${failures} teszt elbukott.`)
  process.exitCode = 1
} else {
  console.log('\nMinden tenant Web-Egress kiválasztási teszt zöld.')
}
