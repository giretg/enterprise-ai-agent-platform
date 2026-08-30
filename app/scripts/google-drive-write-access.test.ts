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

console.log('\nAll google-drive-write-access tests passed.')
