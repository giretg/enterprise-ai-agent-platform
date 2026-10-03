/**
 * Futtatás: GOOGLE_WORKSPACE_API_STUB=true npx tsx scripts/google-workspace-api-client.test.ts
 */
import assert from 'node:assert/strict'
import { GoogleWorkspaceApiClient } from '../src/domain/connector-grant/google-workspace-api-client'

process.env.GOOGLE_WORKSPACE_API_STUB = 'true'

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
  const client = new GoogleWorkspaceApiClient('stub-token')

  await test('docs apply edits stub', async () => {
    await client.applyDocsEdits('doc-1', [
      { insertText: { location: { index: 1 }, text: 'Hello' } },
    ])
  })

  await test('sheets write range stub', async () => {
    const res = await client.writeSheetsRange({
      fileId: 'sheet-1',
      range: 'A1:B2',
      values: [['a', 'b'], ['c', 'd']],
    })
    assert.equal(res.updatedCells, 4)
  })

  await test('slides apply edits stub', async () => {
    await client.applySlidesEdits('slides-1', [
      { replaceAllText: { containsText: { text: '{{title}}' }, replaceText: 'Cím' } },
    ])
  })

  // --- 5xx retry-duplikátum regresszió (nem-idempotens írás nem ismételhető) ---
  async function withLiveFetch<T>(
    responder: (calls: number) => Response,
    run: (live: GoogleWorkspaceApiClient, getCalls: () => number) => Promise<T>,
  ): Promise<T> {
    const realFetch = globalThis.fetch
    const realStub = process.env.GOOGLE_WORKSPACE_API_STUB
    const realDriveStub = process.env.GOOGLE_DRIVE_API_STUB
    delete process.env.GOOGLE_WORKSPACE_API_STUB
    delete process.env.GOOGLE_DRIVE_API_STUB
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return responder(calls)
    }) as typeof fetch
    try {
      return await run(new GoogleWorkspaceApiClient('live-token'), () => calls)
    } finally {
      globalThis.fetch = realFetch
      process.env.GOOGLE_WORKSPACE_API_STUB = realStub
      process.env.GOOGLE_DRIVE_API_STUB = realDriveStub
    }
  }

  await test('sheets :append does NOT replay a 5xx — no duplicate rows', async () => {
    await withLiveFetch(
      () => new Response('bad gateway', { status: 502 }),
      async (live, getCalls) => {
        await assert.rejects(
          () =>
            live.writeSheetsRange({ fileId: 's1', range: 'A1', values: [['x']], mode: 'append' }),
          /google_sheets_write_range failed: 502/,
        )
        assert.equal(getCalls(), 1, 'append POST must be sent exactly once on a 5xx')
      },
    )
  })

  await test('sheets replace (PUT) still retries a transient 5xx then succeeds', async () => {
    await withLiveFetch(
      (calls) =>
        calls < 3 ? new Response('bad gateway', { status: 502 }) : Response.json({ updatedCells: 1 }),
      async (live, getCalls) => {
        const res = await live.writeSheetsRange({
          fileId: 's1',
          range: 'A1',
          values: [['x']],
          mode: 'replace',
        })
        assert.equal(res.updatedCells, 1)
        assert.equal(getCalls(), 3, 'idempotent range PUT keeps the 5xx retry')
      },
    )
  })

  await test('docs apply edits does NOT replay a 5xx — no duplicate insertText', async () => {
    await withLiveFetch(
      () => new Response('bad gateway', { status: 502 }),
      async (live, getCalls) => {
        await assert.rejects(
          () => live.applyDocsEdits('d1', [{ insertText: { location: { index: 1 }, text: 'hi' } }]),
          /google_docs_apply_edits failed: 502/,
        )
        assert.equal(getCalls(), 1, 'docs batchUpdate must be sent exactly once on a 5xx')
      },
    )
  })

  await test('slides apply edits does NOT replay a 5xx', async () => {
    await withLiveFetch(
      () => new Response('bad gateway', { status: 502 }),
      async (live, getCalls) => {
        await assert.rejects(
          () => live.applySlidesEdits('p1', [{ insertText: { objectId: 'o1', text: 'hi' } }]),
          /google_slides_apply_edits failed: 502/,
        )
        assert.equal(getCalls(), 1, 'slides batchUpdate must be sent exactly once on a 5xx')
      },
    )
  })

  console.log('\nAll google-workspace-api-client tests passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
