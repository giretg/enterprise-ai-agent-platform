/**
 * Önfrissítő / http_api connector kulcs-csere: create és rotate ugyanazt a
 * secret-ref:<connectorId> slotot használja, így a feloldás mindig a legutóbb
 * mentett kulcsot adja vissza.
 *
 * FIGYELEM: a „régi kulcs eltűnik" csak a dev fájl-tárolóra igaz, mert az felülírja
 * a fájlt. Prodban a Secret Manager ág `addVersion`-t hív: a futás mindig a `latest`
 * verziót olvassa, de a KORÁBBI verzió engedélyezve marad a titok történetében.
 * A régi verziók tiltása/megsemmisítése külön (IAM-jogot igénylő) feladat.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildConnectorSecretRef,
  loadConnectorApiKeyByRef,
  saveConnectorApiKey,
} from '../src/domain/connector/connector-secret-store'
import { isConnectorOwnedSecretRef } from '../src/domain/provisioning/connector-secret-alias-policy'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'

let failures = 0

async function test(name: string, run: () => Promise<void>) {
  try {
    await run()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main() {
  console.log('Connector API key rotate\n')

  await test('rotáció ugyanarra a connectorId-re ír, a feloldás a friss kulcsot adja', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'connector-key-rotate-'))
    const previousDir = process.env.CONNECTOR_SECRET_DIR
    const previousPrefix = process.env.CONNECTOR_SECRET_PREFIX
    process.env.CONNECTOR_SECRET_DIR = dir
    delete process.env.CONNECTOR_SECRET_PREFIX
    try {
      const connectorId = '00000000-0000-0000-0000-000000000abc'
      const alias = buildConnectorSecretRef(connectorId)
      assert.equal(isConnectorOwnedSecretRef(alias, connectorId), true)

      await saveConnectorApiKey(connectorId, 'old-partner-key')
      assert.equal(await loadConnectorApiKeyByRef(alias), 'old-partner-key')

      await saveConnectorApiKey(connectorId, 'new-partner-key')
      assert.equal(await loadConnectorApiKeyByRef(alias), 'new-partner-key')
    } finally {
      if (previousDir === undefined) delete process.env.CONNECTOR_SECRET_DIR
      else process.env.CONNECTOR_SECRET_DIR = previousDir
      if (previousPrefix === undefined) delete process.env.CONNECTOR_SECRET_PREFIX
      else process.env.CONNECTOR_SECRET_PREFIX = previousPrefix
      await rm(dir, { recursive: true, force: true })
    }
  })

  await test('a rotáció csak a SAJÁT slotra kötheti át az aliast, idegen connectorére nem', async () => {
    const connectorId = '00000000-0000-0000-0000-00000000a001'
    const foreignId = '00000000-0000-0000-0000-00000000a002'
    assert.equal(isConnectorOwnedSecretRef(buildConnectorSecretRef(connectorId), connectorId), true)
    assert.equal(isConnectorOwnedSecretRef(buildConnectorSecretRef(foreignId), connectorId), false)
    assert.equal(isConnectorOwnedSecretRef('env:SHARED_PARTNER_KEY', connectorId), false)
  })

  await test('üres kulcs mentése elutasítva', async () => {
    await assert.rejects(
      () => saveConnectorApiKey('00000000-0000-0000-0000-000000000def', '   '),
      /API key must not be empty/,
    )
  })

  await test('rotate audit action regisztrálva', async () => {
    assert.doesNotThrow(() => assertAuditActionRegistered('connector.self_update.api_key.rotate'))
  })

  if (failures > 0) process.exit(1)
  console.log('\nAll connector API key rotate tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
