/**
 * readBoundedFormData — feltöltő-törzs OOM-kapu regressziós teszt.
 * Run: npx tsx scripts/bounded-form-data.test.ts
 *
 * A feltöltő route-ok korábban a `file.size`-t csak `request.formData()` UTÁN nézték,
 * így a plafon a teljes memóriába pufferelés UTÁN futott (OOM-vektor). A kapu most a
 * pufferelés BEFEJEZÉSE előtt üt: Content-Length gyors-elutasítás + streamelt bájt-számláló,
 * ami chunked / hossz nélküli törzsnél is megszakít.
 */
import assert from 'node:assert/strict'
import { readBoundedFormData, RequestBodyTooLargeError } from '../src/lib/bounded-form-data'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures++
    console.error(`  ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function liveFormDataRequest(bytes: number): Request {
  const fd = new FormData()
  fd.set('file', new File([new Uint8Array(bytes)], 'x.bin'), 'x.bin')
  fd.set('path', 'docs/x.bin')
  return new Request('http://x/upload', { method: 'POST', body: fd })
}

// Egy valós multipart törzs nyers bájtjai + Content-Type, hogy hossz NÉLKÜLI
// streamelt (chunked-szerű) törzset gyárthassunk — a Content-Length gyors-út megkerülésével.
async function serializedMultipart(bytes: number): Promise<{ raw: Uint8Array; contentType: string }> {
  const src = liveFormDataRequest(bytes)
  return {
    raw: new Uint8Array(await src.arrayBuffer()),
    contentType: src.headers.get('content-type')!,
  }
}

function streamRequest(raw: Uint8Array, contentType: string): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(raw)
      c.close()
    },
  })
  return new Request('http://x/upload', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

async function run() {
  await check('Content-Length gyors-út: bevallott hossz > plafon → azonnal elutasít', async () => {
    // Ez a fő OOM-védelem a becsületes klienseknél: a törzset el sem olvassuk.
    const req = new Request('http://x/upload', {
      method: 'POST',
      headers: { 'content-length': '999999', 'content-type': 'multipart/form-data; boundary=x' },
      body: 'x',
    })
    await assert.rejects(() => readBoundedFormData(req, 1000), RequestBodyTooLargeError)
  })

  await check('normál feltöltés bőséges plafon alatt átmegy, megvan a fájl és a path', async () => {
    const fd = await readBoundedFormData(liveFormDataRequest(4096), 10 * 1024 * 1024)
    const file = fd.get('file')
    assert.ok(file instanceof File, 'a file mező visszajön')
    assert.equal(file.size, 4096)
    assert.equal(fd.get('path'), 'docs/x.bin', 'a többi mező is átjön')
  })

  await check('STREAM-út (nincs Content-Length): plafon fölött a számláló megszakít', async () => {
    const { raw, contentType } = await serializedMultipart(8192)
    const req = streamRequest(raw, contentType)
    assert.equal(req.headers.get('content-length'), null, 'stream törzsnek nincs Content-Length')
    await assert.rejects(
      () => readBoundedFormData(req, raw.length - 1),
      RequestBodyTooLargeError,
      'a stream-számlálónak kell megszakítania, nem a gyors-útnak',
    )
  })

  await check('STREAM-út: pontosan a plafonon átmegy (strict >, nincs off-by-one)', async () => {
    const { raw, contentType } = await serializedMultipart(8192)
    const fd = await readBoundedFormData(streamRequest(raw, contentType), raw.length)
    const file = fd.get('file')
    assert.ok(file instanceof File)
    assert.equal(file.size, 8192)
  })

  await check('rossz/nem-multipart törzs a méret-hibától elkülönül (route 400, nem 413)', async () => {
    const req = new Request('http://x/upload', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=nope' },
      body: 'not really multipart',
    })
    let caught: unknown
    try {
      await readBoundedFormData(req, 10 * 1024 * 1024)
    } catch (e) {
      caught = e
    }
    assert.ok(caught, 'érvénytelen multipart dob')
    assert.ok(
      !(caught instanceof RequestBodyTooLargeError),
      'malformed hiba nem képeződik méret-hibára',
    )
  })

  await check('route-wiring: mindkét feltöltő route a kapun megy át (nincs nyers formData)', async () => {
    const { readFileSync } = await import('node:fs')
    for (const p of [
      'src/app/api/v1/tickets/[id]/workspace/files/route.ts',
      'src/app/api/v1/conversations/[id]/workspace/files/route.ts',
    ]) {
      const src = readFileSync(p, 'utf8')
      assert.ok(src.includes('readBoundedFormData(request'), `${p}: a kapun megy át`)
      assert.ok(
        !/=\s*await\s+request\.formData\(\)/.test(src),
        `${p}: nincs maradék nyers request.formData()`,
      )
    }
  })
}

run().then(() => {
  if (failures > 0) process.exit(1)
  console.log('\nbounded form-data tests passed')
})
