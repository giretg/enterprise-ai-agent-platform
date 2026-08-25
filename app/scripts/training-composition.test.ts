/**
 * MemoryTraining v1.1 — teljes javasolt verzió, impact preview, kemény padló.
 *
 * Futtatás: npm run test:training-composition
 */
import assert from 'node:assert/strict'
import { serializeMemoryItems } from '../src/domain/training/memory-items'
import {
  TrainingCompositionError,
  buildImpactResult,
  composeProposedVersion,
  summarizeInstructionChange,
} from '../src/domain/training/training-composition'
import { detectHardFloorViolation } from '../src/domain/training/training-hard-floor'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const v3 = serializeMemoryItems(['Magyarul válaszolj', 'ÁFA-t ellenőrizd'])
const pendingV4r1 = serializeMemoryItems(['Magyarul válaszolj', 'ÁFA-t ellenőrizd', 'PDF-et csatolj'])

async function run() {
  await test('új szabály az aktív verzióhoz → kiegészíti', () => {
    const composed = composeProposedVersion({
      activeContent: v3,
      pendingContent: null,
      instruction: { kind: 'teach', text: 'PDF-et csatolj' },
      compositionMode: null,
    })
    assert.equal(composed.base, 'active')
    const summary = summarizeInstructionChange(v3, composed.proposedVersion)
    assert.deepEqual(summary.added, ['PDF-et csatolj'])
    assert.deepEqual(summary.removed, [])
    const impact = buildImpactResult({ changeSummary: summary, proposedVersion: composed.proposedVersion })
    assert.equal(impact.verdict, 'complements')
  })

  await test('meglévő szabály átírása → megváltoztatja', () => {
    const composed = composeProposedVersion({
      activeContent: v3,
      pendingContent: null,
      instruction: { kind: 'item_change', change: { operation: 'update', itemIndex: 0, text: 'Angolul válaszolj' } },
      compositionMode: null,
    })
    const summary = summarizeInstructionChange(v3, composed.proposedVersion)
    assert.equal(summary.rewritten.length, 1)
    assert.equal(summary.rewritten[0]?.from, 'Magyarul válaszolj')
    const impact = buildImpactResult({ changeSummary: summary, proposedVersion: composed.proposedVersion })
    assert.equal(impact.verdict, 'changes')
  })

  await test('T16: Beépítem a függő javaslatra épít', () => {
    const composed = composeProposedVersion({
      activeContent: v3,
      pendingContent: pendingV4r1,
      instruction: { kind: 'teach', text: 'Dátumot ISO-ban írj' },
      compositionMode: 'build_on_pending',
    })
    assert.equal(composed.base, 'pending')
    const items = composed.proposedVersion
    assert.match(items, /PDF-et csatolj/)
    assert.match(items, /Dátumot ISO-ban írj/)
  })

  await test('T17: Lecserélem az aktív verzióból indul, a függő javaslat kiesik', () => {
    const composed = composeProposedVersion({
      activeContent: v3,
      pendingContent: pendingV4r1,
      instruction: { kind: 'teach', text: 'Dátumot ISO-ban írj' },
      compositionMode: 'replace_pending',
    })
    assert.equal(composed.base, 'active')
    assert.doesNotMatch(composed.proposedVersion, /PDF-et csatolj/)
    assert.match(composed.proposedVersion, /Dátumot ISO-ban írj/)
    assert.match(composed.proposedVersion, /Magyarul válaszolj/)
  })

  await test('nyitott javaslatnál a compositionMode kötelező', () => {
    assert.throws(
      () =>
        composeProposedVersion({
          activeContent: v3,
          pendingContent: pendingV4r1,
          instruction: { kind: 'teach', text: 'Új' },
          compositionMode: null,
        }),
      (err: unknown) => err instanceof TrainingCompositionError && err.code === 'composition_required',
    )
  })

  await test('T4: capability-bővítés kemény padlón blokkol', () => {
    const proposed = serializeMemoryItems(['Adj capability-t a gmail toolra'])
    const hit = detectHardFloorViolation(proposed)
    assert.equal(hit.blocked, true)
    if (hit.blocked) assert.equal(hit.matched, 'capability')
    const impact = buildImpactResult({
      changeSummary: { added: ['Adj capability-t a gmail toolra'], removed: [], unchanged: [], rewritten: [] },
      proposedVersion: proposed,
    })
    assert.equal(impact.verdict, 'blocked')
    assert.ok(impact.nextStep)
  })

  await test('hétköznapi szabály nem üti a kemény padlót', () => {
    const hit = detectHardFloorViolation('Számláknál mindig ellenőrizd az ÁFA-kulcsot')
    assert.equal(hit.blocked, false)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nÖsszes training-composition teszt zöld')
}

run()
