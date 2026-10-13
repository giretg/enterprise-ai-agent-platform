/**
 * Eszköz-katalógus (#872) — DB-mentes tesztek.
 * Futtatás: npm run test:client-policy-tool-catalog
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import hermes from './fixtures/hermes-core-tools.json'
import { AdminPolicyError, adminPolicySaveSchema, classifyTenantTool, saveAdminPolicy, type AdminPolicyStore } from '../src/domain/client-policy/admin-policy'
import { getPolicySnapshot } from '../src/domain/client-policy/policy-service'
import type { PolicyRow } from '../src/domain/client-policy/resolve-effective-policy'
import {
  DEFAULT_TOOL_CATALOG,
  classifyTool,
  effectiveToolCatalog,
  parseTenantToolCatalog,
  stillUnclassified,
} from '../src/domain/client-policy/tool-catalog'
import type { AuditAppendInput } from '../src/lib/audit/types'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import { assertAuditMetadataSafe } from '../src/lib/audit/payload-guard'

const T = '11111111-1111-4111-8111-111111111111'
const U = '22222222-2222-4222-8222-222222222222'
const here = dirname(fileURLToPath(import.meta.url))

async function main() {
  // A pinelt Hermes minden alapeszköze pontosan egy osztályba esik (új eszköz → piros, nem csendes tiltás).
  const missing = hermes.tools.filter((tool) => classifyTool(DEFAULT_TOOL_CATALOG, tool) === null)
  assert.deepEqual(missing, [], `besorolatlan Hermes-alapeszköz: ${missing.join(', ')}`)
  assert.equal(new Set(DEFAULT_TOOL_CATALOG.map((e) => e.pattern)).size, DEFAULT_TOOL_CATALOG.length, 'duplikált minta')

  // A Guard offline tartaléka ugyanaz, mint a szerver alapértelmezése.
  const policyPy = readFileSync(join(here, '../../clients/hermes-guard/excellence-guard/policy.py'), 'utf8')
  const block = policyPy.slice(policyPy.indexOf('FALLBACK_CATALOG = ['), policyPy.indexOf('\n]\n', policyPy.indexOf('FALLBACK_CATALOG = [')))
  const fallback = [...block.matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map(([, pattern, cls]) => [pattern, cls])
  assert.deepEqual(fallback, DEFAULT_TOOL_CATALOG.map((e) => [e.pattern, e.class]))

  // Pontos név előbb, utána a leghosszabb minta; a tenant-besorolás felülír.
  assert.equal(classifyTool(DEFAULT_TOOL_CATALOG, 'browser_vault_fill'), 'capability:browser:use')
  assert.equal(classifyTool(DEFAULT_TOOL_CATALOG, 'mcp__crm__read'), 'mcp')
  assert.equal(classifyTool(DEFAULT_TOOL_CATALOG, 'ha_call_service'), null)
  const tenantCatalog = parseTenantToolCatalog({ toolCatalog: { ha_call_service: 'denied', terminal: 'always', 'bad*': 'always', x: 'nope' } })
  assert.deepEqual(tenantCatalog, { ha_call_service: 'denied', terminal: 'always' })
  const effective = effectiveToolCatalog(tenantCatalog)
  assert.equal(classifyTool(effective, 'terminal'), 'always')
  assert.equal(effective.filter((e) => e.pattern === 'terminal').length, 1)
  const seen = [
    { tool: 'ha_call_service', attempts: 3, lastSeenAt: new Date(), hermesVersion: 'v0.21.3' },
    { tool: 'new_tool', attempts: 1, lastSeenAt: new Date(), hermesVersion: null },
  ]
  assert.deepEqual(stillUnclassified(seen, effective).map((r) => r.tool), ['new_tool'])

  // A snapshot hozza a katalógust; tenant-besorolásra új policyVersion és catalogVersion.
  let tenantRow: PolicyRow = { scope: 'tenant', scopeId: T, preset: 'standard', capabilities: {}, toolOverrides: {}, version: 1 }
  const snapshot = () => getPolicySnapshot({ findRows: async () => [tenantRow] }, { tenantId: T, userId: U, agentId: null })
  const before = await snapshot()
  assert.equal(before.toolCatalog.length, DEFAULT_TOOL_CATALOG.length)
  assert.ok(!('toolsets' in before.toolCatalog[0]))
  tenantRow = { ...tenantRow, capabilities: { toolCatalog: { ha_call_service: 'capability:local_files:read' } }, version: 2 }
  const after = await snapshot()
  assert.deepEqual(after.toolCatalog[0], { pattern: 'ha_call_service', class: 'capability:local_files:read' })
  assert.notEqual(after.catalogVersion, before.catalogVersion)
  assert.notEqual(after.policyVersion, before.policyVersion)
  assert.equal(after.capabilities.local_files, 'read_only') // a toolCatalog nem képesség-kulcs

  // Admin: egykattintásos besorolás, a mentés megőrzi; eszközönkénti kivétel; user-engedély megerősítést kér.
  let rows: PolicyRow[] = [{ scope: 'tenant', scopeId: T, preset: 'bound', capabilities: { models: ['m'] }, toolOverrides: {}, version: 1 }]
  const events: AuditAppendInput[] = []
  const store: AdminPolicyStore = {
    transaction: async (_tenantId, run) => run({
      targetExists: async () => true,
      find: async (t) => rows.find((r) => r.scope === t.scope && r.scopeId === t.scopeId) ?? null,
      save: async (row, expected) => {
        const i = rows.findIndex((r) => r.scope === row.scope && r.scopeId === row.scopeId)
        if ((rows[i]?.version ?? 0) !== expected) return false
        rows = i >= 0 ? rows.map((r, j) => (j === i ? row : r)) : [...rows, row]
        return true
      },
      audit: async (event) => {
        assertAuditActionRegistered(event.action)
        assertAuditMetadataSafe(event.metadata)
        events.push(event)
      },
    }),
  }
  const admin = { tenantId: T, userId: U, role: 'admin' }
  await assert.rejects(classifyTenantTool(store, { ...admin, role: 'operator' }, { tool: 'x', class: 'denied' }), AdminPolicyError)
  await classifyTenantTool(store, admin, { tool: 'ha_call_service', class: 'denied' })
  assert.deepEqual(rows[0].capabilities, { models: ['m'], toolCatalog: { ha_call_service: 'denied' } })
  assert.equal(rows[0].version, 2)
  assert.equal(events.at(-1)?.action, 'client_policy.tool_classified')

  await saveAdminPolicy(store, admin, { scope: 'tenant', scopeId: T, preset: 'standard', capabilities: {}, toolOverrides: { 'mcp__crm__*': 'deny', terminal: 'approve' }, version: 2, confirmWidening: false })
  assert.deepEqual(rows[0].capabilities, { models: ['m'], toolCatalog: { ha_call_service: 'denied' } })
  assert.deepEqual(rows[0].toolOverrides, { 'mcp__crm__*': 'deny', terminal: 'approve' })

  const userSave = { scope: 'user' as const, scopeId: U, preset: null, capabilities: {}, toolOverrides: { terminal: 'allow' as const }, version: 0, confirmWidening: false }
  await assert.rejects(saveAdminPolicy(store, admin, userSave), (e: unknown) =>
    e instanceof AdminPolicyError && e.code === 'confirmation_required' && e.capabilities.includes('tool:terminal'))
  await saveAdminPolicy(store, admin, { ...userSave, confirmWidening: true })
  assert.equal(events.at(-1)?.action, 'client_policy.user_exception')

  for (const key of ['*', 'a*b', 'mcp__*__send', 'sp ace']) {
    assert.equal(adminPolicySaveSchema.safeParse({ ...userSave, toolOverrides: { [key]: 'allow' } }).success, false, key)
  }
  console.log('client-policy-tool-catalog: Hermes-lefedettség, Guard-tartalék szinkron, snapshot, besorolás, kivétel OK')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
