/**
 * Gép-padló generátor (#771) — DB-mentes tesztek.
 * Futtatás: npm run test:machine-floor
 */
import assert from 'node:assert/strict'
import { PRESETS } from '../src/domain/client-policy/capabilities'
import {
  AUXILIARY_TASKS,
  PINNED_EMPTY_ENV_KEYS,
  buildManagedFiles,
  disabledToolsetsForPolicies,
  issueMachineFloor,
  modelGatewayBaseUrl,
  type MachineFloorStore,
} from '../src/domain/client-policy/machine-floor'
import type { ClientPolicyStore } from '../src/domain/client-policy/policy-service'
import { resolveEffectivePolicy, type PolicyRow } from '../src/domain/client-policy/resolve-effective-policy'

const T = '11111111-1111-4111-8111-111111111111'
const U = '22222222-2222-4222-8222-222222222222'
const GATEWAY = 'https://excellence.example/api/model-gateway/v1'
let failures = 0

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${(e as Error).message}`)
  }
}

const row = (scope: PolicyRow['scope'], scopeId: string, preset: string | null): PolicyRow => ({
  scope,
  scopeId,
  preset,
  capabilities: {},
  toolOverrides: {},
  version: 1,
})

function policy(preset: 'free' | 'bound' | 'standard' | null, agentPreset: 'free' | 'bound' | 'standard' | null = null) {
  return resolveEffectivePolicy({
    tenant: row('tenant', T, 'bound'),
    user: preset ? row('user', U, preset) : null,
    agent: agentPreset ? row('agent', 'agent', agentPreset) : null,
  })
}

function memoryFloors(): MachineFloorStore & { saved: { installId: string; managedDirHash: string } | null } {
  const state: { saved: { installId: string; managedDirHash: string } | null } = { saved: null }
  return {
    get saved() {
      return state.saved
    },
    set saved(v) {
      state.saved = v
    },
    async find() {
      return state.saved ? { installId: state.saved.installId } : null
    },
    async save(input) {
      state.saved = { installId: input.installId, managedDirHash: input.managedDirHash }
    },
    async expectedHash(input) {
      return state.saved && state.saved.installId === input.installId ? state.saved.managedDirHash : null
    },
  }
}

function storeFor(agents: Record<string, 'free' | 'bound' | 'standard'>): ClientPolicyStore {
  return {
    async findRows(input) {
      const agentPreset = input.agentId ? agents[input.agentId] : undefined
      return [
        row('tenant', input.tenantId, 'bound'),
        row('user', input.userId, 'free'),
        ...(agentPreset && input.agentId ? [row('agent', input.agentId, agentPreset)] : []),
      ]
    },
  }
}

async function main() {
  console.log('Gép-padló (#771)')

  await check('a model pin levelenként külön kulcs, minden aux task main, a kulcsok üresek', () => {
    const { files } = buildManagedFiles({ gatewayBaseUrl: GATEWAY, disabledToolsets: [], installId: 'inst-1' })
    const yaml = files['config.yaml']
    assert.match(yaml, /model:\n {2}provider: "excellence"\n {2}base_url: "https:\/\/excellence\.example\/api\/model-gateway\/v1"\n {2}api_mode: "chat_completions"/)
    for (const task of AUXILIARY_TASKS) {
      assert.match(yaml, new RegExp(`${task}:\\n {4}provider: "main"\\n {4}model: ""\\n {4}base_url: ""\\n {4}api_key: ""\\n {4}fallback_chain: \\[\\]`))
    }
    assert.match(yaml, /^fallback_providers: \[\]$/m)
    assert.match(yaml, /plugins:\n {2}enabled:\n {4}- "excellence-guard"\n {2}disabled: \[\]/)
    assert.match(yaml, /command: "\/opt\/excellence\/bin\/exc-guard"\n {6}timeout: 30\n {6}fail_closed: true/)
    assert.match(yaml, /^hooks_auto_accept: true$/m)
    assert.match(yaml, /redact_secrets: true/)
    assert.match(yaml, /session_affinity_header: "X-Excellence-Session"/)
    for (const key of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
      assert.equal(PINNED_EMPTY_ENV_KEYS.includes(key as (typeof PINNED_EMPTY_ENV_KEYS)[number]), true)
      assert.match(files['.env'], new RegExp(`^${key}=$`, 'm'))
    }
    assert.equal(files['excellence-install-id'], 'inst-1\n')
  })

  await check('ugyanaz a bemenet ugyanaz a hash; a toolset-lista változtatja', () => {
    const a = buildManagedFiles({ gatewayBaseUrl: GATEWAY, disabledToolsets: ['terminal'], installId: 'inst-1' })
    const b = buildManagedFiles({ gatewayBaseUrl: GATEWAY, disabledToolsets: ['terminal'], installId: 'inst-1' })
    assert.equal(a.managedDirHash, b.managedDirHash)
    assert.equal(a.files['config.yaml'], b.files['config.yaml'])
    const c = buildManagedFiles({ gatewayBaseUrl: GATEWAY, disabledToolsets: [], installId: 'inst-1' })
    assert.notEqual(a.managedDirHash, c.managedDirHash)
  })

  await check('Szabad usernél nincs terminál-tiltás', () => {
    const disabled = disabledToolsetsForPolicies([policy('free')])
    assert.equal(disabled.includes('terminal'), false)
    assert.equal(disabled.includes('code_execution'), false)
    assert.deepEqual(policy('free').capabilities, PRESETS.free)
  })

  await check('csak Kötött pálya agenteknél van terminál-tiltás; a Szabad agent feloldja', () => {
    const boundOnly = disabledToolsetsForPolicies([policy('free', 'bound'), policy('bound', 'bound')])
    assert.equal(boundOnly.includes('terminal'), true)
    assert.equal(boundOnly.includes('code_execution'), true)
    assert.equal(boundOnly.includes('file'), true)
    assert.equal(boundOnly.includes('browser'), true)
    assert.equal(boundOnly.includes('computer_use'), true)
    assert.equal(boundOnly.includes('web'), true)
    assert.equal(boundOnly.includes('delegation'), true)
    assert.equal(boundOnly.includes('cronjob'), true)
    // A Kötött pálya memóriája Excellence, nem tiltás: a memory toolset marad.
    assert.equal(boundOnly.includes('memory'), false)

    const mixed = disabledToolsetsForPolicies([policy('free'), policy('free', 'bound')])
    assert.equal(mixed.includes('terminal'), false)
    assert.equal(mixed.includes('file'), false)
  })

  await check('sandboxos (Standard) agentnél a terminál a padlón marad', () => {
    const disabled = disabledToolsetsForPolicies([policy('standard')])
    assert.equal(disabled.includes('terminal'), false)
    assert.equal(policy('standard').capabilities.code_execution, 'sandbox_only')
  })

  await check('nincs látható agent → minden kapuzott toolset tiltva', () => {
    const disabled = disabledToolsetsForPolicies([])
    assert.equal(disabled.includes('terminal'), true)
    assert.equal(disabled.includes('memory'), true)
  })

  await check('kiadás: a látható agentek uniója, az installId stabil, a hash mentődik', async () => {
    const floors = memoryFloors()
    const deps = {
      policyStore: storeFor({ 'agent-free': 'free', 'agent-bound': 'bound' }),
      listVisibleAgentIds: async () => ['agent-bound', 'agent-free'],
      floors,
      newInstallId: () => 'inst-stable',
    }
    const first = await issueMachineFloor(deps, { tenantId: T, userId: U, gatewayBaseUrl: GATEWAY })
    assert.deepEqual(first.agentIds, ['agent-bound', 'agent-free'])
    assert.equal(first.disabledToolsets.includes('terminal'), false)
    assert.equal(first.installId, 'inst-stable')
    assert.equal(floors.saved?.managedDirHash, first.managedDirHash)
    const second = await issueMachineFloor(deps, { tenantId: T, userId: U, gatewayBaseUrl: GATEWAY })
    assert.equal(second.installId, 'inst-stable')
    assert.equal(second.managedDirHash, first.managedDirHash)
  })

  await check('csak Kötött pálya agent a kiadásban: terminál a yamlban', async () => {
    const pkg = await issueMachineFloor(
      {
        policyStore: storeFor({ 'agent-bound': 'bound' }),
        listVisibleAgentIds: async () => ['agent-bound'],
        floors: memoryFloors(),
        newInstallId: () => 'inst-bound',
      },
      { tenantId: T, userId: U, gatewayBaseUrl: GATEWAY },
    )
    assert.equal(pkg.disabledToolsets.includes('terminal'), true)
    assert.match(pkg.files['config.yaml'], /- "terminal"/)
  })

  await check('a gateway URL a publikus originból áll', () => {
    assert.equal(modelGatewayBaseUrl('https://excellence.example/'), GATEWAY)
    assert.throws(() => modelGatewayBaseUrl('not a url'), /bad_gateway_origin/)
  })

  console.log(failures === 0 ? '\nok' : `\n${failures} failed`)
  if (failures > 0) process.exit(1)
}

void main()
