/**
 * Futtatás: npx tsx scripts/google-drive-scopes.test.ts
 */
import assert from 'node:assert/strict'
import {
  DRIVE_SCOPES,
  clampDriveGrantedScopesToRequest,
  driveScopeProfile,
  driveScopeProfileRequiresAdmin,
  driveToolAllowedByScopes,
  driveToolMinimalScopes,
  mergeDriveGrantScopes,
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

test('resolveGrantOAuthScopes: tool nélküli default = config (full_write) — üres tömb NEM helyettesíti', () => {
  // startConnectorOAuth admin-kapu: ha nincs scopes/toolName, a tényleges OAuth
  // a teljes configot kéri. `driveScopeProfileRequiresAdmin([])` false lenne —
  // a kapunak a feloldott config-listát kell néznie, nem az üres fallbackot.
  const config = {
    oauth: {
      scopes: [DRIVE_SCOPES.readonly, DRIVE_SCOPES.file, DRIVE_SCOPES.full],
    },
  }
  const defaults = resolveGrantOAuthScopes({ connectorType: 'google_drive', config })
  assert.equal(driveScopeProfile(defaults), 'full_write')
  assert.equal(driveScopeProfileRequiresAdmin(defaults), true)
  assert.equal(driveScopeProfileRequiresAdmin([]), false)
})

test('driveScopeProfileRequiresAdmin: csak a full_write admin-only', () => {
  assert.equal(driveScopeProfileRequiresAdmin([DRIVE_SCOPES.full]), true)
  assert.equal(driveScopeProfileRequiresAdmin([DRIVE_SCOPES.readonly, DRIVE_SCOPES.file]), false)
  assert.equal(driveScopeProfileRequiresAdmin([DRIVE_SCOPES.readonly]), false)
  assert.equal(driveScopeProfileRequiresAdmin([]), false)
})

test('clampDriveGrantedScopesToRequest: include_granted full drive nem szélesít', () => {
  // Google include_granted_scopes visszahozhatja a teljes `drive`-ot egy
  // selected_write kérés mellé — a grant-rekordot a kért scope-okra szűkítjük.
  const clamped = clampDriveGrantedScopesToRequest({
    expectedScopes: [DRIVE_SCOPES.readonly, DRIVE_SCOPES.file],
    grantedScopes: [DRIVE_SCOPES.readonly, DRIVE_SCOPES.file, DRIVE_SCOPES.full],
  })
  assert.deepEqual(clamped.sort(), [DRIVE_SCOPES.file, DRIVE_SCOPES.readonly].sort())
  assert.equal(driveScopeProfile(clamped), 'selected_write')
})

test('mergeDriveGrantScopes: selected_write kérés nem örökít full_write-ot', () => {
  const merged = mergeDriveGrantScopes({
    existingScopes: [DRIVE_SCOPES.full],
    newScopes: [DRIVE_SCOPES.readonly, DRIVE_SCOPES.file],
    requestedScopes: [DRIVE_SCOPES.readonly, DRIVE_SCOPES.file],
  })
  assert.ok(!merged.includes(DRIVE_SCOPES.full))
  assert.equal(driveScopeProfile(merged), 'selected_write')
})

test('mergeDriveGrantScopes: explicit full_write kérés megtartja a full scope-ot', () => {
  const merged = mergeDriveGrantScopes({
    existingScopes: [DRIVE_SCOPES.readonly],
    newScopes: [DRIVE_SCOPES.full],
    requestedScopes: [DRIVE_SCOPES.openid, DRIVE_SCOPES.email, DRIVE_SCOPES.full],
  })
  assert.ok(merged.includes(DRIVE_SCOPES.full))
  assert.equal(driveScopeProfile(merged), 'full_write')
})

test('google_drive provider regisztrálva', () => {
  assert.ok(registeredDelegatedProviderTypes().includes('google_drive'))
  const tools = toolsRequiringConnector('google_drive')
  assert.ok(tools.includes('google_drive_search'))
  assert.ok(tools.includes('google_drive_share_file'))
})

console.log('\nAll google-drive-scopes tests passed.')
