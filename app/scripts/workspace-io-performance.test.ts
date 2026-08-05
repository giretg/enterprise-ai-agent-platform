/**
 * Workspace I/O teljesítmény-invariánsok (repo-olvasás forró útja).
 *
 * Amit véd:
 *  1. GCS token-cache — egy művelet-sorozat EGY metadata-körfordulást indít, nem
 *     fájlonként egyet; a hiba nem cache-elődik (fail-closed marad).
 *  2. Kvóta-session — a köteg-írás nem számolja újra a workspace méretét
 *     fájlonként, de a plafon ugyanúgy zár.
 *  3. Párhuzamos file_search — az eredmény DETERMINISZTIKUS (azonos a soros
 *     változatéval), és tényleg kötegelve olvas.
 *  4. Lapozott listázás — 1000 objektum fölött sem csonkol némán.
 *  5. deleteMany — korlátozott párhuzamosság (nem nyit korlátlan kapcsolatot).
 *
 * Run: npx tsx scripts/workspace-io-performance.test.ts
 */
import assert from 'node:assert/strict'
import { FileEditorService } from '../src/domain/file-editor/file-editor-service'
import {
  FileEditorError,
  WorkspaceStorage,
  WorkspaceQuotaSession,
  WORKSPACE_IO_CONCURRENCY,
} from '../src/domain/file-editor/workspace-storage'
import { resetGcpMetadataCacheForTests } from '../src/lib/gcp-metadata-token'

