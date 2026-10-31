/**
 * Futtatás: GOOGLE_DRIVE_API_STUB=true npx tsx scripts/google-drive-api-client.test.ts
 */
import assert from 'node:assert/strict'
import {
  GoogleDriveApiAuthError,
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
    responder: (calls: number, url: string, init?: RequestInit) => Response,
    run: (live: GoogleDriveApiClient, getCalls: () => number) => Promise<T>,
  ): Promise<T> {
    const realFetch = globalThis.fetch
    const realStub = process.env.GOOGLE_DRIVE_API_STUB
    delete process.env.GOOGLE_DRIVE_API_STUB
    let calls = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return responder(calls, url, init)
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

  await test('search 400 keeps structured Google reason, not raw body', async () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: 'File secret-content.pdf not found',
        status: 'INVALID_ARGUMENT',
        errors: [
          {
            reason: 'invalid',
            location: 'q',
            message: 'File secret-content.pdf not found',
          },
        ],
      },
    })
    await withLiveFetch(
      () => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }),
      async (live) => {
        await assert.rejects(
          () => live.search({ query: 'secret' }),
          (error: unknown) => {
            assert.ok(error instanceof GoogleDriveApiError)
            assert.equal(error.status, 400)
            assert.equal(error.googleStatus, 'INVALID_ARGUMENT')
            assert.deepEqual(error.googleReasonCodes, ['invalid'])
            assert.deepEqual(error.googleLocations, ['q'])
            assert.equal(error.googleMessage, 'File secret-content.pdf not found')
            assert.equal(error.message, 'google_drive.search failed: 400')
            assert.equal(error.message.includes('secret-content'), false)
            return true
          },
        )
      },
    )
  })

  await test('search 400 reads reason and field from Google details[]', async () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: 'Request contains secret-content.pdf',
        status: 'INVALID_ARGUMENT',
        details: [
          { reason: 'INVALID_PARAMETER' },
          { fieldViolations: [{ field: 'parents', description: 'secret-content.pdf' }] },
        ],
      },
    })
    await withLiveFetch(
      () => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }),
      async (live) => {
        await assert.rejects(
          () => live.search({ query: 'secret' }),
          (error: unknown) => {
            assert.ok(error instanceof GoogleDriveApiError)
            assert.equal(error.googleStatus, 'INVALID_ARGUMENT')
            assert.deepEqual(error.googleReasonCodes, ['INVALID_PARAMETER'])
            assert.deepEqual(error.googleLocations, ['parents'])
            assert.equal(error.googleMessage, 'Request contains secret-content.pdf')
            assert.equal(error.message.includes('secret-content'), false)
            return true
          },
        )
      },
    )
  })

  await test('search 403 keeps structured Google auth reason, not raw body', async () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: 'The user has not granted the app access to file secret-content.pdf',
        errors: [{ reason: 'appNotAuthorizedToFile', location: 'fileId' }],
      },
    })
    await withLiveFetch(
      () => new Response(body, { status: 403, headers: { 'content-type': 'application/json' } }),
      async (live) => {
        await assert.rejects(
          () => live.search({ query: 'secret' }),
          (error: unknown) => {
            assert.ok(error instanceof GoogleDriveApiAuthError)
            assert.equal(error.status, 403)
            assert.deepEqual(error.googleReasonCodes, ['appNotAuthorizedToFile'])
            assert.deepEqual(error.googleLocations, ['fileId'])
            assert.equal(
              error.googleMessage,
              'The user has not granted the app access to file secret-content.pdf',
            )
            assert.equal(error.message, 'google_drive.search auth failed: 403')
            assert.equal(error.message.includes('secret-content'), false)
            return true
          },
        )
      },
    )
  })

  await test('search keeps includeItemsFromAllDrives', async () => {
    let seen = ''
    await withLiveFetch(
      (_calls, url) => {
        seen = url
        return Response.json({ files: [] })
      },
      async (live) => {
        await live.search({ query: 'x' })
      },
    )
    const parsed = new URL(seen)
    assert.equal(parsed.searchParams.get('supportsAllDrives'), 'true')
    assert.equal(parsed.searchParams.get('includeItemsFromAllDrives'), 'true')
  })

  await test('upload_file omits includeItemsFromAllDrives and keeps supportsAllDrives', async () => {
    let seen = ''
    await withLiveFetch(
      (_calls, url) => {
        seen = url
        return Response.json({ id: 'f1', name: 'r.html', mimeType: 'text/html' })
      },
      async (live) => {
        await live.uploadFile({ name: 'r.html', textContent: '<h1>ok</h1>' })
      },
    )
    const parsed = new URL(seen)
    assert.equal(parsed.pathname, '/upload/drive/v3/files')
    assert.equal(parsed.searchParams.get('supportsAllDrives'), 'true')
    assert.equal(parsed.searchParams.get('includeItemsFromAllDrives'), null)
  })

  await test('create_folder omits includeItemsFromAllDrives', async () => {
    let seen = ''
    await withLiveFetch(
      (_calls, url) => {
        seen = url
        return Response.json({
          id: 'folder-1',
          name: 'M',
          mimeType: 'application/vnd.google-apps.folder',
        })
      },
      async (live) => {
        await live.createFolder({ name: 'M' })
      },
    )
    const parsed = new URL(seen)
    assert.equal(parsed.searchParams.get('supportsAllDrives'), 'true')
    assert.equal(parsed.searchParams.get('includeItemsFromAllDrives'), null)
  })

  await test('upload 400 with message-only Google body keeps truncated googleMessage', async () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: 'Invalid multipart request with 0 mime parts',
      },
    })
    await withLiveFetch(
      () => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }),
      async (live) => {
        await assert.rejects(
          () => live.uploadFile({ name: 'r.html', textContent: '<h1>ok</h1>' }),
          (error: unknown) => {
            assert.ok(error instanceof GoogleDriveApiError)
            assert.equal(error.status, 400)
            assert.equal(error.googleStatus, undefined)
            assert.equal(error.googleReasonCodes, undefined)
            assert.equal(error.googleMessage, 'Invalid multipart request with 0 mime parts')
            assert.equal(error.message, 'google_drive.upload_file failed: 400')
            return true
          },
        )
      },
    )
  })

  await test('googleMessage truncates to 120 characters and strips control chars', async () => {
    const body = JSON.stringify({
      error: { code: 400, message: `Bad\nparam ${'x'.repeat(200)}` },
    })
    await withLiveFetch(
      () => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }),
      async (live) => {
        await assert.rejects(
          () => live.uploadFile({ name: 'r.html', textContent: '<h1>ok</h1>' }),
          (error: unknown) => {
            assert.ok(error instanceof GoogleDriveApiError)
            assert.equal(error.googleMessage?.length, 120)
            assert.equal(error.googleMessage?.includes('\n'), false)
            assert.equal(error.googleMessage?.startsWith('Bad param '), true)
            return true
          },
        )
      },
    )
  })

  await test('plain-text Google 400 body is kept as googleMessage', async () => {
    await withLiveFetch(
      () =>
        new Response('Invalid multipart request with 0 mime parts.', {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        }),
      async (live) => {
        await assert.rejects(
          () => live.uploadFile({ name: 'hello.txt', textContent: 'hello' }),
          (error: unknown) => {
            assert.ok(error instanceof GoogleDriveApiError)
            assert.equal(error.googleMessage, 'Invalid multipart request with 0 mime parts.')
            return true
          },
        )
      },
    )
  })

  await test('upload_file multipart has a blank line before the file body', async () => {
    let sent: Buffer | undefined
    await withLiveFetch(
      (_calls, _url, init) => {
        const raw = init?.body
        sent = Buffer.isBuffer(raw)
          ? raw
          : raw instanceof Uint8Array
            ? Buffer.from(raw)
            : Buffer.from(String(raw ?? ''))
        return Response.json({ id: 'f1', name: 'hello.txt', mimeType: 'text/plain' })
      },
      async (live) => {
        await live.uploadFile({ name: 'hello.txt', textContent: 'hello' })
      },
    )
    assert.ok(sent)
    const text = sent.toString('latin1')
    assert.match(text, /Content-Type: text\/plain; charset=UTF-8\r\n\r\nhello/)
    assert.equal(text.includes('charset=UTF-8\r\nhello'), false)
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
