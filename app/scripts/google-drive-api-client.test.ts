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

  await test('upload_file stub', async () => {
    const res = await client.uploadFile({ name: 'riport.html', textContent: '<h1>ok</h1>' })
    assert.ok(res.created)
    assert.equal(res.file.name, 'riport.html')
  })

  await test('list_drives stub', async () => {
    const res = await client.listDrives({})
    assert.ok(res.drives.length > 0)
  })

  await test('read_file extracts text from Drive PDF', async () => {
    const pdf = buildPdf('Hello PDF')
    const realFetch = globalThis.fetch
    const realStub = process.env.GOOGLE_DRIVE_API_STUB
    delete process.env.GOOGLE_DRIVE_API_STUB
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.includes('alt=media')) {
        return new Response(pdf, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        })
      }
      return Response.json({
        id: 'pdf-1',
        name: 'minta.pdf',
        mimeType: 'application/pdf',
        size: String(pdf.byteLength),
      })
    }) as typeof fetch
    try {
      const live = new GoogleDriveApiClient('real-token-for-test')
      const res = await live.readFile({ fileId: 'pdf-1' })
      assert.ok(res.text?.includes('Hello PDF'))
    } finally {
      globalThis.fetch = realFetch
      process.env.GOOGLE_DRIVE_API_STUB = realStub
    }
  })

  await test('read_file still rejects oversized PDF via maxBytes', async () => {
    const pdf = buildPdf('Hello PDF')
    const realFetch = globalThis.fetch
    const realStub = process.env.GOOGLE_DRIVE_API_STUB
    delete process.env.GOOGLE_DRIVE_API_STUB
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.includes('alt=media')) {
        return new Response(pdf, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        })
      }
      return Response.json({
        id: 'pdf-1',
        name: 'minta.pdf',
        mimeType: 'application/pdf',
        size: String(pdf.byteLength),
      })
    }) as typeof fetch
    try {
      const live = new GoogleDriveApiClient('real-token-for-test')
      await assert.rejects(() => live.readFile({ fileId: 'pdf-1', maxBytes: 10 }))
    } finally {
      globalThis.fetch = realFetch
      process.env.GOOGLE_DRIVE_API_STUB = realStub
    }
  })

  // --- 5xx retry-duplikátum regresszió (nem-idempotens create-POST nem ismételhető) ---
  async function withLiveFetch<T>(
    responder: (calls: number) => Response,
    run: (live: GoogleDriveApiClient, getCalls: () => number) => Promise<T>,
  ): Promise<T> {
    const realFetch = globalThis.fetch
    const realStub = process.env.GOOGLE_DRIVE_API_STUB
    delete process.env.GOOGLE_DRIVE_API_STUB
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return responder(calls)
    }) as typeof fetch
    try {
      // A GoogleDriveApiClient stubnak tekint minden `stub-` prefixű tokent → live token.
      return await run(new GoogleDriveApiClient('live-token'), () => calls)
    } finally {
      globalThis.fetch = realFetch
      process.env.GOOGLE_DRIVE_API_STUB = realStub
    }
  }

  await test('upload_file does NOT replay a 5xx — no duplicate file', async () => {
    await withLiveFetch(
      () => new Response('bad gateway', { status: 502 }),
      async (live, getCalls) => {
        await assert.rejects(
          () => live.uploadFile({ name: 'r.html', textContent: '<h1>ok</h1>' }),
          /google_drive\.upload_file failed: 502/,
        )
        assert.equal(getCalls(), 1, 'upload POST must be sent exactly once on a 5xx')
      },
    )
  })

  await test('create_folder does NOT replay a 5xx — no duplicate folder', async () => {
    await withLiveFetch(
      () => new Response('bad gateway', { status: 502 }),
      async (live, getCalls) => {
        await assert.rejects(
          () => live.createFolder({ name: 'M' }),
          /google_drive\.create_folder failed: 502/,
        )
        assert.equal(getCalls(), 1, 'create_folder POST must be sent exactly once on a 5xx')
      },
    )
  })

  await test('search (read) still retries a transient 5xx then succeeds', async () => {
    await withLiveFetch(
      (calls) =>
        calls < 3 ? new Response('bad gateway', { status: 502 }) : Response.json({ files: [] }),
      async (live, getCalls) => {
        const res = await live.search({ query: 'x' })
        assert.equal(res.files.length, 0)
        assert.equal(getCalls(), 3, 'reads keep the 5xx retry')
      },
    )
  })

  console.log('\nAll google-drive-api-client tests passed.')
}

/** Minimális érvényes PDF kinyerhető szöveggel (a fixtures/generate-pdf.ts alapján). */
function buildPdf(text: string): Buffer {
  const objects: string[] = []
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')
  objects.push(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
  )
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  objects.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`)
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n')

  let body = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (const obj of objects) {
    offsets.push(body.length)
    body += obj
  }

  const xrefStart = body.length
  body += 'xref\n'
  body += `0 ${objects.length + 1}\n`
  body += '0000000000 65535 f \n'
  for (let i = 1; i <= objects.length; i++) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  body += 'trailer\n'
  body += `<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  body += 'startxref\n'
  body += `${xrefStart}\n`
  body += '%%EOF\n'
  return Buffer.from(body, 'utf8')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
