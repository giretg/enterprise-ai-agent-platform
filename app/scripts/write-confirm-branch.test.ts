/**
 * Futtatás: node --import tsx scripts/write-confirm-branch.test.ts
 */
import assert from 'node:assert/strict'
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server'
import {
  MRTR_PROTOCOL_VERSION,
  writeConfirmLinkReason,
} from '../src/domain/gateway-operation/write-confirm-branch'

assert.equal(writeConfirmLinkReason({}, false), 'no_request_state_key')
assert.equal(
  writeConfirmLinkReason({ [PROTOCOL_VERSION_META_KEY]: '2025-03-26' }, true),
  'protocol_not_2026_07_28',
)
assert.equal(
  writeConfirmLinkReason(
    {
      [PROTOCOL_VERSION_META_KEY]: MRTR_PROTOCOL_VERSION,
      [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { url: {} } },
    },
    true,
  ),
  'elicitation_url_only',
)
assert.equal(
  writeConfirmLinkReason({ [PROTOCOL_VERSION_META_KEY]: MRTR_PROTOCOL_VERSION }, true),
  'no_form_elicitation',
)

console.log('write-confirm-branch.test.ts: ok')
