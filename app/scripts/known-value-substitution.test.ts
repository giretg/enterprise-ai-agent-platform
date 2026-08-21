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
import {
  computeFalsePositiveRate,
  computeRecall,
} from '../src/lib/privacy-eval'
import {
  KNOWN_VALUE_EVAL_CASES,
  KNOWN_VALUE_EVAL_DICTIONARY,
  KNOWN_VALUE_FALSE_POSITIVE_CASES,
} from '../src/lib/privacy-eval-fixtures'

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
    assert.equal(out, 'Küldd el a [[COMPANY_1]]-nak a kimutatást.')
  })

  await test('ragozott alak: Sparnál', () => {
    const text = 'A Sparnál vettük át az adatokat.'
    const out = applyKnownValueReplacements(text, SPAR_REPL)
    assert.equal(out, 'A [[COMPANY_1]]nál vettük át az adatokat.')
  })

  await test('ragozott alak: a Sparban', () => {
    const text = 'A beszerzés a Sparban zajlik.'
    const out = applyKnownValueReplacements(text, SPAR_REPL)
    assert.equal(out, 'A beszerzés a [[COMPANY_1]]ban zajlik.')
  })

  await test('ragozott alak: SPAR-ral', () => {
    const text = 'Tárgyalás a SPAR-ral holnap.'
    const out = applyKnownValueReplacements(text, SPAR_REPL)
    assert.equal(out, 'Tárgyalás a [[COMPANY_1]]-ral holnap.')
  })

  await test('ékezet-tűrés: spárnál → SPAR', () => {
    const text = 'Egyeztetés a spárnál délután.'
    const out = applyKnownValueReplacements(text, SPAR_REPL)
    assert.equal(out, 'Egyeztetés a [[COMPANY_1]]nál délután.')
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
    assert.equal(out, '[[PERSON_1]]nak küldjük a szerződést.')
  })

  await test('köznév tő nem önálló: Nagy Péter → nincs „nagy”', () => {
    const stems = extractMatchingStems('Nagy Péter')
    assert.equal(stems.includes('nagy'), false)
    assert.ok(stems.includes('nagy peter'))
  })

  await test('köznév tő nem önálló: Magyar Telekom → nincs „magyar”', () => {
    const stems = extractMatchingStems('Magyar Telekom')
    assert.equal(stems.includes('magyar'), false)
    assert.ok(stems.includes('magyar telekom'))
  })

  await test('köznév hamis pozitív: „nagy raktár” nem cserélődik Nagy Péterre', () => {
    const repl = [{ needle: 'Nagy Péter', surrogate: '[[PERSON_1]]', fromStructuredField: true }]
    const text = 'A nagy raktár hétfőn nyit.'
    assert.equal(applyKnownValueReplacements(text, repl), text)
  })

  await test('substituteKnownValuesInText ENFORCE módban', async () => {
    const result = await substituteKnownValuesInText({
      text: 'A SPAR-nak küldjük.',
      replacements: SPAR_REPL,
      mode: 'enforce',
    })
    assert.equal(result.text, 'A [[COMPANY_1]]-nak küldjük.')
    assert.equal(result.appliedCount, 1)
  })

  await test('substituteKnownValuesInText OBSERVE módban nem cserél', async () => {
    const result = await substituteKnownValuesInText({
      text: 'A SPAR-nak küldjük.',
      replacements: SPAR_REPL,
      mode: 'observe',
    })
    assert.equal(result.text, 'A SPAR-nak küldjük.')
    assert.equal(result.appliedCount, 0)
  })

  console.log('\n--- DoD (§20): címkézett magyar fixture ---\n')

  await test('DoD: recall ≥ 80% a known-value fixture-ökön', async () => {
    let covered = 0
    let total = 0
    const misses: string[] = []

    for (const fixture of KNOWN_VALUE_EVAL_CASES) {
      const result = await substituteKnownValuesInText({
        text: fixture.text,
        replacements: fixture.replacements ?? [],
        mode: 'enforce',
      })
      for (const span of fixture.spans) {
        total += 1
        const tokenized = !result.text.includes(span.value) && result.text.includes('[[')
        if (tokenized) {
          covered += 1
        } else {
          misses.push(`${fixture.id}: „${span.value}”`)
        }
      }
    }

    const recall = computeRecall(covered, total)
    assert.ok(
      recall >= 0.8,
      `recall ${(recall * 100).toFixed(1)}% (${covered}/${total}); hiány: ${misses.join(', ')}`,
    )
  })

  await test('DoD: false positive ≤ 5% a known-value szótárral', () => {
    let falsePositives = 0
    const hits: string[] = []

    for (const fixture of KNOWN_VALUE_FALSE_POSITIVE_CASES) {
      const out = applyKnownValueReplacements(fixture.text, KNOWN_VALUE_EVAL_DICTIONARY)
      if (out !== fixture.text) {
        falsePositives += 1
        hits.push(fixture.id)
      }
    }

    const rate = computeFalsePositiveRate(falsePositives, KNOWN_VALUE_FALSE_POSITIVE_CASES.length)
    assert.ok(
      rate <= 0.05,
      `FP ${(rate * 100).toFixed(1)}% (${falsePositives}/${KNOWN_VALUE_FALSE_POSITIVE_CASES.length}); téves: ${hits.join(', ')}`,
    )
  })

  console.log(
    failures === 0
      ? '\nMinden APG-16 known-value teszt zöld.'
      : `\n${failures} teszt elbukott.`,
  )
  if (failures > 0) process.exit(1)
}

main()
