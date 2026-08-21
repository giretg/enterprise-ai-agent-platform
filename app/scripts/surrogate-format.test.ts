/**
 * issue #320 — nyitott entitástípus-névtér és forrásbélyeg az álnévben.
 *
 * Futtatás: npm run test:surrogate-format
 */
import assert from 'node:assert/strict'
import {
  formatSurrogate,
  formatPrivacySourceSlot,
  parseSurrogate,
  isSurrogatePrefix,
  findEmbeddedSurrogates,
  UnknownEntityTypeError,
} from '../src/domain/privacy/surrogate-format'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function main() {
  console.log('surrogate-format (issue #320)\n')

  check('legacy [[COMPANY_1]] parse és format', () => {
    assert.equal(formatSurrogate('company', 1), '[[COMPANY_1]]')
    assert.deepEqual(parseSurrogate('[[COMPANY_1]]'), {
      entityType: 'company',
      ordinal: 1,
      sourceSlot: undefined,
    })
  })

  check('forrásbélyeges [[INGATLAN@S2_1]]', () => {
    assert.equal(formatSurrogate('ingatlan', 1, 'S2'), '[[INGATLAN@S2_1]]')
    assert.deepEqual(parseSurrogate('[[INGATLAN@S2_1]]'), {
      entityType: 'ingatlan',
      ordinal: 1,
      sourceSlot: 'S2',
    })
  })

  check('nyitott slug: ingatlan_tipus', () => {
    assert.equal(formatSurrogate('ingatlan_tipus', 3, 'S1'), '[[INGATLAN_TIPUS@S1_3]]')
  })

  check('ismeretlen slug elutasítva', () => {
    assert.throws(() => formatSurrogate('INVALID', 1), UnknownEntityTypeError)
  })

  check('beágyazott parse vegyes formátumokkal', () => {
    const text = 'A [[COMPANY_1]] és a [[COMPANY@S2_3]] külön forrás.'
    const found = findEmbeddedSurrogates(text)
    assert.equal(found.length, 2)
    assert.equal(found[0]?.parsed?.entityType, 'company')
    assert.equal(found[1]?.parsed?.sourceSlot, 'S2')
  })

  check('isSurrogatePrefix forrásbélyeggel', () => {
    assert.equal(isSurrogatePrefix('[[COMPANY@S2'), true)
    assert.equal(isSurrogatePrefix('[[COMPANY@S2_1]]'), false)
  })

  check('formatPrivacySourceSlot', () => {
    assert.equal(formatPrivacySourceSlot(2), 'S2')
  })

  console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
