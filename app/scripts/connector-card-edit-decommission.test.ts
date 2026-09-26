/**
 * Önfrissítő connector kártya: Megszüntetés az összecsukott soron.
 * Futtatás: npx tsx scripts/connector-card-edit-decommission.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { resolveSelfUpdatingSyncModalState } from '../src/app/control-plane/connectors/self-updating/self-updating-connectors-panel.tsx'

const src = readFileSync(
  resolve(import.meta.dirname, '../src/app/control-plane/connectors/self-updating/self-updating-connectors-panel.tsx'),
  'utf8',
)

test('autorefresh: az összecsukott soron is van Megszüntetés gomb (aktív kapcsolatnál)', () => {
  const openIndex = src.indexOf('{open ? (')
  assert.ok(openIndex > 0, 'nincs open-kapu az autorefresh kártyán')
  const collapsed = src.slice(0, openIndex)
  assert.match(collapsed, /!archived && !broken \? \([\s\S]*Megszüntetés/, 'nincs Megszüntetés gomb aktív kapcsolatnál')
  assert.match(
    collapsed,
    /onClick=\{\(\) => setOpen\(true\)\}[\s\S]{0,80}Megszüntetés|Megszüntetés[\s\S]{0,80}setOpen\(true\)/,
    'a Megszüntetés gomb nem nyitja meg a részleteket',
  )
})

test('archivált önfrissítő kapcsolat megjelenik a listában lifecycleState mezővel', () => {
  const actionSrc = readFileSync(
    resolve(import.meta.dirname, '../src/app/actions/self-updating-connectors.ts'),
    'utf8',
  )
  const panelSrc = readFileSync(
    resolve(import.meta.dirname, '../src/app/control-plane/provisioning/provisioning-panel.tsx'),
    'utf8',
  )
  assert.doesNotMatch(
    actionSrc,
    /connectorMode: 'self_updating', lifecycleState: 'active'/,
    'a listázás ne szűrjön ki archivált önfrissítő kapcsolatokat',
  )
  assert.match(actionSrc, /lifecycleState: row\.lifecycleState/)
  assert.match(panelSrc, /archivedSelfUpdatingRows/)
})

test('önfrissítő listázás: egy hibás sor nem dönti el az egész Promise.allSettled listát', () => {
  const actionSrc = readFileSync(
    resolve(import.meta.dirname, '../src/app/actions/self-updating-connectors.ts'),
    'utf8',
  )
  assert.match(actionSrc, /Promise\.allSettled/)
  assert.match(actionSrc, /loadError/)
})

test('frissítés után modal állapot: unchanged vs jóváhagyásra váró diff', () => {
  const row = {
    id: 'c1',
    name: 'API',
    specUrl: 'https://example.com/openapi.json',
    urlApproved: true,
    trusted: true,
    autoApproveEnabled: false,
    lastSyncedAt: null,
    activeSpecVersionId: 'v1',
    privacy: null,
    versions: [
      {
        id: 'v1',
        versionNo: 1,
        status: 'approved',
        diffSummary: null,
        capabilities: [],
        privacy: null,
        fetchedAt: '2026-01-01T00:00:00.000Z',
        approvedAt: '2026-01-01T00:00:00.000Z',
        approvedByName: 'admin',
      },
      {
        id: 'v2',
        versionNo: 2,
        status: 'proposed',
        diffSummary: { added: [{ op: 'GET /x', risk: 'low', change: 'added' }], breaking: [], narrowed: [], auth: [] },
        capabilities: [],
        privacy: null,
        fetchedAt: '2026-02-01T00:00:00.000Z',
        approvedAt: null,
        approvedByName: '',
      },
    ],
  }
  const unchanged = resolveSelfUpdatingSyncModalState({ kind: 'unchanged' }, row)
  assert.equal(unchanged.variant, 'message')
  assert.equal(unchanged.tone, 'success')
  assert.match(unchanged.message, /nem változott/i)

  const proposed = resolveSelfUpdatingSyncModalState({ kind: 'proposed', autoApproved: false }, row)
  assert.equal(proposed.variant, 'proposal')
  if (proposed.variant === 'proposal') assert.equal(proposed.row.id, 'c1')
})

test('frissítés gomb a kártyán belül sync modalt nyit (nem csak panel-szintű üzenet)', () => {
  assert.match(src, /SelfUpdatingSyncResultModal/)
  assert.match(src, /resolveSelfUpdatingSyncModalState/)
  assert.match(src, /onReload/)
  assert.doesNotMatch(src, /onSync=/)
})

console.log('\nÖsszes connector-card-edit-decommission teszt zöld')
