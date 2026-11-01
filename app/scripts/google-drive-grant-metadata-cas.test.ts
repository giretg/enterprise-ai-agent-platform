/**
 * Drive grant-metadata: párhuzamos Picker-visszavonás + app-létrehozott fájl
 * rögzítése ne veszítsen írást (compare-and-swap).
 * Futtatás: npm run test:google-drive-grant-metadata-cas
 */
import assert from 'node:assert/strict'
import type { ConnectorGrant, Prisma } from '@prisma/client'
import { repositories } from '../src/repositories/postgres'
import {
  readGoogleDriveGrantMetadata,
  recordGoogleDriveAppCreatedFile,
  removeGoogleDrivePickerSelection,
} from '../src/domain/connector-grant/google-drive-grant-store'
import { toGoogleDriveGrantMetadataJson } from '../src/domain/connector-grant/google-drive-grant-metadata'

let stored: Prisma.JsonValue = toGoogleDriveGrantMetadataJson({
  pickerSelections: [
    {
      fileId: 'file-revoke',
      name: 'titkos.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      kind: 'file',
      selectedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  appCreated: [],
}) as Prisma.JsonValue

// In-memory repó; az olvasás után átadjuk a vezérlést, hogy a két írás
// ugyanazt az alapállapotot lássa (ez a versenyhelyzet).
const tick = () => new Promise((resolve) => setImmediate(resolve))
Object.assign(repositories.connectorGrants, {
  findById: async (id: string) => {
    const snapshot = { id, metadata: structuredClone(stored) } as unknown as ConnectorGrant
    await tick()
    return snapshot
  },
  updateMetadataIfMatch: async (_id: string, expected: Prisma.InputJsonValue, next: Prisma.InputJsonValue) => {
    if (JSON.stringify(expected) !== JSON.stringify(stored)) return false
    stored = next as Prisma.JsonValue
    return true
  },
})

async function main() {
  await Promise.all([
    removeGoogleDrivePickerSelection({ grantId: 'grant-1', fileId: 'file-revoke' }),
    recordGoogleDriveAppCreatedFile({
      grantId: 'grant-1',
      fileId: 'file-new',
      name: 'új.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
  ])
  const after = await readGoogleDriveGrantMetadata('grant-1')
  assert.equal(
    after.pickerSelections.some((entry) => entry.fileId === 'file-revoke'),
    false,
    'a visszavont fájl nem válhat újra írhatóvá',
  )
  assert.equal(
    after.appCreated.some((entry) => entry.fileId === 'file-new'),
    true,
    'az app által létrehozott fájl nem veszhet el',
  )
  console.log('  OK  párhuzamos visszavonás + app-létrehozás: mindkét írás megmarad')
  console.log('\nAll google-drive-grant-metadata-cas tests passed.')
}

main().catch((error) => {
  console.error('  FAIL', error)
  process.exit(1)
})
