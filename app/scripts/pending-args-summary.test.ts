/**
 * HITL approval arg summaries must show every field execute uses.
 * Futtatás: npx tsx scripts/pending-args-summary.test.ts
 */
import assert from 'node:assert/strict'
import { pendingArgsSummary } from '../src/domain/gateway-operation/pending-args-summary'

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

check('http_api_request includes sorted query + body', () => {
  const text = pendingArgsSummary(
    'http_api_request',
    { method: 'POST', path: '/v1/users', query: { role: 'owner', admin: 'true' }, body: '{"ok":1}' },
    labels,
  )
  assert.equal(text, 'POST /v1/users?admin=true&role=owner\n{"ok":1}')
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
