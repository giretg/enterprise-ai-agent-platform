import assert from 'node:assert/strict'
import { PRESETS } from '../src/domain/client-policy/capabilities'
import { decideToolRule, resolveEffectivePolicy, type PolicyRow } from '../src/domain/client-policy/resolve-effective-policy'
import { getPolicySnapshot, type ClientPolicyStore } from '../src/domain/client-policy/policy-service'

const T = '11111111-1111-4111-8111-111111111111'
const U = '22222222-2222-4222-8222-222222222222'
const A = '33333333-3333-4333-8333-333333333333'
const row = (scope: PolicyRow['scope'], p: Partial<PolicyRow> = {}): PolicyRow => ({
  scope,
  scopeId: scope === 'tenant' ? T : scope === 'user' ? U : A,
  preset: null,
  capabilities: {},
  toolOverrides: {},
  version: 1,
  ...p,
})
const resolve = (tenant: PolicyRow | null, user: PolicyRow | null = null, agent: PolicyRow | null = null) =>
  resolveEffectivePolicy({ tenant, user, agent })

// hiányzó tenant-sor → Kötött pálya (fail-safe)
const none = resolve(null)
assert.deepEqual(none.capabilities, PRESETS.bound)
assert.equal(none.reasons.code_execution.source, 'tenant_default')

// tenant preset + user preset
assert.equal(resolve(row('tenant', { preset: 'standard' })).capabilities.code_execution, 'sandbox_only')
assert.equal(resolve(row('tenant', { preset: 'bound' }), row('user', { preset: 'free' })).capabilities.code_execution, 'local_free')

// user-kivétel nyer a tenant-preset ellen (D3), és jelölt
const exception = resolve(row('tenant', { preset: 'bound' }), row('user', { capabilities: { code_execution: 'local_with_approval' } }))
assert.equal(exception.capabilities.code_execution, 'local_with_approval')
assert.equal(exception.reasons.code_execution.source, 'user_override')
assert.equal(exception.reasons.code_execution.widenedBeyondTenant, true)
assert.equal(exception.reasons.browser.widenedBeyondTenant, false)

// agent-plafon nem léphető túl (se user-kivétellel, se user-presettel)
const capped = resolve(
  row('tenant', { preset: 'bound' }),
  row('user', { preset: 'free', capabilities: { local_files: 'free' } }),
  row('agent', { capabilities: { code_execution: 'denied', local_files: 'read_only' } }),
)
assert.equal(capped.capabilities.code_execution, 'denied')
assert.equal(capped.capabilities.local_files, 'read_only')
assert.equal(capped.reasons.code_execution.source, 'agent_ceiling')
assert.equal(capped.capabilities.browser, 'free') // plafon nélküli képesség érintetlen
// agent-plafon sosem szűkül tágabb értékre (a szigorúbb user-érték marad)
assert.equal(
  resolve(row('tenant', { preset: 'bound' }), null, row('agent', { preset: 'free' })).capabilities.code_execution,
  'denied',
)

// audit-mélység: nem mehet metaadat alá; ismeretlen/„kikapcsolt" érték mélyebb auditra esik, sosem „nincs"
assert.equal(resolve(row('tenant', { capabilities: { audit_depth: 'metadata' } })).capabilities.audit_depth, 'metadata')
for (const bad of ['none', 'off', null, 0]) {
  const v = resolve(row('tenant', { capabilities: { audit_depth: bad } })).capabilities.audit_depth
  assert.ok(['metadata', 'prompt_and_response', 'plus_tool_results'].includes(v), `audit_depth=${v}`)
}
// az alapréteg nem paraméterezhető: ismeretlen kulcs nem kapcsolja ki
const floored = resolve(row('tenant', { capabilities: { model_gateway: 'off', guard: 'off' } }))
assert.equal(floored.floor.modelGatewayRequired, true)
assert.equal(floored.floor.auditMinimum, 'metadata')
assert.equal('model_gateway' in floored.capabilities, false)

// hibás szint → legszigorúbb (fail-closed)
assert.equal(resolve(row('tenant', { preset: 'free', capabilities: { code_execution: 'yolo' } })).capabilities.code_execution, 'denied')

