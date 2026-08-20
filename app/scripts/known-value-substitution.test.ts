/**
 * APG-16 — Known-value substitution magyar toldalék-tűrő illesztéssel.
 *
 * Futtatás: npm run test:known-value-substitution
 */
import assert from 'node:assert/strict'

import { extractMatchingStems } from '../src/domain/privacy/hungarian-suffix-morphs'
import { normalizeHungarianForMatching } from '../src/domain/privacy/hungarian-text-normalize'
import { findKnownValueMatches } from '../src/domain/privacy/known-value-matcher'
import {
  applyKnownValueReplacements,
  substituteKnownValuesInText,
} from '../src/domain/privacy/known-value-substitution'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const SPAR = 'SPAR Magyarország Kft.'
const SPAR_REPL = [
  { needle: SPAR, surrogate: '[[COMPANY_1]]', fromStructuredField: true },
]

async function main() {
  console.log('APG-16 known-value substitution (magyar toldalék-tűrés)\n')

  await test('normalizálás: ékezet + elválasztójel', () => {
    assert.equal(normalizeHungarianForMatching('SPAR-nál'), 'spar nal')
    assert.equal(normalizeHungarianForMatching('Tesco'), 'tesco')
    assert.equal(normalizeHungarianForMatching('Ökörszem'), 'okorszem')
  })

  await test('szótő: SPAR cégnévből', () => {
    const stems = extractMatchingStems(SPAR)
    assert.ok(stems.includes('spar'))
    assert.ok(stems.includes('spar magyarorszag kft'))
  })

  await test('exact match továbbra is működik', () => {
    const text = `Kérem: ${SPAR} adatait.`
    const out = applyKnownValueReplacements(text, SPAR_REPL)
    assert.equal(out, 'Kérem: [[COMPANY_1]] adatait.')
  })

  await test('kötőjeles toldalék: SPAR-nak', () => {
    const text = 'Küldd el a SPAR-nak a kimutatást.'
    const out = applyKnownValueReplacements(text, SPAR_REPL)
    assert.equal(out, 'Küldd el a [[COMPANY_1]] a kimutatást.')
  })

  await test('ragozott alak: Sparnál', () => {
    const text = 'A Sparnál vettük át az adatokat.'
    const out = applyKnownValueReplacements(text, SPAR_REPL)
    assert.equal(out, 'A [[COMPANY_1]] vettük át az adatokat.')
  })

  await test('ragozott alak: a Sparban', () => {
    const text = 'A beszerzés a Sparban zajlik.'
    const out = applyKnownValueReplacements(text, SPAR_REPL)
    assert.equal(out, 'A beszerzés a [[COMPANY_1]] zajlik.')
  })

  await test('ragozott alak: SPAR-ral', () => {
    const text = 'Tárgyalás a SPAR-ral holnap.'
    const out = applyKnownValueReplacements(text, SPAR_REPL)
    assert.equal(out, 'Tárgyalás a [[COMPANY_1]] holnap.')
  })

  await test('ékezet-tűrés: spárnál → SPAR', () => {
    const text = 'Egyeztetés a spárnál délután.'
    const out = applyKnownValueReplacements(text, SPAR_REPL)
    assert.equal(out, 'Egyeztetés a [[COMPANY_1]] délután.')
  })

  await test('szóhatár: spár a „diszpécser”-ben nem illeszt', () => {
    const text = 'A diszpécser hívta fel.'
    const matches = findKnownValueMatches(text, SPAR_REPL)
    assert.equal(matches.length, 0)
  })

  await test('személynév ragozva: Kiss Jánosnak', () => {
    const repl = [{ needle: 'Kiss János', surrogate: '[[PERSON_1]]', fromStructuredField: true }]
    const text = 'Kiss Jánosnak küldjük a szerződést.'
    const out = applyKnownValueReplacements(text, repl)
    assert.equal(out, '[[PERSON_1]] küldjük a szerződést.')
  })

  await test('substituteKnownValuesInText ENFORCE módban', async () => {
    const result = await substituteKnownValuesInText({
      text: 'A SPAR-nak küldjük.',
      replacements: SPAR_REPL,
      mode: 'enforce',
    })
    assert.equal(result.text, 'A [[COMPANY_1]] küldjük.')
    assert.equal(result.appliedCount, 1)
  })

  console.log(
    failures === 0
      ? '\nMinden APG-16 known-value teszt zöld.'
      : `\n${failures} teszt elbukott.`,
  )
  if (failures > 0) process.exit(1)
}

main()
