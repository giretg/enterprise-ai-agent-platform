/**
 * Natív window.confirm / window.prompt helyett in-app ConfirmDialog.
 * Futtatás: npx tsx scripts/confirm-dialog.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')

function readSrc(rel: string) {
  return readFileSync(resolve(root, rel), 'utf8')
}

const CALL_SITES = [
  'src/components/processes/process-definition-list.tsx',
  'src/components/processes/process-detail-view.tsx',
  'src/components/monitors/monitor-list.tsx',
  'src/components/playbooks/step-template-admin.tsx',
  'src/components/playbooks/playbook-detail.tsx',
  'src/components/skills/skill-catalog-manager.tsx',
  'src/components/tickets/ticket-detail.tsx',
  'src/app/control-plane/provisioning/provisioning-panel.tsx',
] as const

test('ConfirmDialogHost a közös AuthProviders-ben mountolódik', () => {
  const src = readSrc('src/components/auth/providers.tsx')
  assert.match(src, /ConfirmDialogHost/)
  assert.match(src, /from '@\/components\/ui\/confirm-dialog'/)
})

test('a confirm-dialog modul exportálja a promise API-t és a hostot', () => {
  const src = readSrc('src/components/ui/confirm-dialog.tsx')
  assert.match(src, /export function confirmDialog/)
  assert.match(src, /export function promptDialog/)
  assert.match(src, /export function ConfirmDialogHost/)
  assert.match(src, /createPortal/)
  assert.match(src, /role="dialog"/)
  assert.match(src, /aria-modal="true"/)
})

test('egyetlen UI híváshely sem használ natív confirm/prompt-ot', () => {
  for (const rel of CALL_SITES) {
    const src = readSrc(rel)
    assert.doesNotMatch(
      src,
      /\bwindow\.confirm\s*\(/,
      `${rel} még window.confirm-ot hív`,
    )
    assert.doesNotMatch(src, /(?<![\w.])confirm\s*\(\s*[`'"]/, `${rel} még natív confirm-ot hív`)
    assert.doesNotMatch(src, /(?<![\w.])prompt\s*\(\s*[`'"]/, `${rel} még natív prompt-ot hív`)
    assert.match(
      src,
      /confirmDialog|promptDialog/,
      `${rel} nem használja a confirmDialog / promptDialog API-t`,
    )
  }
})

console.log('\nÖsszes confirm-dialog teszt zöld')
