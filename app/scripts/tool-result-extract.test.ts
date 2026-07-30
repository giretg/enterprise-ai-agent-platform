/**
 * Nagy tool-eredmény mező-kivonatolása (issue #179 WP-1).
 * Futtatás: npm run test:tool-result-extract
 *
 * A seam: tiszta extract függvény — a modell kontextusába NEM kerül a teljes
 * adathalmaz, csak a kivonat metaadata. Acceptance: 300 sor × 3 mező → fájlba,
 * a visszatérő összefoglaló < 2000 karakter.
 */
import assert from 'node:assert/strict'
import {
  EXTERNAL_DATA_CLOSE,
  EXTERNAL_DATA_OPEN,
  EXTERNAL_DATA_WARNING,
} from '../src/domain/tool-broker/tool-result-envelope'
import {
  buildExtractSummary,
  extractToolResultRows,
  formatLargeToolResultPreview,
} from '../src/domain/agent/tool-result-extract'

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

console.log('\n=== tool-result-extract (issue #179 WP-1) ===\n')

check('tömb JSON-ból három mezőt vesz ki, a többi mezőt eldobja', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({
    id: i + 1,
    nev: `Tulajdonos ${i + 1}`,
    szuletesiEv: 1950 + (i % 50),
    anyjaNeve: `Anyja ${i + 1}`,
    cim: `Hosszú cím ${i + 1} `.repeat(20),
    megjegyzes: 'felesleges mező '.repeat(30),
  }))
  const result = extractToolResultRows(JSON.stringify(rows), { fields: ['nev', 'szuletesiEv', 'anyjaNeve'] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.rowCount, 300)
  assert.deepEqual(Object.keys(result.rows[0]).sort(), ['anyjaNeve', 'nev', 'szuletesiEv'])
  assert.equal(result.rows[0].nev, 'Tulajdonos 1')
  assert.equal(result.rows[299].szuletesiEv, 1950 + (299 % 50))
})

check('envelope-olt (external_untrusted) tartalomból is kinyeri a JSON-t', () => {
  const payload = JSON.stringify([
    { nev: 'A', szuletesiEv: 1960, zaj: 'x'.repeat(500) },
    { nev: 'B', szuletesiEv: 1970, zaj: 'y'.repeat(500) },
  ])
  const enveloped = [EXTERNAL_DATA_WARNING, EXTERNAL_DATA_OPEN, payload, EXTERNAL_DATA_CLOSE].join('\n')
  const result = extractToolResultRows(enveloped, { fields: ['nev', 'szuletesiEv'] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.rowCount, 2)
  assert.deepEqual(result.rows, [
    { nev: 'A', szuletesiEv: 1960 },
    { nev: 'B', szuletesiEv: 1970 },
  ])
})

check('objektum belsejében lévő tömböt arrayPath-tal találja meg', () => {
  const payload = JSON.stringify({
    meta: { page: 1 },
    data: { customers: Array.from({ length: 5 }, (_, i) => ({ id: i, name: `C${i}`, skip: true })) },
  })
  const result = extractToolResultRows(payload, {
    fields: ['id', 'name'],
    arrayPath: 'data.customers',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.rowCount, 5)
  assert.deepEqual(result.rows[2], { id: 2, name: 'C2' })
})

check('hiányzó tömb hibája tippel top-level kulcsokat / tömböket', () => {
  // Két tömb → nem egyértelmű; arrayPath nélkül fail + tipp.
  const payload = JSON.stringify({
    meta: { ok: true },
    owners: [{ nev: 'A' }],
    partners: [{ nev: 'B' }],
  })
  const result = extractToolResultRows(payload, { fields: ['nev'] })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /arrayPath/)
  assert.match(result.error, /owners\[1\]/)
  assert.match(result.error, /partners\[1\]/)
  assert.match(result.error, /meta/)
})

check('az összefoglaló < 2000 karakter 300 soros kivonatnál is', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({
    nev: `Tulajdonos ${i + 1}`,
    szuletesiEv: 1950 + (i % 50),
    anyjaNeve: `Anyja ${i + 1}`,
  }))
  const summary = buildExtractSummary({
    outputPath: 'nyilvantartas-kivonat.json',
    fields: ['nev', 'szuletesiEv', 'anyjaNeve'],
    rowCount: 300,
    sampleRows: rows.slice(0, 3),
    bytes: 12_345,
  })
  assert.ok(summary.length < 2000, `összefoglaló túl hosszú: ${summary.length}`)
  assert.match(summary, /300/)
  assert.match(summary, /nyilvantartas-kivonat\.json/)
  assert.doesNotMatch(summary, /Tulajdonos 50/)
})

check('nagy eredmény előnézete fájl-alapú továbbdolgozásra irányít, nem visszaolvasásra', () => {
  const preview = formatLargeToolResultPreview({
    archivePath: '.tool-results/01-http_api_get-crm.json',
    workspacePath: 'tool-outputs/01-http_api_get-crm.json',
    chars: 80_000,
    bytes: 82_000,
    previewText: '{"customers":[{"id":1}]}',
  })
  assert.match(preview, /\.tool-results\/01-http_api_get-crm\.json/)
  assert.match(preview, /tool-outputs\/01-http_api_get-crm\.json/)
  assert.match(preview, /tool_result_extract/)
  assert.match(preview, /reconcile_records/)
  assert.doesNotMatch(preview, /olvasd tovább a tool_result_read/)
  assert.match(preview, /A teljes eredmény elmentve/)
})

if (failures > 0) {
  console.error(`\n${failures} teszt bukott\n`)
  process.exit(1)
}
console.log('\n✅ Minden teszt zöld\n')