// modell-lista: user felülír, agent metsz
const models = resolve(
  row('tenant', { capabilities: { models: ['a', 'b'] } }),
  row('user', { capabilities: { models: ['b', 'c'] } }),
  row('agent', { capabilities: { models: ['c', 'd'] } }),
)
assert.deepEqual(models.models, ['c'])
assert.equal(models.reasons.models.source, 'agent_ceiling')
assert.equal(resolve(row('tenant')).models, null)

// tool-szabályok: azonos mintán user felülír tenantot (D3); azonos szinten a tiltás nyer; agent-tiltás nem oldható fel
const tools = resolve(
  row('tenant', { toolOverrides: { 'mcp__crm__*': 'deny', 'mcp__gmail__send': 'approve' } }),
  row('user', { toolOverrides: { 'mcp__crm__*': 'allow', 'mcp__crm__delete': 'deny' } }),
  row('agent', { toolOverrides: { 'mcp__gmail__send': 'deny', 'mcp__crm__*': 'approve' } }),
)
assert.equal(decideToolRule(tools.toolRules, 'mcp__crm__read'), 'approve') // user allow, agent approve → szigorúbb
assert.equal(decideToolRule(tools.toolRules, 'mcp__crm__delete'), 'deny') // illeszkedő szabályok közt a tiltás nyer
assert.equal(decideToolRule(tools.toolRules, 'mcp__gmail__send'), 'deny')
assert.equal(decideToolRule(tools.toolRules, 'terminal'), null)
assert.equal(decideToolRule(resolve(row('tenant', { toolOverrides: { x: 'bogus' } })).toolRules, 'x'), 'deny')
// agent allow nem oldja a tenant deny-t, és a forrás a tenant marad
const agentLooser = resolve(
  row('tenant', { toolOverrides: { 'mcp__gmail__send': 'deny' } }),
  null,
  row('agent', { toolOverrides: { 'mcp__gmail__send': 'allow' } }),
)
assert.equal(decideToolRule(agentLooser.toolRules, 'mcp__gmail__send'), 'deny')
assert.equal(agentLooser.toolRules.find((r) => r.pattern === 'mcp__gmail__send')?.source, 'tenant')
assert.equal(
  resolve(row('tenant', { toolOverrides: { 'mcp__gmail__send': 'allow' } }), null, row('agent', { toolOverrides: { 'mcp__gmail__send': 'deny' } })).toolRules[0]?.source,
  'agent',
)

// policyVersion: bármely bemeneti sor változására változik, változatlan bemenetre nem
const base = [row('tenant', { preset: 'standard' }), row('user'), row('agent')] as const
const v0 = resolve(...base).policyVersion
assert.equal(resolve(...base).policyVersion, v0)
assert.equal(resolve(row('tenant', { preset: 'standard' }), row('user'), row('agent')).policyVersion, v0)
assert.notEqual(resolve(row('tenant', { preset: 'free' }), row('user'), row('agent')).policyVersion, v0)
assert.notEqual(resolve(base[0], row('user', { capabilities: { browser: 'free' } }), base[2]).policyVersion, v0)
assert.notEqual(resolve(base[0], base[1], row('agent', { toolOverrides: { t: 'deny' } })).policyVersion, v0)
assert.notEqual(resolve(base[0], base[1], row('agent', { version: 2 })).policyVersion, v0)
assert.notEqual(resolve(base[0], base[1], null).policyVersion, v0)
assert.equal(resolve(row('tenant', { capabilities: { a: 1, b: 2 } })).policyVersion, resolve(row('tenant', { capabilities: { b: 2, a: 1 } })).policyVersion)

// service: sorok kiválasztása + séma-validált snapshot
const store: ClientPolicyStore = {
  findRows: async () => [row('tenant', { preset: 'standard' }), row('user', { preset: 'free' }), row('agent', { capabilities: { code_execution: 'sandbox_only' } }), { ...row('user'), scopeId: 'other-user' }],
}
getPolicySnapshot(store, { tenantId: T, userId: U, agentId: A }, () => new Date('2026-10-01T00:00:00Z')).then((snap) => {
  assert.equal(snap.capabilities.code_execution, 'sandbox_only')
  assert.equal(snap.capabilities.browser, 'free')
  assert.equal(snap.issuedAt, '2026-10-01T00:00:00.000Z')
  return getPolicySnapshot(store, { tenantId: T, userId: U, agentId: null }).then((noAgent) => {
    assert.equal(noAgent.capabilities.code_execution, 'local_free') // agent-sor nélkül nincs plafon
    console.log('client-policy-resolve.test.ts: OK')
  })
})
