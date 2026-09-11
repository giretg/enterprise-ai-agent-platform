/**
 * Munkaterület-feltöltés OOM-kapuja. A két feltöltő route (`tickets` és
 * `conversations` .../workspace/files) eddig a teljes multipart törzset a
 * `request.formData()`-tal memóriába pufferelte, és csak UTÁNA nézte a
 * `file.size > 50 MB` kaput — így a méret-kapu OOM ellen hatástalan volt
 * (hitelesített kliens tetszőlegesen nagy törzzsel OOM-ot válthatott ki a
 * memória-szűkös konténerben). A fix: Content-Length gyors-elutasítás a
 * `formData()` ELŐTT, közös helperben (nincs kapu-drift a két route közt).
 * Futtatás: npx tsx scripts/workspace-upload-limit.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MAX_WORKSPACE_UPLOAD_BYTES,
  WORKSPACE_UPLOAD_LIMIT_MESSAGE,
  rejectOversizedUpload,
} from '../src/lib/workspace-upload-limit'

const SLACK = 1024 * 1024

function req(headers: Record<string, string>): Request {
  return new Request('https://example.test/upload', { method: 'POST', headers })
}

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

async function main() {
  console.log('workspace-upload-limit')

  await test('plafon + boríték fölötti Content-Length → 413 (a formData ELŐTT)', () => {
    const res = rejectOversizedUpload(
      req({ 'content-length': String(MAX_WORKSPACE_UPLOAD_BYTES + SLACK + 1) }),
    )
    assert.ok(res, 'elutasító választ kell adnia')
    assert.equal(res!.status, 413)
  })

  await test('a hiba-üzenet a konstansból származik (nincs elavult „50 MB" szöveg)', async () => {
    assert.equal(WORKSPACE_UPLOAD_LIMIT_MESSAGE, 'File exceeds 50 MB limit')
    const res = rejectOversizedUpload(
      req({ 'content-length': String(MAX_WORKSPACE_UPLOAD_BYTES + SLACK + 1) }),
    )
    const body = (await res!.json()) as { error: string }
    assert.equal(body.error, WORKSPACE_UPLOAD_LIMIT_MESSAGE)
  })

  await test('pontosan a plafon + boríték → átengedi (null)', () => {
    const res = rejectOversizedUpload(
      req({ 'content-length': String(MAX_WORKSPACE_UPLOAD_BYTES + SLACK) }),
    )
    assert.equal(res, null)
  })

  await test('pont a plafonon lévő érvényes fájl nem akad fenn a borítékon', () => {
    // A multipart-boríték miatt egy pont 50 MiB-os fájl Content-Length-e kissé
    // a plafon fölött van; a SLACK ráhagyás megakadályozza a hamis pozitívat.
    const res = rejectOversizedUpload(
      req({ 'content-length': String(MAX_WORKSPACE_UPLOAD_BYTES + 4096) }),
    )
    assert.equal(res, null)
  })

  await test('Content-Length nélkül továbbengedi (post-parse file.size kapu véd)', () => {
    assert.equal(rejectOversizedUpload(req({})), null)
  })

  await test('érvénytelen Content-Length továbbengedi (nem blokkol hibás fejlécen)', () => {
    assert.equal(rejectOversizedUpload(req({ 'content-length': 'abc' })), null)
    assert.equal(rejectOversizedUpload(req({ 'content-length': '-5' })), null)
  })

  // Route-wiring: mindkét feltöltő route a helperrel kapuz a formData ELŐTT,
  // és a post-parse kapu a közös konstansra hivatkozik (nincs drift / duplikált 50 MB).
  for (const rel of [
    'src/app/api/v1/tickets/[id]/workspace/files/route.ts',
    'src/app/api/v1/conversations/[id]/workspace/files/route.ts',
  ]) {
    await test(`route bekötve: ${rel}`, () => {
      const src = readFileSync(resolve(process.cwd(), rel), 'utf8')
      const gateIdx = src.indexOf('rejectOversizedUpload(request)')
      const formIdx = src.indexOf('await request.formData()')
      assert.ok(gateIdx >= 0, 'hívja a rejectOversizedUpload-ot')
      assert.ok(formIdx >= 0, 'van formData hívás')
      assert.ok(gateIdx < formIdx, 'a kapu a formData ELŐTT fut')
      assert.ok(
        src.includes('file.size > MAX_WORKSPACE_UPLOAD_BYTES'),
        'a post-parse kapu a közös konstansra hivatkozik',
      )
      assert.ok(!/const MAX = 50 \* 1024 \* 1024/.test(src), 'nincs duplikált 50 MB literál')
    })
  }

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nminden teszt zöld')
}

void main()
