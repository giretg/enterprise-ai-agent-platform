/**
 * Sandbox-sor összecsukása + Megszüntetés gombok (sandbox és autorefresh).
 * Futtatás: npx tsx scripts/connector-card-edit-decommission.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')

function readSrc(rel: string) {
  return readFileSync(resolve(root, rel), 'utf8')
}

const SANDBOX_CARD = 'src/components/connectors/code-sandbox-connector-card.tsx'
const SELF_UPDATING_PANEL =
  'src/app/control-plane/connectors/self-updating/self-updating-connectors-panel.tsx'

test('sandbox: tesztelés, magyarázat és híváslog csak szerkesztési módban látszik', () => {
  const src = readSrc(SANDBOX_CARD)
  const expandedMarker = '{editing ? (\n        <div className="space-y-3 border-t'
  const gateIndex = src.indexOf(expandedMarker)
  assert.ok(gateIndex > 0, 'nincs editing-kapu a sandbox kártya kibontott blokkján')
  const collapsed = src.slice(0, gateIndex)
  const expanded = src.slice(gateIndex)
  assert.match(
    src,
    /\{editing \? \([\s\S]*?Kapcsolat tesztelése[\s\S]*?\) : null\}/,
    'a tesztgomb nem editing-kapu mögött van',
  )
  assert.strictEqual(
    src.split('Kapcsolat tesztelése').length - 1,
    1,
    'a tesztgomb pontosan egyszer, az editing-kapu mögött szerepelhet',
  )
  assert.ok(expanded.includes('{CODE_SANDBOX_HELP}'), 'a magyarázat nem a szerkesztési blokkban van')
  assert.doesNotMatch(collapsed, /\{CODE_SANDBOX_HELP\}/, 'a magyarázat összecsukva is látszik')
  assert.ok(expanded.includes('row.recentCalls'), 'a híváslog nem a szerkesztési blokkban van')
  assert.doesNotMatch(
    collapsed,
    /row\.recentCalls/,
    'a tesztelési log összecsukva is látszik',
  )
})

test('sandbox: összecsukva is van Megszüntetés gomb auditált leszereléssel', () => {
  const src = readSrc(SANDBOX_CARD)
  const expandedMarker = '{editing ? (\n        <div className="space-y-3 border-t'
  const gateIndex = src.indexOf(expandedMarker)
  assert.ok(gateIndex > 0, 'nincs editing-kapu a sandbox kártya kibontott blokkján')
  const collapsed = src.slice(0, gateIndex)
  assert.match(collapsed, /Megszüntetés/, 'nincs Megszüntetés gomb az összecsukott soron')
  assert.match(src, /decommissionActiveConnector/, 'a sandbox kártya nem a meglévő auditált leszerelést hívja')
  assert.match(src, /archived/, 'a leszerelés nem archived állapotba tesz')
})

test('autorefresh: az összecsukott soron is van Megszüntetés gomb', () => {
  const src = readSrc(SELF_UPDATING_PANEL)
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
