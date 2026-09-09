/**
 * A megosztott `readJson` kérés-törzs méret-kapuja (OOM-védelem).
 *
 * A control-plane JSON-végpontjai eddig határ nélkül pufferelték be a kérés-törzset a
 * `JSON.parse` elé — egy több MB-os törzs a memória-szűkös Cloud Run konténerben már a
 * parse előtt OOM-olt (l. OOM-incidens). A `readJson` most a bájt-plafonig olvas, MIELŐTT
 * memóriába pufferelne, és megszakítja a stream-et a plafon átlépésekor (chunked, Content-
 * Length nélküli törzsnél is). Minden JSON-ingress ezen a közös kapun megy át.
 *
 * Futtatás: npx tsx scripts/read-json-body-limit.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_MAX_JSON_BODY_BYTES,
  RequestBodyTooLargeError,
  readJson,
} from '../src/lib/api-response'

const URL = 'http://localhost/api/test'

let failures = 0
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((error) => {
      failures += 1
      console.error(`  ✗ ${name}`)
      console.error(error)
    })
}

function jsonRequest(body: string): Request {
  return new Request(URL, { method: 'POST', body })
}

/** Content-Length nélküli (chunked) törzs egy ReadableStream-ből — a streaming-számláló útját feszíti. */
function streamedRequest(totalBytes: number): Request {
  const chunk = new TextEncoder().encode('x'.repeat(1024))
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close()
      controller.enqueue(chunk)
      sent += chunk.byteLength
    },
  })
  return new Request(URL, { method: 'POST', body: stream, duplex: 'half' } as RequestInit & {
    duplex: 'half'
  })
}

async function main() {
  console.log('read-json-body-limit')

  await test('érvényes, plafon alatti JSON átmegy és parse-olódik', async () => {
    const parsed = await readJson(jsonRequest(JSON.stringify({ hello: 'world' })), 1024)
    assert.deepEqual(parsed, { hello: 'world' })
  })

  await test('pontosan a plafonnyi törzs átmegy', async () => {
    // {"a":"<pad>"} — a pad úgy méretezve, hogy a teljes JSON pont maxBytes bájt legyen.
    const maxBytes = 64
    const envelope = JSON.stringify({ a: '' }) // {"a":""} = 8 bájt
    const pad = 'x'.repeat(maxBytes - envelope.length)
    const body = JSON.stringify({ a: pad })
    assert.equal(Buffer.byteLength(body), maxBytes)
    const parsed = (await readJson(jsonRequest(body), maxBytes)) as { a: string }
    assert.equal(parsed.a, pad)
  })

  await test('a plafonnál eggyel nagyobb törzs elutasításra kerül (Content-Length gyors út)', async () => {
    const maxBytes = 64
    const body = 'x'.repeat(maxBytes + 1)
    await assert.rejects(readJson(jsonRequest(body), maxBytes), RequestBodyTooLargeError)
  })

  await test('nagy törzs Content-Length nélkül (chunked) is elutasításra kerül a stream-számlálón', async () => {
    const maxBytes = 4 * 1024
    await assert.rejects(
      readJson(streamedRequest(64 * 1024), maxBytes),
      RequestBodyTooLargeError,
    )
  })

  await test('érvénytelen JSON → Invalid JSON body (nem RequestBodyTooLargeError)', async () => {
    await assert.rejects(readJson(jsonRequest('{ not json'), 1024), (e: unknown) => {
      assert.ok(e instanceof Error)
      assert.equal(e instanceof RequestBodyTooLargeError, false)
      assert.match(e.message, /Invalid JSON body/)
      return true
    })
  })

  await test('alapértelmezett plafon 1 MiB', () => {
    assert.equal(DEFAULT_MAX_JSON_BODY_BYTES, 1024 * 1024)
  })

  // Route-wiring forrás-assertek: minden JSON-ingress a közös, kapuzott readJson-t használja,
  // nem a nyers request.json()-t (különben a kapu megkerülhető lenne).
  await test('minden JSON-ingress a readJson-on megy át (nincs nyers request.json())', () => {
    const routes = [
      'src/app/api/v1/agent-chat/stream/route.ts',
      'src/app/api/v1/gateway/v1/chat/completions/route.ts',
      'src/app/api/v1/agent/tickets/route.ts',
      'src/app/api/v1/agent/tools/route.ts',
      'src/app/api/v1/harness/tickets/[id]/complete/route.ts',
      'src/app/api/v1/harness/tickets/[id]/process/route.ts',
      'src/app/api/channels/telegram/webhook/route.ts',
    ]
    for (const rel of routes) {
      const src = readFileSync(resolve(process.cwd(), rel), 'utf8')
      assert.ok(src.includes('readJson('), `${rel}: readJson-t kell használnia`)
      assert.equal(
        /await\s+request\.json\(\)/.test(src),
        false,
        `${rel}: nem maradhat nyers request.json()`,
      )
    }
  })

  await test('a gateway tágabb, de véges plafont kap (4 MiB, nem alap)', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/app/api/v1/gateway/v1/chat/completions/route.ts'),
      'utf8',
    )
    assert.match(src, /GATEWAY_MAX_JSON_BODY_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/)
    assert.match(src, /readJson\(request,\s*GATEWAY_MAX_JSON_BODY_BYTES\)/)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nMinden read-json-body-limit teszt zöld')
}

void main()
