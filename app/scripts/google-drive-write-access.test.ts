/**
 * Futtatás: npx tsx scripts/google-drive-write-access.test.ts
 */
import assert from 'node:assert/strict'
import type { Prisma } from '@prisma/client'
import { DRIVE_SCOPES } from '../src/domain/connector-grant/google-drive-scopes'
import {
  assertGoogleDriveWriteAccess,
  GoogleDriveWriteAccessError,
} from '../src/domain/connector-grant/google-drive-write-access'
import { emptyGoogleDriveGrantMetadata, toGoogleDriveGrantMetadataJson } from '../src/domain/connector-grant/google-drive-grant-metadata'
import { toolsRequiringConnector } from '../src/domain/tool-broker/tool-connector-requirements'
import { isSideEffectingTool } from '../src/domain/tool-broker/tool-trust-registry'

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.error(`✗ ${name}`)
    throw e
  }
}

const selectedWriteScopes = [DRIVE_SCOPES.readonly, DRIVE_SCOPES.file]
const metadataWithPicker = toGoogleDriveGrantMetadataJson({
  ...emptyGoogleDriveGrantMetadata(),
  pickerSelections: [
    {
      fileId: 'file-allowed',
      name: 'Engedélyezett doc',
      mimeType: 'application/vnd.google-apps.document',
      kind: 'file',
      selectedAt: new Date().toISOString(),
    },
    {
      fileId: 'folder-allowed',
      name: 'Engedélyezett mappa',
      mimeType: 'application/vnd.google-apps.folder',
      kind: 'folder',
      selectedAt: new Date().toISOString(),
    },
  ],
}) as Prisma.JsonValue

test('full_write: nincs manifest ellenőrzés', () => {
  assert.doesNotThrow(() =>
    assertGoogleDriveWriteAccess({
      tool: 'google_drive_update_file',
      args: { fileId: 'any-file' },
      scopes: [DRIVE_SCOPES.full],
      metadata: emptyGoogleDriveGrantMetadata(),
    }),
  )
})

test('selected_write: picker fájl ALLOW', () => {
  assert.doesNotThrow(() =>
    assertGoogleDriveWriteAccess({
      tool: 'google_docs_apply_edits',
      args: { fileId: 'file-allowed' },
      scopes: selectedWriteScopes,
      metadata: metadataWithPicker,
    }),
  )
})

test('selected_write: nem kiválasztott fájl DENY', () => {
  assert.throws(
    () =>
      assertGoogleDriveWriteAccess({
        tool: 'google_sheets_write_range',
        args: { fileId: 'file-denied' },
        scopes: selectedWriteScopes,
        metadata: metadataWithPicker,
      }),
    (error: unknown) => error instanceof GoogleDriveWriteAccessError,
  )
})

test('selected_write: create_folder engedélyezett szülő ALLOW', () => {
  assert.doesNotThrow(() =>
    assertGoogleDriveWriteAccess({
      tool: 'google_drive_create_folder',
      args: { name: 'Új', parentFolderId: 'folder-allowed' },
      scopes: selectedWriteScopes,
      metadata: metadataWithPicker,
    }),
  )
})

test('selected_write: create_folder tiltott szülő DENY', () => {
  assert.throws(() =>
    assertGoogleDriveWriteAccess({
      tool: 'google_drive_create_folder',
      args: { name: 'Új', parentFolderId: 'folder-denied' },
      scopes: selectedWriteScopes,
      metadata: metadataWithPicker,
    }),
  )
})

test('fail-closed: hiányzó parentFolderId → DENY (ne írjon Drive rootba)', () => {
  for (const tool of [
    'google_drive_create_folder',
    'google_drive_upload_file',
    'google_drive_copy_file',
  ]) {
    assert.throws(
      () =>
        assertGoogleDriveWriteAccess({
          tool,
          args: { name: 'x', fileId: 'file-allowed' },
          scopes: selectedWriteScopes,
          metadata: metadataWithPicker,
        }),
      (error: unknown) => error instanceof GoogleDriveWriteAccessError,
      `${tool} parent nélkül a Drive rootba kerülne`,
    )
  }
})

test('fail-closed: hiányzó destinationFolderId → DENY (move)', () => {
  assert.throws(
    () =>
      assertGoogleDriveWriteAccess({
        tool: 'google_drive_move_file',
        args: { fileId: 'file-allowed' },
        scopes: selectedWriteScopes,
        metadata: metadataWithPicker,
      }),
    (error: unknown) => error instanceof GoogleDriveWriteAccessError,
  )
})

test('fail-closed: hiányzó fileId → DENY (nem csúszhat át a share_file sem)', () => {
  for (const tool of ['google_drive_share_file', 'google_drive_update_file', 'google_drive_move_file']) {
    assert.throws(
      () =>
        assertGoogleDriveWriteAccess({
          tool,
          args: {},
          scopes: selectedWriteScopes,
          metadata: metadataWithPicker,
        }),
      (error: unknown) => error instanceof GoogleDriveWriteAccessError,
      `${tool} hiányzó fileId mellett is elutasítandó`,
    )
  }
})

// Drift-őr (a registry-allowlist helyett): MINDEN mellékhatásos Google Drive
// eszközt ténylegesen kapuz-e a manifeszt selected_write alatt? Ha valaki új
// írástoolt vesz fel a regiszterbe, de kihagyja a write-access kezelt halmazából,
// ez a teszt bukik — így a manifeszt-kapu nem tud némán fail-open irányba sodródni.
test('drift: minden mellékhatásos Drive-tool manifeszt-kapuzott', () => {
  const driveWriteTools = toolsRequiringConnector('google_drive').filter(isSideEffectingTool)
  assert.ok(driveWriteTools.length >= 10, 'a Drive írástoolok listája nem lehet üres')
  const notInManifest = {
    fileId: 'ZZZ-not-in-manifest',
    parentFolderId: 'ZZZ-not-in-manifest',
    destinationFolderId: 'ZZZ-not-in-manifest',
  }
  for (const tool of driveWriteTools) {
    assert.throws(
      () =>
        assertGoogleDriveWriteAccess({
          tool,
          args: notInManifest,
          scopes: selectedWriteScopes,
          metadata: metadataWithPicker,
        }),
      (error: unknown) => error instanceof GoogleDriveWriteAccessError,
      `${tool} nincs manifeszt-kapuzva — vedd fel a write-access kezelésébe`,
    )
  }
})

console.log('\nAll google-drive-write-access tests passed.')
