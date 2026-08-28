/**
 * Drive connector kritikus szerződés-regressziók (issue #378 / critical bug hunt).
 * Futtatás: npx tsx scripts/google-drive-critical-contracts.test.ts
 */
import assert from 'node:assert/strict'
import {
  validateToolOutput,
} from '../src/domain/tool-broker/tool-output-contract'
import { resolveToolOutputContract } from '../src/domain/tool-broker/tool-output-contracts'

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.error(`✗ ${name}`)
    throw e
  }
}

test('create_folder nested file.id → measured effect (not empty)', () => {
  const verdict = validateToolOutput({
    tool: 'google_drive_create_folder',
    output: {
      file: { id: 'folder-1', name: 'X', mimeType: 'application/vnd.google-apps.folder' },
      created: true,
    },
    contract: resolveToolOutputContract('google_drive_create_folder'),
    sideEffecting: true,
  })
  assert.equal(verdict.outcome, 'ok')
  assert.equal(verdict.effect?.amount, 1)
  assert.equal(verdict.effect?.target, 'folder-1')
})

test('copy_file nested file.id → measured effect', () => {
  const verdict = validateToolOutput({
    tool: 'google_drive_copy_file',
    output: {
      file: { id: 'copy-1', name: 'Másolat', mimeType: 'text/plain' },
      created: true,
    },
    contract: resolveToolOutputContract('google_drive_copy_file'),
    sideEffecting: true,
  })
  assert.equal(verdict.outcome, 'ok')
  assert.equal(verdict.effect?.target, 'copy-1')
})

test('update_file success nested file.id → ok', () => {
  const verdict = validateToolOutput({
    tool: 'google_drive_update_file',
    output: {
      file: { id: 'f1', name: 'a.txt', mimeType: 'text/plain' },
      conflict: false,
    },
    contract: resolveToolOutputContract('google_drive_update_file'),
    sideEffecting: true,
  })
  assert.equal(verdict.outcome, 'ok')
  assert.equal(verdict.effect?.amount, 1)
})

test('update_file conflict:true → empty (write did not apply)', () => {
  const verdict = validateToolOutput({
    tool: 'google_drive_update_file',
    output: {
      file: { id: 'f1', name: 'a.txt', mimeType: 'text/plain', modifiedTime: '2020-01-01T00:00:00.000Z' },
      conflict: true,
    },
    contract: resolveToolOutputContract('google_drive_update_file'),
    sideEffecting: true,
  })
  assert.equal(verdict.outcome, 'empty')
  assert.equal(verdict.effect?.amount, 0)
  assert.match(verdict.reason ?? '', /conflict/i)
})

test('search with nextPageToken → partial (not silent complete)', () => {
  const verdict = validateToolOutput({
    tool: 'google_drive_search',
    output: { files: [{ id: '1' }], nextPageToken: 'page-2' },
    contract: resolveToolOutputContract('google_drive_search'),
    sideEffecting: false,
  })
  assert.equal(verdict.outcome, 'partial')
})

test('list_drives with nextPageToken → partial', () => {
  const verdict = validateToolOutput({
    tool: 'google_drive_list_drives',
    output: { drives: [{ id: 'd1', name: 'Shared' }], nextPageToken: 'more' },
    contract: resolveToolOutputContract('google_drive_list_drives'),
    sideEffecting: false,
  })
  assert.equal(verdict.outcome, 'partial')
})

console.log('\nAll google-drive-critical-contracts tests passed.')
