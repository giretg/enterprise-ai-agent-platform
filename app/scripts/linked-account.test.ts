import assert from 'node:assert/strict'
import {
  linkedAccountHandle,
  normalizeNickname,
  resolveLinkedAccountGrant,
} from '../src/domain/connector-grant/linked-account'

const personal = {
  id: 'g1',
  accountLabel: 'anna@gmail.com',
  nickname: 'magán',
}
const work = {
  id: 'g2',
  accountLabel: 'anna@ceg.hu',
  nickname: 'céges',
}

assert.equal(normalizeNickname('  Magán  '), 'Magán')
assert.equal(normalizeNickname(''), null)
assert.equal(normalizeNickname('x'.repeat(41)), null)

assert.equal(linkedAccountHandle(personal), 'magán')
assert.equal(linkedAccountHandle({ id: 'g3', accountLabel: 'x@y.hu', nickname: null }), 'x@y.hu')

{
  const missing = resolveLinkedAccountGrant([], undefined)
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.reason, 'connector_grant_missing')
}

{
  const single = resolveLinkedAccountGrant([personal], undefined)
  assert.equal(single.ok, true)
  if (single.ok) assert.equal(single.grant.id, 'g1')
}

{
  const stillSingle = resolveLinkedAccountGrant([personal], 'magán')
  assert.equal(stillSingle.ok, true)
  if (stillSingle.ok) assert.equal(stillSingle.grant.id, 'g1')
}

{
  const wrong = resolveLinkedAccountGrant([personal], 'céges')
  assert.equal(wrong.ok, false)
  if (!wrong.ok) assert.equal(wrong.reason, 'unknown_account')
}

{
  const ambiguous = resolveLinkedAccountGrant([personal, work], undefined)
  assert.equal(ambiguous.ok, false)
  if (!ambiguous.ok) {
    assert.equal(ambiguous.reason, 'account_required')
    assert.deepEqual(
      ambiguous.accounts.map((row) => row.account),
      ['magán', 'céges'],
    )
  }
}

{
  const byNick = resolveLinkedAccountGrant([personal, work], 'Céges')
  assert.equal(byNick.ok, true)
  if (byNick.ok) assert.equal(byNick.grant.id, 'g2')
}

{
  const byEmail = resolveLinkedAccountGrant([personal, work], 'anna@gmail.com')
  assert.equal(byEmail.ok, true)
  if (byEmail.ok) assert.equal(byEmail.grant.id, 'g1')
}

{
  const unknown = resolveLinkedAccountGrant([personal, work], 'harmadik')
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.equal(unknown.reason, 'unknown_account')
}

console.log('✅ linked-account picker: egy fiók, magán/céges, e-mail')
