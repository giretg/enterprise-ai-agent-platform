/**
 * HITL approval arg summaries must show every field execute uses.
 * Futtatás: npx tsx scripts/pending-args-summary.test.ts
 */
import assert from 'node:assert/strict'
import { pendingArgsSummary, pendingOperationHeadline, splitLabelledSections } from '../src/domain/gateway-operation/pending-args-summary'

const labels = {
  memoryKind: 'memory',
  parentRoot: 'root',
  parentFolder: (id: string) => `parent: ${id}`,
}

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

check('binary input summaries show filenames, never bytes', () => {
  const inputFiles = JSON.stringify([{ path: 'attachments/data.xlsx', contentBase64: 'SECRET_BASE64' }])
  const text = pendingArgsSummary('sandbox_run', { inputFiles }, labels)
  assert.match(text, /data.xlsx/)
  assert.ok(!text.includes('SECRET_BASE64'))
  const warehouse = pendingArgsSummary('warehouse.prepare_import', { fileName: 'data.xlsx', fileBase64: 'SECRET_BASE64' }, labels)
  assert.match(warehouse, /data.xlsx/)
  assert.ok(!warehouse.includes('SECRET_BASE64'))
})

check('splitLabelledSections splits run-on labelled body', () => {
  const out = splitLabelledSections(
    'Téma: Google Pay. Folyamat: blogok (a/b) + linkek. Következő lépés: jóváhagyás után PATCH.',
  )
  assert.deepEqual(out, [
    { label: 'Téma', text: 'Google Pay.' },
    { label: 'Folyamat', text: 'blogok (a/b) + linkek.' },
    { label: 'Következő lépés', text: 'jóváhagyás után PATCH.' },
  ])
  assert.deepEqual(splitLabelledSections('plain text, no labels'), [
    { label: null, text: 'plain text, no labels' },
  ])
})

check('http_api_request includes sorted query + pretty body', () => {
  const text = pendingArgsSummary(
    'http_api_request',
    { method: 'POST', path: '/v1/users', query: { role: 'owner', admin: 'true' }, body: '{"ok":1}' },
    labels,
  )
  assert.equal(text, 'POST /v1/users?admin=true&role=owner\n{\n  "ok": 1\n}')
})

check('http_api_request headline prefers endpoint description', () => {
  assert.equal(
    pendingOperationHeadline(
      'http_api_request',
      { method: 'POST', path: '/v1/tasks' },
      { connectorName: 'CRM', endpointDescription: 'Teendő létrehozása' },
    ),
    'CRM: Teendő létrehozása',
  )
  assert.equal(
    pendingOperationHeadline('http_api_request', { method: 'POST', path: '/v1/tasks' }, { connectorName: 'CRM' }),
    'CRM: POST /v1/tasks',
  )
})

check('gmail_send never falls through to Drive root chrome', () => {
  const text = pendingArgsSummary(
    'gmail_send',
    { to: 'a@b.c', subject: 'Hi', body: 'Hello' },
    labels,
  )
  assert.match(text, /^new message\nto: a@b\.c\nsubject: Hi\nHello$/)
  assert.ok(!text.includes('root'))
})

check('mail_send approval card shows from mailbox', () => {
  const text = pendingArgsSummary(
    'mail_send',
    { account: 'szamlazas@ceg.hu', to: 'anna@x.hu', subject: 'Összefoglaló', body: 'Szia' },
    labels,
  )
  assert.match(text, /^from: szamlazas@ceg\.hu\nnew message\nto: anna@x\.hu/)
  assert.equal(
    pendingOperationHeadline('mail_send', { account: 'szamlazas@ceg.hu', subject: 'Összefoglaló' }),
    'Levél innen: szamlazas@ceg.hu, tárgy: Összefoglaló',
  )
})

check('mail_send without account must not invent agent own mailbox', () => {
  const text = pendingArgsSummary(
    'mail_send',
    { to: 'anna@x.hu', subject: 'Összefoglaló', body: 'Szia' },
    labels,
  )
  assert.equal(text.includes('saját postafiók'), false)
  assert.match(text, /^new message\nto: anna@x\.hu/)
})

check('gmail_send draftId omits decoy body', () => {
  const text = pendingArgsSummary(
    'gmail_send',
    { draftId: 'dr1', body: 'benign looking' },
    labels,
  )
  assert.equal(text, 'draftId: dr1')
})

check('project_memory.write surfaces body + replaceId + mergeIds', () => {
  const text = pendingArgsSummary(
    'platform.project_memory.write',
    {
      kind: 'decision',
      title: 'Office hours',
      body: 'Closed Fridays',
      projectKey: '__general__',
      replaceId: 'id-a',
      mergeIds: 'id-b,id-c',
    },
    labels,
  )
  assert.match(text, /decision: Office hours \(__general__\)/)
  assert.match(text, /Closed Fridays/)
  assert.match(text, /replaceId: id-a/)
  assert.match(text, /mergeIds: id-b,id-c/)
})

if (failures) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nAll pending-args-summary checks passed')
