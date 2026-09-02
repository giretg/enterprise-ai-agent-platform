/**
 * Google Drive grant metadata CAS — párhuzamos RMW ne veszítsen írást.
 * Futtatás: npm run test:google-drive-grant-metadata-cas
 */
import assert from 'node:assert/strict'
import type { Prisma } from '@prisma/client'
import {
  parseGoogleDriveGrantMetadata,
  removePickerSelection,
  toGoogleDriveGrantMetadataJson,
  trackAppCreatedFile,
  type GoogleDriveGrantMetadata,
} from '../src/domain/connector-grant/google-drive-grant-metadata'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** A store CAS-hurkának tükörképe — DB nélkül, in-memory equals. */
async function updateWithCas(
  store: { metadata: Prisma.JsonValue },
  updater: (current: GoogleDriveGrantMetadata) => GoogleDriveGrantMetadata,
  attempts = 8,
): Promise<GoogleDriveGrantMetadata> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const currentMeta = store.metadata
    const current = parseGoogleDriveGrantMetadata(currentMeta)
    const next = updater(current)
    const nextJson = toGoogleDriveGrantMetadataJson(next)
    if (JSON.stringify(currentMeta ?? null) === JSON.stringify(nextJson ?? null)) return next
    // Szimulált konkurens írás az első kísérletnél: a CAS elbukik, újraolvasás kell.
    if (attempt === 0 && store._injectConflict) {
      store.metadata = store._injectConflict
      store._injectConflict = null
      continue
    }
    if (JSON.stringify(store.metadata ?? null) !== JSON.stringify(currentMeta ?? null)) {
      continue
    }
    store.metadata = nextJson
    return next
  }
  throw new Error('conflict')
}

async function main() {
  console.log('Google Drive grant metadata CAS\n')

  await test('párhuzamos remove + appCreated: mindkét írás megmarad', async () => {
    const initial = toGoogleDriveGrantMetadataJson({
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
    })
    const store: {
      metadata: Prisma.JsonValue
      _injectConflict: Prisma.JsonValue | null
    } = { metadata: initial, _injectConflict: null }

    // A „másik" írás (app create) közben fut: a remove első CAS-kísérlete elbukik.
    store._injectConflict = toGoogleDriveGrantMetadataJson(
      trackAppCreatedFile(parseGoogleDriveGrantMetadata(initial), {
        fileId: 'file-new',
        name: 'új.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    )

    const afterRemove = await updateWithCas(store, (current) =>
      removePickerSelection(current, 'file-revoke'),
    )

    assert.equal(afterRemove.pickerSelections.some((s) => s.fileId === 'file-revoke'), false)
    assert.equal(afterRemove.appCreated.some((s) => s.fileId === 'file-new'), true)

    const writable = new Set([
      ...afterRemove.pickerSelections.map((s) => s.fileId),
      ...afterRemove.appCreated.map((s) => s.fileId),
    ])
    assert.equal(writable.has('file-revoke'), false, 'visszavont fájl ne maradjon írható')
    assert.equal(writable.has('file-new'), true)
  })

  await test('vesztes RMW (CAS nélkül) visszaállítaná a revoked picker entry-t', () => {
    const base = parseGoogleDriveGrantMetadata(
      toGoogleDriveGrantMetadataJson({
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
      }),
    )
    const removed = removePickerSelection(base, 'file-revoke')
    const createdOnStale = trackAppCreatedFile(base, {
      fileId: 'file-new',
      name: 'új.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    // Stale write wins: revoked file returns.
    assert.equal(createdOnStale.pickerSelections.some((s) => s.fileId === 'file-revoke'), true)
    assert.equal(removed.pickerSelections.some((s) => s.fileId === 'file-revoke'), false)
  })

  console.log(failures === 0 ? '\nMinden teszt zöld.' : `\n${failures} hiba.`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
