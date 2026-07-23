/**
 * file_search / file_glob ReDoS-védelem (CWE-1333).
 * Run: npx tsx scripts/file-search-safe-pattern.test.ts
 */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import {
  assertSafeUserRegex,
  buildUserRegex,
  MAX_PATTERN_LENGTH,
} from '../src/domain/file-editor/safe-pattern'
import { FileEditorService } from '../src/domain/file-editor/file-editor-service'
import { FileEditorError, WorkspaceStorage } from '../src/domain/file-editor/workspace-storage'

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

function isFileEditorError(err: unknown, code: string): boolean {
  return err instanceof FileEditorError && err.code === code
}

// In-memory storage stub — csak a searchFiles/globFiles által használt read/list.
function stubStorage(files: Record<string, string>): WorkspaceStorage {
  return {
    async list() {
      return Object.keys(files)
    },
    async read(_t: string, _w: string, path: string) {
      return path in files ? Buffer.from(files[path], 'utf8') : null
    },
  } as unknown as WorkspaceStorage
}

async function run() {
  // --- star-height (nem-korlátos beágyazott kvantor) elutasítás ---
  await check('safe: sima literál + korlátos kvantor átmegy', () => {
    assertSafeUserRegex('foo')
    assertSafeUserRegex('a+')
    assertSafeUserRegex('[a-z]+')
    assertSafeUserRegex('(abc)+')
    assertSafeUserRegex('((ab)c)+')
    assertSafeUserRegex('a{2,5}')
    assertSafeUserRegex('(a{2,5})+')
    assertSafeUserRegex('(ab?)+')
    assertSafeUserRegex('foo.*bar')
    assertSafeUserRegex('\\(a+\\)+') // escapelt zárójelek → literál, nem csoport
  })

  await check('unsafe: (a+)+ elutasítva', () =>
    assert.throws(() => assertSafeUserRegex('(a+)+$'), (e) => isFileEditorError(e, 'UNSAFE_PATTERN')),
  )
  await check('unsafe: (a*)* elutasítva', () =>
    assert.throws(() => assertSafeUserRegex('(a*)*'), (e) => isFileEditorError(e, 'UNSAFE_PATTERN')),
  )
  await check('unsafe: ((a)+)+ elutasítva', () =>
    assert.throws(() => assertSafeUserRegex('((a)+)+'), (e) => isFileEditorError(e, 'UNSAFE_PATTERN')),
  )
  await check('unsafe: (a{1,}b)+ ({n,} nem-korlátos) elutasítva', () =>
    assert.throws(() => assertSafeUserRegex('(a{1,}b)+'), (e) => isFileEditorError(e, 'UNSAFE_PATTERN')),
  )
  await check('unsafe: ([a-z]+)* elutasítva', () =>
    assert.throws(() => assertSafeUserRegex('([a-z]+)*'), (e) => isFileEditorError(e, 'UNSAFE_PATTERN')),
  )

  await check('túl hosszú minta elutasítva', () =>
    assert.throws(
      () => assertSafeUserRegex('a'.repeat(MAX_PATTERN_LENGTH + 1)),
      (e) => isFileEditorError(e, 'PATTERN_TOO_LONG'),
    ),
  )

  await check('érvénytelen regex → tipizált INVALID_PATTERN', () =>
    assert.throws(() => buildUserRegex('(abc'), (e) => isFileEditorError(e, 'INVALID_PATTERN')),
  )

  // --- integráció: searchFiles a szolgáltatáson át ---
  const svc = new FileEditorService(stubStorage({ 'a.txt': 'hello world\nfoo bar\n', 'b.md': 'baz' }))

  await check('searchFiles: normál minta talál', async () => {
    const res = await svc.searchFiles('t', 'w', { pattern: 'foo' })
    assert.equal(res.matches.length, 1)
    assert.equal(res.matches[0].path, 'a.txt')
    assert.equal(res.matches[0].lineNumber, 2)
  })

  await check('searchFiles: ReDoS-minta elutasítva (nem fut le)', async () => {
    await assert.rejects(
      () => svc.searchFiles('t', 'w', { pattern: '(a+)+$' }),
      (e) => isFileEditorError(e, 'UNSAFE_PATTERN'),
    )
  })

  // A védelem HATÁSOS: a katasztrofális minta pathologikus bemeneten sem fagy be,
  // mert az assertSafeUserRegex azonnal (a regex-futtatás ELŐTT) dob.
  await check('searchFiles: katasztrofális minta gyorsan bukik, nem akad be', async () => {
    const evil = new FileEditorService(stubStorage({ 'x.txt': 'a'.repeat(40) + '!' }))
    const t0 = performance.now()
    await assert.rejects(() => evil.searchFiles('t', 'w', { pattern: '(a+)+$' }))
    const elapsed = performance.now() - t0
    assert.ok(elapsed < 500, `túl lassú volt: ${elapsed.toFixed(1)}ms — a regex lefutott?`)
  })

  await check('globFiles: túl hosszú glob elutasítva', async () => {
    await assert.rejects(
      () => svc.globFiles('t', 'w', { pattern: '*'.repeat(MAX_PATTERN_LENGTH + 1) }),
      (e) => isFileEditorError(e, 'PATTERN_TOO_LONG'),
    )
  })

  await check('globFiles: normál glob működik', async () => {
    const res = await svc.globFiles('t', 'w', { pattern: '*.txt' })
    assert.deepEqual(res.paths, ['a.txt'])
  })
}

run().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} file-search-safe-pattern test(s) failed`)
    process.exit(1)
  }
  console.log('\nfile-search-safe-pattern tests passed')
})
