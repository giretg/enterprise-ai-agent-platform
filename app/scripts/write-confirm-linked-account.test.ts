/**
 * Multi-mailbox HITL must name the linked account execute will use.
 * Futtatás: npx tsx scripts/write-confirm-linked-account.test.ts
 */
import assert from 'node:assert/strict'
import {
  gmailComposeConfirmTarget,
  linkedAccountConfirmSuffix,
} from '../src/domain/gateway-operation/linked-account-confirm'

assert.equal(linkedAccountConfirmSuffix({}), '')
assert.equal(linkedAccountConfirmSuffix({ account: '  magán  ' }), 'fiók: magán')

{
  const target = gmailComposeConfirmTarget({
    account: 'magán',
    to: 'boss@ceg.hu',
    subject: 'Jelentés',
  })
  assert.match(target, /fiók: magán/)
  assert.match(target, /címzett: boss@ceg\.hu/)
  assert.match(target, /tárgy: Jelentés/)
}

{
  const target = gmailComposeConfirmTarget({
    account: 'céges',
    draftId: 'dr-1',
    body: 'decoy',
  })
  assert.equal(target, 'Gmail piszkozat elküldése: dr-1, fiók: céges')
}

console.log('write-confirm-linked-account.test.ts: ok')
