/**
 * Általános rekord-egyeztetés (issue #179 WP-2).
 * Futtatás: npm run test:reconcile-records
 *
 * Seam: tiszta `reconcileRecords` — két JSON-lista + kulcs/tolerancia →
 * státuszos unió. A modell csak az összefoglalót és a bizonytalan párokat kapja;
 * a teljes lista fájlba megy.
 */
import assert from 'node:assert/strict'
import {
  buildReconcileSummaryForModel,
  reconcileRecords,
  type ReconcileRecordsInput,
} from '../src/lib/reconcile-records'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

console.log('\n=== reconcile-records (issue #179 WP-2) ===\n')

check('email-kulcson párosít: rendben / módosítás / új / törlés', () => {
  const input: ReconcileRecordsInput = {
    left: [
      { email: 'a@x.com', name: 'Anna', amount: 100 },
      { email: 'b@x.com', name: 'Béla', amount: 200 },
      { email: 'c@x.com', name: 'Cili', amount: 50 },
    ],
    right: [
      { email: 'a@x.com', name: 'Anna', amount: 100 },
      { email: 'b@x.com', name: 'Béla', amount: 250 },
      { email: 'd@x.com', name: 'Dénes', amount: 10 },
    ],
    keyFields: ['email'],
    compareFields: [{ field: 'amount', mode: 'number', epsilon: 0 }],
  }
  const result = reconcileRecords(input)
  assert.equal(result.summary.rendben, 1)
  assert.equal(result.summary.modositas, 1)
  assert.equal(result.summary.ujRekord, 1)
  assert.equal(result.summary.torles, 1)
  assert.equal(result.summary.uncertain, 0)
  const byEmail = Object.fromEntries(
    result.rows
      .map((row) => {
        const email =
          (row.left?.email as string | undefined) ?? (row.right?.email as string | undefined) ?? '?'
        return [email, row.status] as const
      }),
  )
  assert.equal(byEmail['a@x.com'], 'Rendben')
  assert.equal(byEmail['b@x.com'], 'Módosítás szükséges')
  assert.equal(byEmail['c@x.com'], 'Új rekord')
  assert.equal(byEmail['d@x.com'], 'Törlés szükséges')
})

check('hiányzó másodlagos kulcs → részleges (bizonytalan) párosítás', () => {
  const result = reconcileRecords({
    left: [{ nev: 'Kovács János', szuletesiEv: '1960', anyjaNeve: 'Nagy Mária', hanyad: '1/2' }],
    right: [{ nev: 'Kovács János', szuletesiEv: null, anyjaNeve: null, hanyad: '1/2' }],
    keyFields: ['nev', 'szuletesiEv', 'anyjaNeve'],
    normalize: { nev: 'hu-name', szuletesiEv: 'year', anyjaNeve: 'hu-name' },
    compareFields: [{ field: 'hanyad', mode: 'fraction' }],
  })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].matchStrength, 'partial')
  assert.equal(result.summary.uncertain, 1)
  assert.equal(result.uncertain.length, 1)
  assert.match(result.uncertain[0].note, /bizonytalan|részleges|emberi/i)
})

check('eltérő születési év → NEM párosít (két külön ember)', () => {
  const result = reconcileRecords({
    left: [{ nev: 'Kovács János', szuletesiEv: '1960', anyjaNeve: 'Nagy Mária' }],
    right: [{ nev: 'Kovács János', szuletesiEv: '1990', anyjaNeve: 'Nagy Mária' }],
    keyFields: ['nev', 'szuletesiEv', 'anyjaNeve'],
    normalize: { nev: 'hu-name', szuletesiEv: 'year', anyjaNeve: 'hu-name' },
  })
  assert.equal(result.summary.ujRekord, 1)
  assert.equal(result.summary.torles, 1)
  assert.equal(result.summary.uncertain, 0)
})

check('tört-hányad tolerancia nélkül: 1/2 ≠ 2/4? — arány szerint egyenlő', () => {
  const result = reconcileRecords({
    left: [{ id: '1', hanyad: '1/2' }],
    right: [{ id: '1', hanyad: '2/4' }],
    keyFields: ['id'],
    compareFields: [{ field: 'hanyad', mode: 'fraction' }],
  })
  assert.equal(result.rows[0].status, 'Rendben')
})

check('szám tolerancia: 100.004 ≈ 100 epsilon 0.01 mellett', () => {
  const result = reconcileRecords({
    left: [{ sku: 'A', qty: 100.004 }],
    right: [{ sku: 'A', qty: 100 }],
    keyFields: ['sku'],
    compareFields: [{ field: 'qty', mode: 'number', epsilon: 0.01 }],
  })
  assert.equal(result.rows[0].status, 'Rendben')
})

check('modell-összefoglaló rövid, tartalmazza a bizonytalanokat, nem a teljes listát', () => {
  const left = Array.from({ length: 182 }, (_, i) => ({
    nev: `Személy ${i}`,
    szuletesiEv: String(1950 + (i % 40)),
    anyjaNeve: `Anyja ${i}`,
    hanyad: '1/182',
  }))
  const right = Array.from({ length: 249 }, (_, i) => ({
    nev: i < 182 ? `Személy ${i}` : `Extra ${i}`,
    szuletesiEv: i < 182 ? String(1950 + (i % 40)) : '2000',
    anyjaNeve: i < 182 ? `Anyja ${i}` : `Másik ${i}`,
    hanyad: i < 100 ? '1/182' : '1/100',
  }))
  // Szándékos bizonytalan: első rekordnál a jobb oldalon hiányzik a szül. év
  right[0] = { ...right[0], szuletesiEv: '', anyjaNeve: '' }

  const result = reconcileRecords({
    left,
    right,
    keyFields: ['nev', 'szuletesiEv', 'anyjaNeve'],
    normalize: { nev: 'hu-name', szuletesiEv: 'year', anyjaNeve: 'hu-name' },
    compareFields: [{ field: 'hanyad', mode: 'fraction' }],
  })
  assert.ok(result.summary.total >= 249)
  assert.ok(result.summary.uncertain >= 1)

  const summary = buildReconcileSummaryForModel(result, {
    outputPath: 'egyeztetes.json',
    maxUncertain: 5,
    identityFields: ['nev', 'szuletesiEv'],
  })
  assert.ok(summary.length < 4000, `összefoglaló túl hosszú: ${summary.length}`)
  assert.match(summary, /egyeztetes\.json/)
  assert.match(summary, /Bizonytalan|bizonytalan/)
  assert.doesNotMatch(summary, /Személy 50/)
})

if (failures > 0) {
  console.error(`\n${failures} teszt bukott\n`)
  process.exit(1)
}
console.log('\n✅ Minden teszt zöld\n')
