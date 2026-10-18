/**
 * Tenant-admin / superadmin projektmemória-törlés: kuka gomb + in-app modal.
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
const projectsPage = readFileSync(
  resolve(import.meta.dirname, '../src/app/control-plane/projects/page.tsx'),
  'utf8',
)
const agentPage = readFileSync(
  resolve(import.meta.dirname, '../src/app/control-plane/agents/[agentId]/page.tsx'),
  'utf8',
)

assert.match(actions, /deleteProjectMemoryAction/)
assert.match(actions, /isSuperadmin\(ctx\.platformRoles\)/)
assert.match(actions, /hasMinimumRole\(ctx\.activeTenantRole, 'admin'\)/)
assert.match(projectsPage, /canDeleteMemory/)
assert.match(projectsPage, /isSuperadmin\(ctx\.platformRoles\)/)
assert.match(agentPage, /canDeleteMemory=\{canManage \|\| canDelete\}/)
assert.match(panel, /deleteProjectMemoryAction/)
assert.match(panel, /confirmDialog/)
assert.match(panel, /icon="trash"/)
assert.match(panel, /memoryTrashButton/)
assert.doesNotMatch(panel, /window\.confirm/)
assert.doesNotMatch(
  panel,
  /canDeleteMemory && item\.kind !== 'session_log'/,
  'a munkamenet-napló is törölhető',
)
console.log('project-memory-delete.test.ts: ok')
