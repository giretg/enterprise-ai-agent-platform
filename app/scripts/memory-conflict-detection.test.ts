/**
 * Tartós agent-memória — WP-7 konfliktus-előszűrés regressziós teszt.
 *
 * Kontextus: `detectConflictsInPool` (retrieval-oldal, §7.1 bullet 1+2) és
 * `detectPublishConflict` (publikálás-oldal, §7.1 bullet 3) pure függvények —
 * DB nélkül tesztelhetők.
 *
 * Futtatás: npm run test:memory-conflicts
 */
import assert from 'node:assert/strict'
import { detectConflictsInPool, detectPublishConflict, type ConflictScanChunk } from '../src/domain/memory/conflict-detection'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function chunk(overrides: Partial<ConflictScanChunk> & { id: string }): ConflictScanChunk {
  return {
    type: 'decision',
    path: 'agent-memory/decisions',
    tags: [],
    status: 'active',
    supersedes: null,
    ...overrides,
  }
}

test('detectConflictsInPool: két aktív chunk azonos path-on → high risk', () => {
  const conflicts = detectConflictsInPool([
    chunk({ id: 'a', path: 'p/1' }),
    chunk({ id: 'b', path: 'p/1' }),
  ])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].risk, 'high')
  assert.deepEqual(conflicts[0].chunkIds, ['a', 'b'])
})

test('detectConflictsInPool: azonos type + átfedő tag, eltérő path → medium risk', () => {
  const conflicts = detectConflictsInPool([
    chunk({ id: 'a', path: 'p/1', tags: ['memory', 'schema'] }),
    chunk({ id: 'b', path: 'p/2', tags: ['schema', 'other'] }),
  ])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].risk, 'medium')
})

test('detectConflictsInPool: eltérő type + eltérő path, átfedő tag → nincs konfliktus', () => {
  const conflicts = detectConflictsInPool([
    chunk({ id: 'a', type: 'decision', path: 'p/1', tags: ['memory'] }),
    chunk({ id: 'b', type: 'open_task', path: 'p/2', tags: ['memory'] }),
  ])
  assert.equal(conflicts.length, 0)
})

test('detectConflictsInPool: superseded/archived chunk kimarad (nem aktív)', () => {
  const conflicts = detectConflictsInPool([
    chunk({ id: 'a', path: 'p/1', status: 'active' }),
    chunk({ id: 'b', path: 'p/1', status: 'superseded' }),
  ])
  assert.equal(conflicts.length, 0)
})

test('detectConflictsInPool: 3 azonos path-ú aktív chunk egyetlen konfliktus-setbe kerül', () => {
  const conflicts = detectConflictsInPool([
    chunk({ id: 'a', path: 'p/1' }),
    chunk({ id: 'b', path: 'p/1' }),
    chunk({ id: 'c', path: 'p/1' }),
  ])
  assert.equal(conflicts.length, 1)
  assert.deepEqual(conflicts[0].chunkIds, ['a', 'b', 'c'])
})

test('detectPublishConflict: új chunk supersedes nélkül azonos path/type aktívval → high', () => {
  const result = detectPublishConflict(
    { type: 'decision', path: 'p/1', tags: [], supersedes: null },
    [chunk({ id: 'existing', path: 'p/1' })],
  )
  assert.ok(result)
  assert.equal(result!.risk, 'high')
  assert.deepEqual(result!.chunkIds, ['existing'])
})

test('detectPublishConflict: supersedes megadva a konfliktáló chunkra → nincs konfliktus', () => {
  const result = detectPublishConflict(
    { type: 'decision', path: 'p/1', tags: [], supersedes: 'existing' },
    [chunk({ id: 'existing', path: 'p/1' })],
  )
  assert.equal(result, null)
})

test('detectPublishConflict: azonos type + átfedő tag, eltérő path → medium', () => {
  const result = detectPublishConflict(
    { type: 'decision', path: 'p/new', tags: ['schema'], supersedes: null },
    [chunk({ id: 'existing', path: 'p/1', tags: ['schema', 'x'] })],
  )
  assert.ok(result)
  assert.equal(result!.risk, 'medium')
})

test('detectPublishConflict: nincs átfedés → null', () => {
  const result = detectPublishConflict(
    { type: 'decision', path: 'p/new', tags: ['schema'], supersedes: null },
    [chunk({ id: 'existing', path: 'p/1', tags: ['other'] })],
  )
  assert.equal(result, null)
})

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott.`)
  process.exit(1)
}
console.log('\nMinden teszt sikeres.')
