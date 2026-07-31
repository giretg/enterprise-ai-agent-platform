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
  assertReconcileSizeWithinLimit,
  buildReconcileSummaryForModel,
  MAX_RECONCILE_ROWS_PER_SIDE,
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

check('teljes egyezés győz a részleges felett — a pontos pár NEM esik ki némán', () => {
  // Sorrend-csapda: az első bal sor csak részlegesen (hiányos kulcson) illik R0-ra,
  // a MÁSODIK bal sor viszont minden kulcson pontosan. A régi mohó párosítás az
  // elsőnek adta R0-t, a valódi pontos párt pedig „Új rekordként" némán elvesztette.
  const result = reconcileRecords({
    left: [
      { nev: 'Kovács János', szuletesiEv: '', anyjaNeve: '' },
      { nev: 'Kovács János', szuletesiEv: '1960', anyjaNeve: 'Nagy Mária' },
    ],
    right: [{ nev: 'Kovács János', szuletesiEv: '1960', anyjaNeve: 'Nagy Mária' }],
    keyFields: ['nev', 'szuletesiEv', 'anyjaNeve'],
    normalize: { nev: 'hu-name', szuletesiEv: 'year', anyjaNeve: 'hu-name' },
  })
  // A pontos pár (L1 ↔ R0) „Rendben", teljes kulcson.
  const fullRow = result.rows.find((r) => r.matchStrength === 'full')
  assert.ok(fullRow, 'a pontos párnak meg kell jelennie teljes (full) egyezésként')
  assert.equal(fullRow!.status, 'Rendben')
  // R0-t a pontos pár vitte el → nincs „Törlés szükséges" (nem maradt pártalan jobb sor).
  assert.equal(result.summary.torles, 0)
  // A párját vesztett, versengő bal sor NEM „Új rekord" (az beszúrást sugallna),
  // hanem külön ellenőrzési státusz + uncertain a lefoglalt jobb sorra.
  assert.equal(result.summary.ujRekord, 0)
  assert.equal(result.summary.ellenorzes, 1)
  assert.equal(result.summary.uncertain, 1)
  const contested = result.rows.find((r) => r.status === 'Ellenőrzés szükséges')
  assert.ok(contested)
  assert.equal(contested!.right?.szuletesiEv, '1960')
  assert.ok(result.uncertain.some((u) => u.note.includes('emberi ellenőrzés')))
  assert.equal(result.uncertain[0].rightIndex, 0)
})

check('versenyben elvesztett sor a ténylegesen lefoglalt jobb jelöltre mutat', () => {
  // L2 jelöltjei: R0 (partial, lista elején) és R1 (full). Mindkettőt más bal sor
  // viszi el — a régi kód candidates[0]=R0-t adta volna; a helyes uncertain a
  // lefoglalt full R1-re mutat (preferált párosítási jelölt).
  const result = reconcileRecords({
    left: [
      { nev: 'Kovács', y: '1960', i: 'A' }, // L0 → R1 full
      { nev: 'Kovács', y: '', i: '' }, // L1 → R0 partial (2. kör)
      { nev: 'Kovács', y: '1960', i: 'A' }, // L2 contested
    ],
    right: [
      { nev: 'Kovács', y: '', i: '' }, // R0
      { nev: 'Kovács', y: '1960', i: 'A' }, // R1
    ],
    keyFields: ['nev', 'y', 'i'],
    normalize: { nev: 'hu-name', y: 'year', i: 'trim' },
  })
  assert.equal(result.summary.ellenorzes, 1)
  assert.equal(result.summary.ujRekord, 0)
  const u = result.uncertain.find((x) => x.leftIndex === 2)
  assert.ok(u, 'L2 uncertain')
  assert.equal(u!.rightIndex, 1)
  assert.equal(u!.right.i, 'A')
  // Régi bug regresszió: ne az első (R0) jelöltre mutasson.
  assert.notEqual(u!.rightIndex, 0)
})

check('méret-kapu: túl nagy bemenet érthető hibával áll le (nem fagy be)', () => {
  assert.throws(
    () => assertReconcileSizeWithinLimit(MAX_RECONCILE_ROWS_PER_SIDE + 1, 1),
    /túl sok sor/,
  )
  // Pár-szorzat felső határ: 3000 × 3000 = 9M > 4M.
  assert.throws(() => assertReconcileSizeWithinLimit(3000, 3000), /túl nagy/)
  // A tényleges egyeztetés is fail-fast, mielőtt az O(n×m) hurok elindulna.
  const big = Array.from({ length: MAX_RECONCILE_ROWS_PER_SIDE + 1 }, (_, i) => ({ id: String(i) }))
  assert.throws(() => reconcileRecords({ left: big, right: [{ id: '1' }], keyFields: ['id'] }))
  // A támogatott mérettartomány (a spec Novaj-esete: 182 × 249) változatlanul átmegy.
  assert.doesNotThrow(() => assertReconcileSizeWithinLimit(182, 249))
})

if (failures > 0) {
  console.error(`\n${failures} teszt bukott\n`)
  process.exit(1)
}
console.log('\n✅ Minden teszt zöld\n')
