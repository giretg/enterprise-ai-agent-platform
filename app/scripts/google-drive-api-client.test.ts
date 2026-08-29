/**
 * Futtatás: GOOGLE_DRIVE_API_STUB=true npx tsx scripts/google-drive-api-client.test.ts
 */
import assert from 'node:assert/strict'
import {
  GoogleDriveApiClient,
  GoogleDriveApiError,
  isGoogleDriveTextMediaMime,
} from '../src/domain/connector-grant/google-drive-api-client'

process.env.GOOGLE_DRIVE_API_STUB = 'true'

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.error(`✗ ${name}`)
    throw e
  }
}

async function main() {
  const client = new GoogleDriveApiClient('stub-access-token')

  await test('search stub', async () => {
    const res = await client.search({ query: 'stub' })
    assert.ok(res.files.length > 0)
  })

  await test('get_file stub', async () => {
    const file = await client.getFile({ fileId: 'stub-file-1' })
    assert.equal(file.id, 'stub-file-1')
  })

  await test('read_file stub', async () => {
    const res = await client.readFile({ fileId: 'stub-file-1' })
    assert.ok(res.text?.includes('Stub tartalom'))
  })

  await test('create_folder stub', async () => {
    const res = await client.createFolder({ name: 'Teszt mappa' })
    assert.ok(res.created)
    assert.equal(res.file.mimeType, 'application/vnd.google-apps.folder')
  })

  await test('list_drives stub', async () => {
    const res = await client.listDrives({})
    assert.ok(res.drives.length > 0)
  })

  await test('text media mime allowlist', async () => {
    assert.equal(isGoogleDriveTextMediaMime('text/plain'), true)
    assert.equal(isGoogleDriveTextMediaMime('application/json'), true)
    assert.equal(isGoogleDriveTextMediaMime('text/csv; charset=utf-8'), true)
    assert.equal(
      isGoogleDriveTextMediaMime(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
      false,
    )
    assert.equal(isGoogleDriveTextMediaMime('application/vnd.google-apps.document'), false)
    assert.equal(isGoogleDriveTextMediaMime('application/pdf'), false)
    assert.equal(isGoogleDriveTextMediaMime(''), false)
  })

  await test('updateTextContent allows plain text', async () => {
    const res = await client.updateTextContent({
      fileId: 'stub-file-text',
      textContent: 'új tartalom',
    })
    assert.equal(res.conflict, false)
    assert.equal(res.file.mimeType, 'text/plain')
  })

  await test('updateTextContent rejects xlsx (binary corruption guard)', async () => {
    await assert.rejects(
      () =>
        client.updateTextContent({
          fileId: 'stub-file-2',
          textContent: 'nem szabad XLSX-et szöveggel felülírni',
        }),
      (err: unknown) =>
        err instanceof GoogleDriveApiError &&
        err.status === 415 &&
        err.code === 'UNSUPPORTED_MEDIA_TYPE',
    )
  })

  await test('updateTextContent rejects Google Docs native mime', async () => {
    await assert.rejects(
      () =>
        client.updateTextContent({
          fileId: 'stub-file-1',
          textContent: 'Docs natív MIME-ra tilos a media upload',
        }),
      (err: unknown) => err instanceof GoogleDriveApiError && err.status === 415,
    )
  })

  console.log('\nAll google-drive-api-client tests passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
