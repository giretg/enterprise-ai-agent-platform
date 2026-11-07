/**
 * Egy agent memóriáját a Projektek oldalon csak az olvashatja, aki az agentet is látja.
 * Futtatás: DATABASE_URL=postgresql://stub:stub@127.0.0.1:5432/stub tsx scripts/project-memory-access.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { findMemoryReadableAgent } from '../src/domain/project-work/memory-access'

const TENANT = 'tenant-a'
const HR = { id: 'agent-hr', tenantId: TENANT }

function deps(grant: { accessLevel: string } | null) {
  const grantQueries: unknown[] = []
  return {
    grantQueries,
    findAgent: async (agentId: string, tenantId: string) =>
      agentId === HR.id && tenantId === HR.tenantId ? HR : null,
    findAgentGrant: async (query: { tenantId: string; userId: string; agentId: string }) => {
      grantQueries.push(query)
      return grant
    },
  }
}

const ask = (role: string, tenantId = TENANT, agentId = HR.id) => ({ tenantId, userId: 'user-1', role, agentId })

async function main() {
  for (const role of ['viewer', 'operator']) {
    assert.equal(await findMemoryReadableAgent(deps(null), ask(role)), null, `${role} jogosultság nélkül nem olvashat`)
    assert.equal(await findMemoryReadableAgent(deps({ accessLevel: 'view' }), ask(role)), HR, `${role} view joggal olvashat`)
    assert.equal(await findMemoryReadableAgent(deps({ accessLevel: 'operate' }), ask(role)), HR, `${role} operate joggal olvashat`)
    assert.equal(await findMemoryReadableAgent(deps({ accessLevel: 'unknown' }), ask(role)), null, 'ismeretlen jogszint nem ad hozzáférést')
  }

  for (const role of ['admin', 'approver']) {
    assert.equal(await findMemoryReadableAgent(deps(null), ask(role)), HR, `${role} külön jog nélkül is olvashat`)
  }

  assert.equal(await findMemoryReadableAgent(deps(null), ask('admin', 'tenant-b')), null, 'másik szervezet agentjét admin sem éri el')
  assert.equal(await findMemoryReadableAgent(deps(null), ask('admin', TENANT, 'agent-none')), null, 'nem létező agent')

  const scoped = deps({ accessLevel: 'view' })
  await findMemoryReadableAgent(scoped, ask('viewer'))
  assert.deepEqual(scoped.grantQueries, [{ tenantId: TENANT, userId: 'user-1', agentId: HR.id }], 'a jogot az adott emberre és agentre kérdezi le')

  const actions = readFileSync(resolve(import.meta.dirname, '../src/app/actions/project-work.ts'), 'utf8')
  const listAction = actions.slice(
    actions.indexOf('export async function listProjectMemoryAction'),
    actions.indexOf('export async function deleteProjectMemoryAction'),
  )
  assert.match(listAction, /findMemoryReadableAgent\(/, 'a listázó művelet a jogellenőrzésen megy át')
  assert.doesNotMatch(listAction, /scopedAgent\(/, 'a listázó művelet nem elégszik meg a szervezet-egyezéssel')

  console.log('project-memory-access.test.ts: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
