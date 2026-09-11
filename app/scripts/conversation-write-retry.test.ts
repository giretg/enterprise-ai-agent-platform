import assert from 'node:assert/strict'
import test from 'node:test'
import { isRetryableMessageAppendError } from '../src/repositories/postgres/conversation-repository'

test('az átmeneti adatbázis- és tranzakcióhibák új tranzakcióban ismételhetők', () => {
  for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2028', 'P2034', 'P2002']) {
    assert.equal(isRetryableMessageAppendError({ code }), true, code)
  }
  assert.equal(isRetryableMessageAppendError({ code: 'P2025' }), false)
  assert.equal(isRetryableMessageAppendError(new Error('conversation_not_found')), false)
})
