/**
 * Agent írási jóváhagyás-módok (#739).
 * Futtatás: npx tsx scripts/write-approval-modes.test.ts
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_WRITE_APPROVAL_MODES,
  modesFromAgentRow,
  skipsWriteApproval,
  writeKindForTool,
} from '../src/lib/write-approval-modes'

const allDirect = {
  memory: 'direct',
  httpApi: 'direct',
  gmail: 'direct',
  drive: 'direct',
} as const

assert.equal(writeKindForTool('http_api_request'), 'httpApi')
assert.equal(writeKindForTool('gmail_send'), 'gmail')
assert.equal(writeKindForTool('google_drive_upload_file'), 'drive')
assert.equal(writeKindForTool('google_drive_update_file'), 'drive')
assert.equal(writeKindForTool('google_sheets_write_range'), 'drive')
assert.equal(writeKindForTool('platform.project_memory.write'), 'memory')
assert.equal(writeKindForTool('http_api_get'), null)

assert.equal(skipsWriteApproval('http_api_request', DEFAULT_WRITE_APPROVAL_MODES), false)
assert.equal(skipsWriteApproval('http_api_request', { ...DEFAULT_WRITE_APPROVAL_MODES, httpApi: 'direct' }), true)
assert.equal(skipsWriteApproval('gmail_send', { ...DEFAULT_WRITE_APPROVAL_MODES, httpApi: 'direct' }), false)
assert.equal(skipsWriteApproval('gmail_send', { ...DEFAULT_WRITE_APPROVAL_MODES, gmail: 'direct' }), true)
assert.equal(skipsWriteApproval('google_drive_create_folder', allDirect), true)
assert.equal(skipsWriteApproval('google_drive_update_file', { ...DEFAULT_WRITE_APPROVAL_MODES, drive: 'direct' }), true)
assert.equal(skipsWriteApproval('http_api_get', allDirect), false)
assert.equal(skipsWriteApproval('http_api_request', null), false)

assert.deepEqual(modesFromAgentRow({}), DEFAULT_WRITE_APPROVAL_MODES)
assert.equal(modesFromAgentRow({ httpApiWriteMode: 'direct' }).httpApi, 'direct')
assert.equal(modesFromAgentRow({ httpApiWriteMode: 'nope' }).httpApi, 'approval')

console.log('write-approval-modes.test.ts: ok')
