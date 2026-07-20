/**
 * tulajdoni_lap_parse forrásfeloldás — Document UUID vs workspace path.
 * Run: npx tsx scripts/tulajdoni-lap-source.test.ts
 */
import assert from 'node:assert/strict'
import {
  isDocumentUuid,
  resolveTulajdoniLapParseSource,
} from '../src/lib/tulajdoni-lap-source'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

check('UUID documentId → document source', () => {
  const id = '86eee1ea-e7a6-40b4-ab8f-2e996d37a468'
  assert.equal(isDocumentUuid(id), true)
  assert.deepEqual(resolveTulajdoniLapParseSource({ documentId: id }), {
    kind: 'document',
    documentId: id,
  })
})

check('valid UUID wins over path (Document ACL)', () => {
  const id = '86eee1ea-e7a6-40b4-ab8f-2e996d37a468'
  assert.deepEqual(
    resolveTulajdoniLapParseSource({
      documentId: id,
      path: '043_15 2026.07.16.pdf',
    }),
    { kind: 'document', documentId: id },
  )
})

check('explicit path alone → workspace', () => {
  assert.deepEqual(
    resolveTulajdoniLapParseSource({ path: '043_15 2026.07.16.pdf' }),
    { kind: 'workspace', path: '043_15 2026.07.16.pdf' },
  )
})

check('filename as documentId coerces to workspace path (lap 5 bug)', () => {
  assert.deepEqual(
    resolveTulajdoniLapParseSource({ documentId: '043_15 2026.07.16.pdf' }),
    { kind: 'workspace', path: '043_15 2026.07.16.pdf' },
  )
})

check('mangled UUID-shaped documentId does not coerce to path', () => {
  assert.throws(
    () =>
      resolveTulajdoniLapParseSource({
        documentId: '86eee1ea-e7a6-40b4-ab8f-2e996d37a46Z',
      }),
    /nem érvényes UUID/,
  )
})

check('missing source throws clear error', () => {
  assert.throws(() => resolveTulajdoniLapParseSource({}), /documentId.*path/i)
})

console.log(
  failures === 0
    ? '\ntulajdoni-lap-source tests passed'
    : `\n${failures} tulajdoni-lap-source test(s) failed`,
)
process.exit(failures === 0 ? 0 : 1)
