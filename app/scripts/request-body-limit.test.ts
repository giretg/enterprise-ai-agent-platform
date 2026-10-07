/**
 * `readBoundedText` / `readBoundedJson` kötött kérés-törzs olvasó regressziók.
 * Futtatás: npm run test:request-body-limit
 *
 * Kulcs-invariáns: a törzs SOHA nem pufferelődhet a bájt-plafon fölé, sem a
 * `Content-Length` gyors-úton, sem a chunked (CL nélküli / hazudott CL) úton —
 * különben a megosztott Cloud Run konténer OOM-ölhető egy bérlő által, ami
 * minden bérlő kérését elejti. A túl nagy törzs `RequestTooLargeError`, a kis
 * törzs sértetlenül visszajön, az érvénytelen JSON pedig `SyntaxError`
 * (a route 413 vs. 400 felé képezi).
 */
import assert from 'node:assert/strict'
import { readBoundedText, readBoundedJson, RequestTooLargeError } from '../src/lib/request-body'

let passed = 0
let failed = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
  } catch (e) {
    failed++
    console.error(`✗ ${name}: ${e instanceof Error ? e.stack ?? e.message : e}`)
  }
}

/** Törzs egyetlen chunkban, a megadott `Content-Length` fejléccel (üres = nincs fejléc). */
function reqSingleChunk(payload: string, contentLength?: string): Request {
  const bytes = new TextEncoder().encode(payload)
  const headers = new Headers()
  if (contentLength !== undefined) headers.set('content-length', contentLength)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Request('https://x.test/api', { method: 'POST', headers, body, duplex: 'half' } as RequestInit & { duplex: 'half' })
}

/** Törzs sok apró chunkban, Content-Length NÉLKÜL (chunked transfer szimuláció). */
function reqChunked(totalBytes: number): Request {
  const chunk = new TextEncoder().encode('x'.repeat(1024))
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close()
      controller.enqueue(chunk)
      sent += chunk.byteLength
    },
  })
  // Szándékosan nincs content-length fejléc.
  return new Request('https://x.test/api', { method: 'POST', body, duplex: 'half' } as RequestInit & { duplex: 'half' })
}

const MAX = 1024 // 1 KiB plafon a teszthez

async function main() {
  // Content-Length gyors-út: a fejléc önmagában elutasít a törzs olvasása előtt.
  await check('content-length over cap → RequestTooLargeError', async () => {
    await assert.rejects(readBoundedText(reqSingleChunk('ignored', String(MAX + 1)), MAX), RequestTooLargeError)
  })

  // A fő bypass-teszt: hazudott/hiányzó CL mellett a streamelő számláló megszakít.
  await check('chunked body over cap (no content-length) → RequestTooLargeError', async () => {
    await assert.rejects(readBoundedText(reqChunked(MAX * 8), MAX), RequestTooLargeError)
  })

  await check('chunked body with lying small content-length still capped on stream', async () => {
    const req = reqChunked(MAX * 8)
    // Hamis, kicsi CL — a gyors-út átengedi, a streamszámlálónak kell megfognia.
    ;(req.headers as Headers).set('content-length', '10')
    await assert.rejects(readBoundedText(req, MAX), RequestTooLargeError)
  })

  // Határ-esetek: pontosan a plafon átmegy, plafon+1 elbukik.
  await check('exactly at cap passes', async () => {
    const text = 'a'.repeat(MAX)
    assert.equal(await readBoundedText(reqSingleChunk(text, String(MAX)), MAX), text)
  })
  await check('one byte over cap fails', async () => {
    await assert.rejects(readBoundedText(reqSingleChunk('a'.repeat(MAX + 1), String(MAX + 1)), MAX), RequestTooLargeError)
  })

  // readBoundedJson: érvényes JSON parse-ol, üres → null, szemét → SyntaxError (nem RequestTooLargeError).
  await check('valid json parses', async () => {
    assert.deepEqual(await readBoundedJson(reqSingleChunk('{"a":1}', '7'), MAX), { a: 1 })
  })
  await check('empty body → null', async () => {
    assert.equal(await readBoundedJson(reqSingleChunk('', '0'), MAX), null)
  })
  await check('invalid json → SyntaxError (nem size error)', async () => {
    await assert.rejects(readBoundedJson(reqSingleChunk('{bad', '4'), MAX), (e: unknown) => {
      assert.ok(e instanceof SyntaxError, 'SyntaxError várt')
      assert.ok(!(e instanceof RequestTooLargeError), 'nem lehet size error')
      return true
    })
  })
  await check('oversized json rejected before parse', async () => {
    await assert.rejects(readBoundedJson(reqChunked(MAX * 8), MAX), RequestTooLargeError)
  })

  // Multi-byte UTF-8: a plafon bájtban számol, nem karakterben.
  await check('multibyte counted in bytes', async () => {
    const s = 'é'.repeat(MAX) // 2 bájt/karakter → 2*MAX bájt
    await assert.rejects(readBoundedText(reqSingleChunk(s), MAX), RequestTooLargeError)
  })

  console.log(`\nrequest-body-limit: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
