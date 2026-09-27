/**
 * localRoots path hints (#729) — parse/omit/definition block, no DB.
 * Futtatás: npm run test:agent-local-roots
 */
import assert from 'node:assert/strict'
import {
  LOCAL_ROOTS_INVALID,
  localRootsCheckoutFile,
  localRootsDefinitionBlock,
  parseLocalRoots,
  snapshotLocalRoots,
  withLocalRootsMemoryNote,
} from '../src/lib/agent-local-roots'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e: unknown) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

function main() {
  check('trims, skips comments and blanks, de-dupes', () => {
    assert.deepEqual(
      parseLocalRoots('# note\n\n~/Projects/platform\n ~/Projects/platform \n~/Projects/other'),
      ['~/Projects/platform', '~/Projects/other'],
    )
  })

  check('accepts absolute POSIX', () => {
    assert.deepEqual(parseLocalRoots('/Users/me/Projects/platform'), ['/Users/me/Projects/platform'])
  })

  check('rejects relative, home-only, traversal, glob', () => {
    for (const raw of ['Projects/foo', '~', '~/', '/', '../etc', '~/foo/../bar', '~/foo*', 'C:\\repo', 'foo/bar']) {
      assert.throws(() => parseLocalRoots(raw), (err: unknown) => err instanceof Error && err.message === LOCAL_ROOTS_INVALID)
    }
  })

  check('empty omits from snapshot', () => {
    assert.equal(snapshotLocalRoots(''), undefined)
    assert.equal(snapshotLocalRoots('  \n# x\n'), undefined)
  })

  check('definition block and memory note only when paths exist', () => {
    assert.deepEqual(localRootsDefinitionBlock(undefined), {})
    assert.deepEqual(localRootsDefinitionBlock([]), {})
    const block = localRootsDefinitionBlock(['~/Projects/platform'])
    assert.deepEqual(block.localRoots?.paths, ['~/Projects/platform'])
    assert.match(block.localRoots?.note ?? '', /across machines/)
    assert.match(block.localRoots?.note ?? '', /Hints, not a grant/)
    assert.equal(withLocalRootsMemoryNote('Catalog.', []), 'Catalog.')
    assert.match(withLocalRootsMemoryNote('Catalog.', ['~/x']), /see localRoots/)
  })

  check('checkout JSON only when non-empty', () => {
    assert.equal(localRootsCheckoutFile([]), null)
    const file = localRootsCheckoutFile(['~/Projects/platform'])
    assert.equal(file?.path, '.enterprise-agent/local-roots.json')
    const body = JSON.parse(file?.content ?? '{}') as { paths: string[] }
    assert.deepEqual(body.paths, ['~/Projects/platform'])
  })

  if (failures > 0) {
    console.log(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nall passed')
}

main()
