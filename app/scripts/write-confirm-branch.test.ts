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

import { resolveWriteConfirmOffer } from '../src/domain/gateway-operation/write-confirm-branch'

const awaiting = {
  ok: true as const,
  view: {
    operationId: 'op-1',
    status: 'awaiting_approval' as const,
    toolName: 'google_drive_create_folder',
    idempotencyKey: 'k',
    definitionId: 'd',
    agentId: 'a',
    principalUserId: 'requester',
    connectorId: null,
    designatedApproverUserId: 'csilla',
    designatedApproverName: 'Csilla',
    errorCode: null,
    result: null,
    approval: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
}
const mint = async () => 'state'
assert.deepEqual(
  resolveWriteConfirmOffer({ mint }, awaiting, {
    userId: 'requester',
    tenantId: 't',
    role: 'operator',
    assumed: false,
  }),
  { confirmBranch: 'link', confirmBranchReason: 'designated_approver_other' },
)
assert.deepEqual(
  resolveWriteConfirmOffer({ mint }, awaiting, {
    userId: 'csilla',
    tenantId: 't',
    role: 'operator',
    assumed: false,
  }),
  { confirmBranch: 'form', confirmBranchReason: 'mrtr_form' },
)

console.log('write-confirm-branch.test.ts: ok')
