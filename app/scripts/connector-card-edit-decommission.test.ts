/**
 * Önfrissítő connector kártya: Megszüntetés az összecsukott soron.
 * Futtatás: npx tsx scripts/connector-card-edit-decommission.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const src = readFileSync(
  resolve(import.meta.dirname, '../src/app/control-plane/connectors/self-updating/self-updating-connectors-panel.tsx'),
  'utf8',
)

test('autorefresh: az összecsukott soron is van Megszüntetés gomb', () => {
  const openIndex = src.indexOf('{open ? (')
  assert.ok(openIndex > 0, 'nincs open-kapu az autorefresh kártyán')
  const collapsed = src.slice(0, openIndex)
  assert.match(collapsed, /Megszüntetés/, 'nincs Megszüntetés gomb az összecsukott autorefresh soron')
  assert.match(
    collapsed,
    /onClick=\{\(\) => setOpen\(true\)\}[\s\S]{0,80}Megszüntetés|Megszüntetés[\s\S]{0,80}setOpen\(true\)/,
    'a Megszüntetés gomb nem nyitja meg a részleteket',
  )
})

console.log('\nÖsszes connector-card-edit-decommission teszt zöld')
