/**
 * Futtatás: npx tsx scripts/google-drive-scopes.test.ts
 */
import assert from 'node:assert/strict'
import {
  DRIVE_SCOPES,
  driveScopeProfile,
  driveToolAllowedByScopes,
  normalizeDriveScope,
} from '../src/domain/connector-grant/google-drive-scopes'
import { registeredDelegatedProviderTypes } from '../src/domain/connector-grant/delegated-oauth-registry'
import { toolsRequiringConnector } from '../src/domain/tool-broker/tool-connector-requirements'

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.error(`✗ ${name}`)
    throw e
  }
}

test('normalizeDriveScope alias feloldás', () => {
  assert.equal(normalizeDriveScope('drive.readonly'), DRIVE_SCOPES.readonly)
  assert.equal(normalizeDriveScope('drive.file'), DRIVE_SCOPES.file)
})

test('readonly grant: olvasás ALLOW, írás DENY', () => {
  const scopes = [DRIVE_SCOPES.readonly]
  assert.equal(driveToolAllowedByScopes({ tool: 'google_drive_search', scopes }), true)
  assert.equal(driveToolAllowedByScopes({ tool: 'google_drive_read_file', scopes }), true)
  assert.equal(driveToolAllowedByScopes({ tool: 'google_drive_create_folder', scopes }), false)
})

test('metadata.readonly grant: tartalomolvasás DENY', () => {
  const scopes = [DRIVE_SCOPES.metadataReadonly]
  assert.equal(driveToolAllowedByScopes({ tool: 'google_drive_read_file', scopes }), false)
})

test('selected-write grant: írás ALLOW', () => {
  const scopes = [DRIVE_SCOPES.readonly, DRIVE_SCOPES.file]
  assert.equal(driveToolAllowedByScopes({ tool: 'google_drive_create_folder', scopes }), true)
  assert.equal(driveScopeProfile(scopes), 'selected_write')
})

test('full drive grant: full_write profil', () => {
  const scopes = [DRIVE_SCOPES.full]
  assert.equal(driveScopeProfile(scopes), 'full_write')
  assert.equal(driveToolAllowedByScopes({ tool: 'google_drive_trash_file', scopes }), true)
})

test('google_drive provider regisztrálva', () => {
  assert.ok(registeredDelegatedProviderTypes().includes('google_drive'))
  const tools = toolsRequiringConnector('google_drive')
  assert.ok(tools.includes('google_drive_search'))
  assert.ok(tools.includes('google_drive_share_file'))
})

console.log('\nAll google-drive-scopes tests passed.')
