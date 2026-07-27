import assert from 'node:assert/strict'
import {
  isConnectorOwnedSecretRef,
  isTrustedExternalConnectorSecretAlias,
  parseTrustedConnectorSecretAliasPolicy,
} from '../src/domain/provisioning/connector-secret-alias-policy'

let failures = 0

function test(name: string, run: () => void) {
  try {
    run()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('Connector secret-alias policy\n')

test('a tenant csak a saját, pontosan engedélyezett aliasát használhatja', () => {
  const policy = parseTrustedConnectorSecretAliasPolicy(
    '{"tenant-a":["env:TENANT_A_CRM_KEY"],"tenant-b":["secret-manager:projects/p/secrets/b-key"]}',
  )
  assert.equal(isTrustedExternalConnectorSecretAlias('env:TENANT_A_CRM_KEY', 'tenant-a', policy), true)
  assert.equal(isTrustedExternalConnectorSecretAlias('env:TENANT_A_CRM_KEY', 'tenant-b', policy), false)
  assert.equal(isTrustedExternalConnectorSecretAlias('env:WRITE_GATE_SECRET', 'tenant-a', policy), false)
})

test('a platform-alias nem öröklődik tenantba', () => {
  const policy = parseTrustedConnectorSecretAliasPolicy(
    '{"__platform__":["secret-manager:projects/p/secrets/platform-key"]}',
  )
  assert.equal(
    isTrustedExternalConnectorSecretAlias(
      'secret-manager:projects/p/secrets/platform-key',
      null,
      policy,
    ),
    true,
  )
  assert.equal(
    isTrustedExternalConnectorSecretAlias(
      'secret-manager:projects/p/secrets/platform-key',
      'tenant-a',
      policy,
    ),
    false,
  )
})

test('hibás vagy hiányzó konfiguráció fail-closed', () => {
  assert.deepEqual(parseTrustedConnectorSecretAliasPolicy(undefined), {})
  assert.deepEqual(parseTrustedConnectorSecretAliasPolicy('{not-json'), {})
  assert.equal(
    isTrustedExternalConnectorSecretAlias('env:ANYTHING', 'tenant-a', {}),
    false,
  )
})

test('connector-owned secret-ref nem helyettesíthető idegen connectoréval', () => {
  assert.equal(isConnectorOwnedSecretRef('secret-ref:connector-a', 'connector-a'), true)
  assert.equal(isConnectorOwnedSecretRef('secret-ref:connector-b', 'connector-a'), false)
  assert.equal(isConnectorOwnedSecretRef('secret-ref:connector-a-extra', 'connector-a'), false)
})

if (failures > 0) process.exit(1)
console.log('\nAll connector secret-alias policy tests passed.')
