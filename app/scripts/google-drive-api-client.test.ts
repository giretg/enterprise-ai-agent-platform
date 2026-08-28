/**
 * Futtatás: GOOGLE_DRIVE_API_STUB=true npx tsx scripts/google-drive-api-client.test.ts
 */
import assert from 'node:assert/strict'
import { GoogleDriveApiClient } from '../src/domain/connector-grant/google-drive-api-client'

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

  await test('update_file conflict when expectedModifiedTime mismatches', async () => {
    const existing = await client.getFile({ fileId: 'stub-file-1' })
    const res = await client.updateTextContent({
      fileId: 'stub-file-1',
      textContent: 'új',
      expectedModifiedTime: '1999-01-01T00:00:00.000Z',
    })
    assert.equal(res.conflict, true)
    assert.equal(res.file.id, existing.id)
  })

  await test('move_file removes all parents (not only parents[0])', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.includes('/files/multi-parent') && !url.includes('addParents') && init?.method !== 'PATCH') {
        return new Response(
          JSON.stringify({
            id: 'multi-parent',
            name: 'doc',
            mimeType: 'text/plain',
            parents: ['parent-a', 'parent-b'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (init?.method === 'PATCH') {
        return new Response(
          JSON.stringify({
            id: 'multi-parent',
            name: 'doc',
            mimeType: 'text/plain',
            parents: ['parent-c'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('unexpected', { status: 500 })
    }) as typeof fetch

    try {
      process.env.GOOGLE_DRIVE_API_STUB = 'false'
      const live = new GoogleDriveApiClient('ya29.live-test-token')
      const moved = await live.moveFile({ fileId: 'multi-parent', destinationFolderId: 'parent-c' })
      assert.equal(moved.id, 'multi-parent')
      const patch = calls.find((c) => c.init?.method === 'PATCH')
      assert.ok(patch, 'expected PATCH move call')
      const u = new URL(patch!.url)
      assert.equal(u.searchParams.get('addParents'), 'parent-c')
      const removed = (u.searchParams.get('removeParents') ?? '').split(',').sort()
      assert.deepEqual(removed, ['parent-a', 'parent-b'])
    } finally {
      globalThis.fetch = originalFetch
      process.env.GOOGLE_DRIVE_API_STUB = 'true'
    }
  })

  console.log('\nAll google-drive-api-client tests passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