let failures = 0
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✅ ${name}`))
    .catch((e) => {
      failures++
      console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
    })
}

const realFetch = globalThis.fetch

type FetchCall = { url: string; method: string }

/**
 * GCS + metadata szerver mock. A `objects` a bucket tartalma (teljes objektumnév
 * → tartalom). Számolja a hívásokat típusonként, hogy a körfordulások SZÁMÁRA
 * lehessen invariánst írni.
 */
function mockGcs(objects: Record<string, string>, opts: { pageSize?: number } = {}) {
  const calls: FetchCall[] = []
  let concurrent = 0
  let peakConcurrent = 0
  const pageSize = opts.pageSize ?? 1000

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    calls.push({ url, method })

    concurrent += 1
    peakConcurrent = Math.max(peakConcurrent, concurrent)
    // Egy makrotask-nyi késleltetés: e nélkül a "párhuzamos" olvasás
    // megkülönböztethetetlen lenne a sorostól.
    await new Promise((resolve) => setTimeout(resolve, 1))
    concurrent -= 1

    if (url.includes('metadata.google.internal') && url.endsWith('/token')) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('metadata.google.internal') && url.endsWith('/email')) {
      return new Response('sa@example.iam.gserviceaccount.com', { status: 200 })
    }

    // Feltöltés: /upload/storage/v1/b/<bucket>/o?...&name=<name>
    // FIGYELEM: ezt a listázás ELŐTT kell vizsgálni — a feltöltés URL-je is
    // tartalmazza a `/storage/v1/b/` + `/o?` mintát.
    if (url.includes('/upload/storage/v1/b/')) {
      const parsed = new URL(url)
      const name = parsed.searchParams.get('name') ?? ''
      const body = init?.body
      objects[name] = Buffer.from(body as ArrayBuffer).toString('utf8')
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }

    // Listázás: /storage/v1/b/<bucket>/o?prefix=...
    if (url.includes('/storage/v1/b/') && url.includes('/o?')) {
      const parsed = new URL(url)
      const prefix = parsed.searchParams.get('prefix') ?? ''
      const pageToken = Number(parsed.searchParams.get('pageToken') ?? '0')
      const all = Object.keys(objects)
        .filter((name) => name.startsWith(prefix))
        .sort()
      const page = all.slice(pageToken, pageToken + pageSize)
      const nextIndex = pageToken + pageSize
      return new Response(
        JSON.stringify({
          items: page.map((name) => ({ name, size: String(Buffer.byteLength(objects[name])) })),
          ...(nextIndex < all.length ? { nextPageToken: String(nextIndex) } : {}),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    // Objektum-olvasás: /download/storage/v1/b/<bucket>/o/<name>?alt=media
    if (url.includes('/download/storage/v1/b/')) {
      const name = decodeURIComponent(url.split('/o/')[1].split('?')[0])
      if (!(name in objects)) return new Response('', { status: 404 })
      return new Response(objects[name], { status: 200 })
    }

    // Törlés / metadata-lekérdezés egy objektumra.
    if (url.includes('/storage/v1/b/') && url.includes('/o/')) {
      const name = decodeURIComponent(url.split('/o/')[1].split('?')[0])
      if (method === 'DELETE') {
        delete objects[name]
        return new Response(null, { status: 204 })
      }
      if (!(name in objects)) return new Response('', { status: 404 })
      return new Response(JSON.stringify({ size: String(Buffer.byteLength(objects[name])) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    throw new Error(`unexpected fetch: ${method} ${url}`)
  }) as typeof fetch

  return {
    calls,
    get peakConcurrent() {
      return peakConcurrent
    },
    count(fragment: string): number {
      return calls.filter((c) => c.url.includes(fragment)).length
    },
    /** Csak az objektum-LISTÁZÁS (a feltöltés URL-je is tartalmaz `/o?`-t). */
    countLists(): number {
      return calls.filter((c) => c.url.includes('/o?') && !c.url.includes('/upload/')).length
    },
    restore() {
      globalThis.fetch = realFetch
    },
  }
}

function gcsStorage(): WorkspaceStorage {
  process.env.FILE_EDITOR_STUB = 'false'
  process.env.FILE_EDITOR_STUB_MEMORY = 'false'
  resetGcpMetadataCacheForTests()
  return new WorkspaceStorage('test-bucket')
}

/** Memória-stub tár a tisztán logikai (hálózat nélküli) esetekhez. */
function memoryStorage(files: Record<string, string>, onRead?: () => void): WorkspaceStorage {
  return {
    async list(_t: string, _w: string, subpath?: string) {
      const all = Object.keys(files).sort()
      return subpath ? all.filter((p) => p.startsWith(`${subpath}/`)) : all
    },
    async read(_t: string, _w: string, path: string) {
      onRead?.()
      await new Promise((resolve) => setTimeout(resolve, 1))
      return path in files ? Buffer.from(files[path], 'utf8') : null
    },
  } as unknown as WorkspaceStorage
}

async function run() {
  // ---------------------------------------------------------------- 1. token cache
  await check('token-cache: 30 fájl beolvasása EGY metadata-token hívást indít', async () => {
    const objects: Record<string, string> = {}
    for (let i = 0; i < 30; i++) objects[`t1/w1/f${i}.txt`] = `tartalom ${i}`
    const gcs = mockGcs(objects)
    try {
      const storage = gcsStorage()
      for (let i = 0; i < 30; i++) {
        await storage.read('t1', 'w1', `f${i}.txt`)
      }
      assert.equal(gcs.count('/token'), 1, `token-hívások: ${gcs.count('/token')}`)
      assert.equal(gcs.count('/download/'), 30)
    } finally {
      gcs.restore()
    }
  })

  await check('token-cache: párhuzamos hideg indítás is EGY token-hívást oszt meg', async () => {
    const objects: Record<string, string> = {}
    for (let i = 0; i < 20; i++) objects[`t1/w1/f${i}.txt`] = 'x'
    const gcs = mockGcs(objects)
    try {
      const storage = gcsStorage()
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => storage.read('t1', 'w1', `f${i}.txt`)),
      )
      assert.equal(gcs.count('/token'), 1, `token-hívások: ${gcs.count('/token')}`)
    } finally {
      gcs.restore()
    }
  })

  await check('token-cache: a HIBA nem cache-elődik (fail-closed marad)', async () => {
    resetGcpMetadataCacheForTests()
    let tokenCalls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/token')) {
        tokenCalls += 1
        return new Response('nope', { status: 500 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch
    try {
      process.env.FILE_EDITOR_STUB = 'false'
      const storage = new WorkspaceStorage('test-bucket')
      for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(
          () => storage.read('t1', 'w1', 'f.txt'),
          (err: unknown) => err instanceof FileEditorError && err.code === 'GCS_AUTH_FAILED',
        )
      }
      // Minden próbálkozás ÚJRA feloldja: egy átmeneti hiba nem ragadhat be.
      assert.equal(tokenCalls, 3)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  // ------------------------------------------------------------- 2. kvóta-session
  await check('kvóta-session: 40 köteg-írás EGY méret-listázást indít', async () => {
    const objects: Record<string, string> = {}
    const gcs = mockGcs(objects)
    try {
      const storage = gcsStorage()
      const svc = new FileEditorService(storage)
      const quota = await svc.openQuotaSession('t1', 'w1')
      const listAfterOpen = gcs.countLists()
      assert.equal(listAfterOpen, 1, 'a session megnyitása egyetlen listázás')
      for (let i = 0; i < 40; i++) {
        await svc.writeFile('t1', 'w1', { path: `repo/f${i}.ts`, content: `export const x = ${i}` }, { quota })
      }
      // A session megnyitása után NINCS további listázás (a régi úton fájlonként
      // egy teljes listázás + egy metadata-GET futott volna).
      assert.equal(gcs.countLists(), listAfterOpen, 'a köteg-írás nem listázhat újra')
      assert.equal(gcs.count('/upload/'), 40)
      assert.equal(Object.keys(objects).length, 40)
    } finally {
      gcs.restore()
    }
  })

  await check('kvóta-session: a workspace-plafon ugyanúgy zár', () => {
    const previous = process.env.WORKSPACE_MAX_BYTES
    process.env.WORKSPACE_MAX_BYTES = '100'
    try {
      const quota = WorkspaceQuotaSession.fromSizes({ 'a.txt': 60 })
      quota.reserve('b.txt', 30) // 90 — belefér
      assert.equal(quota.totalBytes, 90)
      assert.throws(
        () => quota.reserve('c.txt', 20), // 110 — túllép
        (err: unknown) => err instanceof FileEditorError && err.code === 'WORKSPACE_TOO_LARGE',
      )
      // A felülírás a RÉGI méretet felszabadítja, nem adódik hozzá.
      quota.reserve('a.txt', 10)
      assert.equal(quota.totalBytes, 40)
      quota.release('a.txt')
      assert.equal(quota.totalBytes, 30)
    } finally {
      if (previous === undefined) delete process.env.WORKSPACE_MAX_BYTES
      else process.env.WORKSPACE_MAX_BYTES = previous
    }
  })

  await check('kvóta-session nélkül a viselkedés változatlan (plafon él)', async () => {
    const previous = process.env.WORKSPACE_MAX_BYTES
    process.env.WORKSPACE_MAX_BYTES = '50'
    const objects: Record<string, string> = { 't1/w1/nagy.txt': 'x'.repeat(45) }
    const gcs = mockGcs(objects)
    try {
      const svc = new FileEditorService(gcsStorage())
      await assert.rejects(
        () => svc.writeFile('t1', 'w1', { path: 'masik.txt', content: 'y'.repeat(20) }),
        (err: unknown) => err instanceof FileEditorError && err.code === 'WORKSPACE_TOO_LARGE',
      )
    } finally {
      gcs.restore()
      if (previous === undefined) delete process.env.WORKSPACE_MAX_BYTES
      else process.env.WORKSPACE_MAX_BYTES = previous
    }
  })

  // --------------------------------------------------------- 3. párhuzamos keresés
  await check('file_search: az eredmény azonos a soros változatéval (determinizmus)', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 120; i++) {
      files[`repo/src/f${String(i).padStart(3, '0')}.ts`] =
        `const a = 1\nexport const NAV_ITEMS = ${i}\nconst b = 2\nexport const NAV_ITEMS_ALT = ${i}\n`
    }
    const svc = new FileEditorService(memoryStorage(files))
    const result = await svc.searchFiles('t1', 'w1', { pattern: 'NAV_ITEMS', max_results: 1000 })

    // Referencia: ugyanaz a szkennelés szigorúan sorosan, ugyanabban a fájlsorrendben.
    const expected: Array<{ path: string; lineNumber: number }> = []
    for (const path of Object.keys(files).sort()) {
      files[path].split('\n').forEach((line, idx) => {
        if (line.includes('NAV_ITEMS')) expected.push({ path, lineNumber: idx + 1 })
      })
    }
    assert.equal(result.matches.length, expected.length)
    assert.deepEqual(
      result.matches.map((m) => ({ path: m.path, lineNumber: m.lineNumber })),
      expected,
    )
    assert.equal(result.truncated, false)
  })

  await check('file_search: kötegelve olvas (a párhuzamosság mérhető)', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 96; i++) files[`repo/f${String(i).padStart(3, '0')}.ts`] = 'sidebar\n'
    let inFlight = 0
    let peak = 0
    const storage = {
      async list() {
        return Object.keys(files).sort()
      },
      async read(_t: string, _w: string, path: string) {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inFlight -= 1
        return Buffer.from(files[path], 'utf8')
      },
    } as unknown as WorkspaceStorage
    const svc = new FileEditorService(storage)
    await svc.searchFiles('t1', 'w1', { pattern: 'sidebar', max_results: 1000 })
    assert.ok(peak > 1, `nem futott párhuzamosan (csúcs: ${peak})`)
    assert.ok(
      peak <= WORKSPACE_IO_CONCURRENCY,
      `a párhuzamosság túllépte a korlátot (csúcs: ${peak}, korlát: ${WORKSPACE_IO_CONCURRENCY})`,
    )
  })

  await check('file_search: a keret betelése csonkolást jelez, az első N találattal', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 50; i++) files[`repo/f${String(i).padStart(3, '0')}.ts`] = 'hit\nhit\n'
    const svc = new FileEditorService(memoryStorage(files))
    const result = await svc.searchFiles('t1', 'w1', { pattern: 'hit', max_results: 5 })
    assert.equal(result.matches.length, 5)
    assert.equal(result.truncated, true)
    // Az első 5 találat a rendezett fájlsorrend eleje — nem véletlenszerű minta.
    assert.deepEqual(
      result.matches.map((m) => `${m.path}:${m.lineNumber}`),
      ['repo/f000.ts:1', 'repo/f000.ts:2', 'repo/f001.ts:1', 'repo/f001.ts:2', 'repo/f002.ts:1'],
    )
  })

  // ------------------------------------------------------------ 4. lapozott listázás
  await check('list(): 1000 objektum fölött sem csonkol (lapozás)', async () => {
    const objects: Record<string, string> = {}
    for (let i = 0; i < 1250; i++) objects[`t1/w1/repo/f${String(i).padStart(4, '0')}.ts`] = 'x'
    const gcs = mockGcs(objects, { pageSize: 1000 })
    try {
      const storage = gcsStorage()
      const listed = await storage.list('t1', 'w1')
      assert.equal(listed.length, 1250, `csonkolt lista: ${listed.length}`)
      assert.ok(listed.includes('repo/f1249.ts'))
      // Az utolsó oldal is lekérdeződött.
      assert.ok(gcs.count('pageToken') >= 1, 'nem történt lapozás')
    } finally {
      gcs.restore()
    }
  })

  await check('listFileSizes(): lapozva, méretekkel adja vissza a workspace-t', async () => {
    const objects: Record<string, string> = {}
    for (let i = 0; i < 1100; i++) objects[`t1/w1/f${String(i).padStart(4, '0')}.txt`] = 'abc'
    const gcs = mockGcs(objects, { pageSize: 500 })
    try {
      const storage = gcsStorage()
      const sizes = await storage.listFileSizes('t1', 'w1')
      assert.equal(Object.keys(sizes).length, 1100)
      assert.equal(sizes['f0000.txt'], 3)
      assert.equal(await storage.getWorkspaceSize('t1', 'w1'), 3300)
    } finally {
      gcs.restore()
    }
  })

  // ------------------------------------------------------------------ 5. deleteMany
  await check('deleteMany: korlátozott párhuzamossággal töröl mindent', async () => {
    const objects: Record<string, string> = {}
    for (let i = 0; i < 100; i++) objects[`t1/w1/repo/f${i}.ts`] = 'x'
    const gcs = mockGcs(objects)
    try {
      const storage = gcsStorage()
      const paths = Object.keys(objects).map((name) => name.slice('t1/w1/'.length))
      const deleted = await storage.deleteMany('t1', 'w1', paths)
      assert.equal(deleted, 100)
      assert.equal(Object.keys(objects).length, 0)
      assert.ok(
        gcs.peakConcurrent <= WORKSPACE_IO_CONCURRENCY,
        `korlátlan párhuzamosság (csúcs: ${gcs.peakConcurrent})`,
      )
    } finally {
      gcs.restore()
    }
  })

  await check('deleteFiles: a törlés-jóváhagyási policy köteg-módban is érvényes', async () => {
    const objects: Record<string, string> = { 't1/w1/riport.xlsx': 'x' }
    const gcs = mockGcs(objects)
    try {
      const svc = new FileEditorService(gcsStorage())
      await assert.rejects(
        () => svc.deleteFiles('t1', 'w1', { paths: ['riport.xlsx'] }),
        (err: unknown) => err instanceof FileEditorError && err.code === 'CONFIRM_REQUIRED',
      )
      // Egyetlen fájl sem törlődhetett, mielőtt a policy elutasított.
      assert.equal(Object.keys(objects).length, 1)
    } finally {
      gcs.restore()
    }
  })
}

run().then(() => {
  globalThis.fetch = realFetch
  if (failures > 0) {
    console.error(`\n${failures} workspace-io-performance test(s) failed`)
    process.exit(1)
  }
  console.log('\nworkspace-io-performance tests passed')
})
