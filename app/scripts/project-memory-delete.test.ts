/**
 * Admin projektmemória-törlés: action + szerkesztő UI.
 * Futtatás: node --import tsx scripts/project-memory-delete.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const panel = readFileSync(
  resolve(import.meta.dirname, '../src/app/control-plane/projects/project-memory-panel.tsx'),
  'utf8',
)
const actions = readFileSync(
  resolve(import.meta.dirname, '../src/app/actions/project-work.ts'),
  'utf8',
)

assert.match(actions, /deleteProjectMemoryAction/)
assert.match(actions, /requireTenantRole\('admin'\)/)
assert.match(panel, /deleteProjectMemoryAction/)
assert.match(panel, /onDelete/)
console.log('project-memory-delete.test.ts: ok')
