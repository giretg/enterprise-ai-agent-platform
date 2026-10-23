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

check('http_api_request surfaces linked account for multi-mailbox Calendar', () => {
  const text = pendingArgsSummary(
    'http_api_request',
    {
      account: 'magán',
      method: 'POST',
      path: '/calendar/v3/calendars/primary/events',
      body: '{"summary":"1:1"}',
    },
    labels,
  )
  assert.match(text, /^account: magán\n/)
  assert.match(text, /POST \/calendar\/v3\/calendars\/primary\/events/)
  assert.equal(
    pendingOperationHeadline(
      'http_api_request',
      {
        account: 'magán',
        method: 'POST',
        path: '/calendar/v3/calendars/primary/events',
      },
      { connectorName: 'Google Calendar' },
    ),
    'Google Calendar: POST /calendar/v3/calendars/primary/events (magán)',
  )
  assert.equal(
    pendingOperationHeadline(
      'http_api_request',
      { account: 'céges', method: 'POST', path: '/calendar/v3/calendars/primary/events' },
      { connectorName: 'Google Calendar', endpointDescription: 'Esemény létrehozása' },
    ),
    'Google Calendar: Esemény létrehozása (céges)',
  )
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
