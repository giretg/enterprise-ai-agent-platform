/**
 * GCS WorkspaceStorage.list() lapozás — >1000 objektum esetén a nextPageToken
 * nélkül a lista csonka maradna, és a repo_open_pull_request a hiányzó fájlokat
 * törlésnek venné (hallgatólagos adatvesztés a PR-ben).
 *
 * Run: npm run test:workspace-gcs-list
 */
import assert from 'node:assert/strict'
import { WorkspaceStorage } from '../src/domain/file-editor/workspace-storage'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures++
    console.error(`  ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('WorkspaceStorage GCS list pagination')

await test('követi a nextPageToken-t és az összes objektumot visszaadja', async () => {
  const prevStub = process.env.FILE_EDITOR_STUB
  const prevMemory = process.env.FILE_EDITOR_STUB_MEMORY
  delete process.env.FILE_EDITOR_STUB
  delete process.env.FILE_EDITOR_STUB_MEMORY

  const originalFetch = globalThis.fetch
  const listCalls: string[] = []

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('metadata.google.internal') && url.includes('/token')) {
      return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 })
    }
    if (url.includes('storage.googleapis.com/storage/v1/b/test-bucket/o?')) {
      listCalls.push(url)
      const parsed = new URL(url)
      const pageToken = parsed.searchParams.get('pageToken')
      if (!pageToken) {
        return new Response(
          JSON.stringify({
            items: [
              { name: 'tenant-a/ticket-a/repo/a.ts' },
              { name: 'tenant-a/ticket-a/repo/b.ts' },
            ],
            nextPageToken: 'page-2',
          }),
          { status: 200 },
        )
      }
      if (pageToken === 'page-2') {
        return new Response(
          JSON.stringify({
            items: [
              { name: 'tenant-a/ticket-a/repo/c.ts' },
              { name: 'tenant-a/ticket-a/repo/z-deep/nested.ts' },
            ],
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected pageToken: ${pageToken}`)
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  try {
    const storage = new WorkspaceStorage('test-bucket')
    const files = await storage.list('tenant-a', 'ticket-a', 'repo')
    assert.deepEqual(files, [
      'repo/a.ts',
      'repo/b.ts',
      'repo/c.ts',
      'repo/z-deep/nested.ts',
    ])
    assert.equal(listCalls.length, 2)
    assert.match(listCalls[0]!, /maxResults=1000/)
    assert.doesNotMatch(listCalls[0]!, /pageToken=/)
    assert.match(listCalls[1]!, /pageToken=page-2/)
  } finally {
    globalThis.fetch = originalFetch
    if (prevStub === undefined) delete process.env.FILE_EDITOR_STUB
    else process.env.FILE_EDITOR_STUB = prevStub
    if (prevMemory === undefined) delete process.env.FILE_EDITOR_STUB_MEMORY
    else process.env.FILE_EDITOR_STUB_MEMORY = prevMemory
  }
})

await test('HTTP hiba a listánál hangosan bukik (nem ad vissza csonka listát)', async () => {
  const prevStub = process.env.FILE_EDITOR_STUB
  const prevMemory = process.env.FILE_EDITOR_STUB_MEMORY
  delete process.env.FILE_EDITOR_STUB
  delete process.env.FILE_EDITOR_STUB_MEMORY

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('metadata.google.internal') && url.includes('/token')) {
      return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 })
    }
    if (url.includes('storage.googleapis.com/storage/v1/b/test-bucket/o?')) {
      return new Response('boom', { status: 503 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  try {
    const storage = new WorkspaceStorage('test-bucket')
    await assert.rejects(() => storage.list('tenant-a', 'ticket-a'), /GCS list failed: HTTP 503/)
  } finally {
    globalThis.fetch = originalFetch
    if (prevStub === undefined) delete process.env.FILE_EDITOR_STUB
    else process.env.FILE_EDITOR_STUB = prevStub
    if (prevMemory === undefined) delete process.env.FILE_EDITOR_STUB_MEMORY
    else process.env.FILE_EDITOR_STUB_MEMORY = prevMemory
  }
})

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nworkspace GCS list tests passed')
