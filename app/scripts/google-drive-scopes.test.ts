/**
 * Futtatás: npx tsx scripts/google-drive-scopes.test.ts
 */
import assert from 'node:assert/strict'
import {
  DRIVE_SCOPES,
  driveScopeProfile,
  driveScopeProfileRequiresAdmin,
  driveToolAllowedByScopes,
  driveToolMinimalScopes,
  normalizeDriveScope,
} from '../src/domain/connector-grant/google-drive-scopes'
import {
  registeredDelegatedProviderTypes,
  resolveGrantOAuthScopes,
} from '../src/domain/connector-grant/delegated-oauth-registry'
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

test('driveToolMinimalScopes: least-privilege, teljes drive SOHA', () => {
  // Regresszió: a tool-vezérelt grant NEM kérheti a teljes `drive` scope-ot —
  // sem olvasáshoz, sem íráshoz. Olvasás → readonly, írás → file (selected_write).
  // Olvasás → readonly; írás → selected_write pár (readonly + file), mert a
  // `drive.file` önmagában nem ad teljes keresést/olvasást.
  assert.deepEqual(driveToolMinimalScopes('google_drive_read_file'), [DRIVE_SCOPES.readonly])
  assert.deepEqual(driveToolMinimalScopes('google_drive_update_file'), [
    DRIVE_SCOPES.readonly,
    DRIVE_SCOPES.file,
  ])
  assert.deepEqual(driveToolMinimalScopes('google_drive_share_file'), [
    DRIVE_SCOPES.readonly,
    DRIVE_SCOPES.file,
  ])
  // A teljes `drive` scope SOHA nem szerepel egy tool minimum-igényében.
  for (const tool of ['google_drive_read_file', 'google_drive_update_file', 'google_drive_share_file']) {
    assert.ok(!driveToolMinimalScopes(tool).includes(DRIVE_SCOPES.full))
  }
})

test('resolveGrantOAuthScopes: seed-config mellett sem eszkalál full_write-ra', () => {
  // A seed Drive connector configja mindhárom scope-ot listázza (readonly/file/full).
  // A tool-vezérelt „Hozzáférés megadása" korábban ilyenkor full_write-ot kért még
  // egy sima olvasásnál is — ez most nem fordulhat elő.
  const config = {
    oauth: {
      scopes: [DRIVE_SCOPES.readonly, DRIVE_SCOPES.file, DRIVE_SCOPES.full, 'openid', DRIVE_SCOPES.email],
    },
  }
  const readScopes = resolveGrantOAuthScopes({
    connectorType: 'google_drive',
    config,
    toolName: 'google_drive_read_file',
  })
  assert.equal(driveScopeProfile(readScopes), 'readonly')

  const writeScopes = resolveGrantOAuthScopes({
    connectorType: 'google_drive',
    config,
    toolName: 'google_drive_update_file',
  })
  assert.equal(driveScopeProfile(writeScopes), 'selected_write')

  const shareScopes = resolveGrantOAuthScopes({
    connectorType: 'google_drive',
    config,
    toolName: 'google_drive_share_file',
  })
  assert.equal(driveScopeProfile(shareScopes), 'selected_write')
})

test('driveScopeProfileRequiresAdmin: csak a full_write admin-only', () => {
  assert.equal(driveScopeProfileRequiresAdmin([DRIVE_SCOPES.full]), true)
  assert.equal(driveScopeProfileRequiresAdmin([DRIVE_SCOPES.readonly, DRIVE_SCOPES.file]), false)
  assert.equal(driveScopeProfileRequiresAdmin([DRIVE_SCOPES.readonly]), false)
  assert.equal(driveScopeProfileRequiresAdmin([]), false)
})

test('google_drive provider regisztrálva', () => {
  assert.ok(registeredDelegatedProviderTypes().includes('google_drive'))
  const tools = toolsRequiringConnector('google_drive')
  assert.ok(tools.includes('google_drive_search'))
  assert.ok(tools.includes('google_drive_share_file'))
})

console.log('\nAll google-drive-scopes tests passed.')
