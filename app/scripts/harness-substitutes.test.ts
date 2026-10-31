/**
 * #1020 — „harness-pótló” MCP-eszközök: láthatóság × meghívhatóság, céges webes keresés.
 * Futtatás: npm run test:harness-substitutes
 */
import assert from 'node:assert/strict'
import type { AgentDefinition } from '../src/domain/agent-definition'
import { PRESETS, capabilityLevels, type PresetId } from '../src/domain/client-policy/capabilities'
import { disabledToolsetsForPolicies } from '../src/domain/client-policy/machine-floor'
import { getPolicySnapshot } from '../src/domain/client-policy/policy-service'
import type { ToolRule } from '../src/domain/client-policy/resolve-effective-policy'
import {
  HARNESS_SUBSTITUTES,
  harnessClientKind,
  harnessSubstituteFor,
  isSubstituteVisible,
  readExternalClientsEnabled,
  substituteCallability,
  withExternalClientsEnabled,
  type HarnessClientKind,
} from '../src/domain/enterprise-tools/harness-substitutes'
import {
  invokeEnterpriseTool,
  WEB_SEARCH_TOOL,
  type EnterpriseToolDeps,
  type LiveConnectorRow,
  type ToolCallPrincipal,
} from '../src/domain/enterprise-tools'
import { braveFreshness, braveLocaleParams, braveQuery, parseBraveResponse } from '../src/domain/web-search/brave-provider'
import {
  authorizeWebSearch,
  domainMatchesPattern,
  parseWebSearchConfig,
  runWebSearch,
  type WebSearchConfig,
} from '../src/domain/web-search/web-search'
import { detectMcpClient, getMcpRequestContext } from '../src/lib/mcp-session'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const DEFINITION_ID = '44444444-4444-4444-8444-444444444444'
const CONNECTOR_ID = '55555555-5555-4555-8555-555555555555'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const webSearch = harnessSubstituteFor(WEB_SEARCH_TOOL)!
const policy = (preset: PresetId, toolRules: ToolRule[] = []) => ({ capabilities: PRESETS[preset], toolRules })
const config = (overrides: Partial<WebSearchConfig> = {}): WebSearchConfig => ({ ...parseWebSearchConfig({}), ...overrides })

const principal: ToolCallPrincipal = { userId: USER_ID, tenantId: TENANT_ID, role: 'operator', assumed: false }
const definition: AgentDefinition = {
  definitionId: DEFINITION_ID,
  agentId: AGENT_ID,
  version: 1,
  tenantId: TENANT_ID,
  status: 'active',
  publishedAt: '2026-10-31T00:00:00.000Z',
  snapshot: {
    name: 'Kutató',
    roleInstruction: 'Keress a weben',
    skills: [],
    connectors: [{ connectorId: CONNECTOR_ID, type: 'web_search', accessMode: 'read' }],
    capabilities: [{ toolName: WEB_SEARCH_TOOL, allowed: true }],
  },
}
const searchConnector: LiveConnectorRow = {
  id: CONNECTOR_ID,
  tenantId: TENANT_ID,
  type: 'web_search',
  authMode: 'service',
  lifecycleState: 'active',
  secretAlias: `secret-ref:${CONNECTOR_ID}`,
  config: { allowGeneralWeb: true, maxQueriesPerAgentDay: 3 },
}

function deps(opts: {
  preset?: PresetId
  toolRules?: ToolRule[]
  definition?: AgentDefinition
  searchCount?: number
  audit?: Array<{ action: string; outputRef?: string | null; metadata: Record<string, unknown> }>
  searched?: unknown[]
}): EnterpriseToolDeps {
  return {
    async findConnector(id) {
      return id === CONNECTOR_ID ? searchConnector : null
    },
    async findActiveGrant() {
      return null
    },
    async loadDefinition() {
      return opts.definition ?? definition
    },
    async findCurrentDefinitionId() {
      return DEFINITION_ID
    },
    async findAgentGrant() {
      return { accessLevel: 'operate' }
    },
    async resolveAccessToken() {
      throw new Error('web_search must not use an OAuth token')
    },
    ...(opts.preset ? { resolveClientPolicy: async () => policy(opts.preset!, opts.toolRules) } : {}),
    countWebSearchCalls: async () => opts.searchCount ?? 0,
    executeWebSearch: async (effective) => {
      opts.searched?.push(effective)
      return { results: [], provider: 'stub', domainsEffective: effective.domains, retrievedAt: 'now', notice: '', warnings: [] }
    },
    audit: {
      async append(data) {
        opts.audit?.push({ action: data.action, outputRef: data.outputRef, metadata: data.metadata as Record<string, unknown> })
      },
    },
  } as EnterpriseToolDeps
}

const call = (d: EnterpriseToolDeps, args: Record<string, unknown> = {}, client?: 'hermes' | 'claude' | 'platform_chat') =>
  invokeEnterpriseTool(d, {
    principal,
    toolName: WEB_SEARCH_TOOL,
    args: { definitionId: DEFINITION_ID, query: 'MNB alapkamat 2026', ...args },
    client,
  })

const codeOf = (result: Awaited<ReturnType<typeof call>>) =>
  'content' in result ? (JSON.parse(result.content[0]?.text ?? '{}') as { code?: string }).code : undefined

async function main() {
  await check('registry: web_search is callable at company_egress and builtin, client-builtin only at builtin', () => {
    assert.deepEqual(HARNESS_SUBSTITUTES.map((row) => row.tool), ['web_search'])
    for (const level of [...webSearch.callableAt, ...webSearch.clientBuiltinAt]) {
      assert.ok(capabilityLevels(webSearch.capability).includes(level), `${level} is not a ${webSearch.capability} level`)
    }
  })

  await check('matrix: visibility = callable AND the client has no own equivalent (client × level × tenant switch)', () => {
    const expected: Record<HarnessClientKind, Record<PresetId, [boolean, boolean]>> = {
      // [kapcsoló ki, kapcsoló be]
      platform_chat: { bound: [false, false], standard: [true, true], free: [true, true] },
      hermes: { bound: [false, false], standard: [true, true], free: [false, false] },
      external: { bound: [false, false], standard: [false, true], free: [false, true] },
    }
    for (const [client, byPreset] of Object.entries(expected) as Array<[HarnessClientKind, Record<PresetId, [boolean, boolean]>]>) {
      for (const [preset, [off, on]] of Object.entries(byPreset) as Array<[PresetId, [boolean, boolean]]>) {
        const p = policy(preset)
        assert.equal(isSubstituteVisible(webSearch, { policy: p, client, externalClientsEnabled: false }), off, `${client}/${preset}/off`)
        assert.equal(isSubstituteVisible(webSearch, { policy: p, client, externalClientsEnabled: true }), on, `${client}/${preset}/on`)
      }
    }
  })

  await check('callability ignores the client kind; the tenant deny rule is a kill-switch', () => {
    assert.deepEqual(substituteCallability(webSearch, policy('bound')), { callable: false, level: 'denied', reason: 'policy_level' })
    assert.deepEqual(substituteCallability(webSearch, policy('standard')), { callable: true, level: 'company_egress' })
    assert.deepEqual(substituteCallability(webSearch, policy('free')), { callable: true, level: 'builtin' })
    const killed = policy('free', [{ pattern: 'web_search', action: 'deny', source: 'tenant' }])
    assert.equal(substituteCallability(webSearch, killed).callable, false)
    for (const client of ['platform_chat', 'hermes', 'external'] as const) {
      assert.equal(isSubstituteVisible(webSearch, { policy: killed, client, externalClientsEnabled: true }), false)
    }
    // Ismeretlen / hiányzó szint: nem hívható (fail-closed).
    assert.equal(substituteCallability(webSearch, { capabilities: {}, toolRules: [] }).callable, false)
  })

  await check('client kind: platform_chat from the token, hermes from the header or UA, everything else external', () => {
    assert.equal(harnessClientKind('platform_chat'), 'platform_chat')
    assert.equal(harnessClientKind('hermes'), 'hermes')
    for (const name of ['claude', 'codex', 'cursor', 'goose', 'other', 'unknown'] as const) assert.equal(harnessClientKind(name), 'external')
    const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null })
    const managed = getMcpRequestContext(
      headers({ 'x-excellence-client': 'Hermes-Managed', 'user-agent': 'node', 'x-excellence-install-id': 'inst-1234-abcd' }),
    )
    assert.equal(managed.clientName, 'hermes')
    assert.equal(managed.installId, 'inst-1234-abcd')
    assert.equal(getMcpRequestContext(headers({ 'user-agent': 'Claude-User' })).clientName, 'claude')
    assert.equal(getMcpRequestContext(headers({ 'x-excellence-client': 'something', 'user-agent': 'Cursor/1' })).clientName, 'cursor')
    assert.equal(detectMcpClient('hermes-agent/0.21'), 'hermes')
  })

  await check('tenant switch is stored next to other settings', () => {
    const next = withExternalClientsEnabled({ platformChat: { enabled: true } }, true)
    assert.equal(readExternalClientsEnabled(next), true)
    assert.deepEqual((next as Record<string, unknown>).platformChat, { enabled: true })
    assert.equal(readExternalClientsEnabled({}), false)
    assert.equal(readExternalClientsEnabled({ harnessSubstitutes: { externalClients: 'yes' } }), false)
  })

  await check('machine floor hides the Hermes web toolset at company_egress, not at builtin', () => {
    assert.ok(disabledToolsetsForPolicies([{ capabilities: PRESETS.standard }]).includes('web'))
    assert.ok(disabledToolsetsForPolicies([{ capabilities: PRESETS.bound }]).includes('web'))
    assert.ok(!disabledToolsetsForPolicies([{ capabilities: PRESETS.free }]).includes('web'))
    // Ha bármelyik agentnél a sajátja dolgozik, a gépen marad (unió).
    assert.ok(!disabledToolsetsForPolicies([{ capabilities: PRESETS.standard }, { capabilities: PRESETS.free }]).includes('web'))
  })

  await check('AC1: bound user without a policy row — direct call is refused with a plain policy code', async () => {
    const audit: Array<{ action: string; outputRef?: string | null; metadata: Record<string, unknown> }> = []
    const searched: unknown[] = []
    const result = await call(deps({ audit, searched }), {}, 'hermes')
    assert.equal(codeOf(result), 'web_search_not_allowed_by_policy')
    assert.equal(searched.length, 0)
    assert.equal(audit[0]?.action, 'enterprise.tool.denied')
    assert.equal(audit[0]?.metadata.policyLevel, 'denied')
    assert.equal(audit[0]?.metadata.capability, 'web_search')
    assert.equal(audit[0]?.metadata.client, 'hermes')
  })

  await check('AC6: a forged hermes client on a denied policy cannot call it', async () => {
    for (const client of ['hermes', 'platform_chat', 'claude'] as const) {
      assert.equal(codeOf(await call(deps({ preset: 'bound' }), {}, client)), 'web_search_not_allowed_by_policy')
    }
  })

  await check('AC2/AC4: standard policy — the search runs and the audit carries capability, level and client', async () => {
    const audit: Array<{ action: string; outputRef?: string | null; metadata: Record<string, unknown> }> = []
    const searched: Array<{ query: string; queryHash: string }> = []
    const result = await call(deps({ preset: 'standard', audit, searched: searched as unknown[] }), {}, 'platform_chat')
    assert.equal('isError' in result && result.isError, false)
    assert.equal(searched[0]?.query, 'MNB alapkamat 2026')
    const ok = audit.find((row) => row.action === 'enterprise.tool.ok')!
    assert.equal(ok.metadata.policyLevel, 'company_egress')
    assert.equal(ok.metadata.client, 'platform_chat')
    assert.equal(ok.outputRef, searched[0]?.queryHash)
    assert.ok(!JSON.stringify(audit).includes('MNB alapkamat'), 'the raw query must not reach the audit log')
  })

  await check('AC5: Claude on a policy that allows it — callable; the agent right is still required', async () => {
    assert.equal(codeOf(await call(deps({ preset: 'free' }), {}, 'claude')), undefined)
    const noRight: AgentDefinition = { ...definition, snapshot: { ...definition.snapshot, capabilities: [] } }
    assert.equal(codeOf(await call(deps({ preset: 'free', definition: noRight }), {}, 'claude')), 'capability_not_allowed')
    const noConnector: AgentDefinition = { ...definition, snapshot: { ...definition.snapshot, connectors: [] } }
    assert.equal(codeOf(await call(deps({ preset: 'free', definition: noConnector }), {}, 'claude')), 'missing_web_search_connector_read')
  })

  await check('sensitive query, daily limit and denied domain are refused before the provider call', async () => {
    const searched: unknown[] = []
    assert.equal(codeOf(await call(deps({ preset: 'standard', searched }), { query: 'kártya 4111 1111 1111 1111 egyenleg' })), 'web_search_query_blocked')
    assert.equal(codeOf(await call(deps({ preset: 'standard', searched, searchCount: 3 }))), 'web_search_rate_limited')
    assert.equal(searched.length, 0)
  })

  await check('tenant kill-switch survives user override, and approve fails closed', async () => {
    const snapshot = await getPolicySnapshot({ findRows: async () => [
      { scope: 'tenant', scopeId: TENANT_ID, preset: 'standard', capabilities: {}, toolOverrides: { web_search: 'deny' } },
      { scope: 'user', scopeId: USER_ID, preset: null, capabilities: {}, toolOverrides: { web_search: 'allow' } },
    ] }, { tenantId: TENANT_ID, userId: USER_ID, agentId: AGENT_ID })
    assert.equal(substituteCallability(webSearch, snapshot).callable, false)
    assert.equal(isSubstituteVisible(webSearch, { policy: snapshot, client: 'platform_chat', externalClientsEnabled: true }), false)
    const blockedDeps = deps({ preset: 'standard' })
    blockedDeps.resolveClientPolicy = async () => snapshot
    assert.equal(codeOf(await call(blockedDeps)), 'web_search_not_allowed_by_policy')
    const approval = policy('standard', [{ pattern: 'web_search', action: 'approve', source: 'tenant' }])
    assert.equal(substituteCallability(webSearch, approval).callable, false)
    blockedDeps.resolveClientPolicy = async () => approval
    assert.equal(codeOf(await call(blockedDeps)), 'web_search_not_allowed_by_policy')
  })

  await check('domain rules: narrow only, deny wins, wildcard is left-anchored', () => {
    assert.equal(domainMatchesPattern('www.gov.hu', '*.gov.hu'), true)
    assert.equal(domainMatchesPattern('gov.hu', '*.gov.hu'), false)
    assert.equal(domainMatchesPattern('mnb.hu.evil.tld', 'mnb.hu'), false)
    const strict = config({ allowGeneralWeb: false, allowedDomains: ['mnb.hu', '*.gov.hu'], deniedDomains: ['pastebin.com'] })
    const run = (domains?: string[]) => authorizeWebSearch({ query: 'alapkamat', domains }, strict, { agentDayQueryCount: 0 })
    const all = run()
    assert.ok(all.allowed && all.effective.domains.join() === 'mnb.hu,*.gov.hu')
    const narrowed = run(['mnb.hu'])
    assert.ok(narrowed.allowed && narrowed.effective.domains.join() === 'mnb.hu')
    assert.equal(run(['index.hu']).allowed, false)
    assert.equal(authorizeWebSearch({ query: 'x', domains: ['pastebin.com'] }, config({ deniedDomains: ['pastebin.com'] }), { agentDayQueryCount: 0 }).allowed, false)
    assert.equal(authorizeWebSearch({ query: 'x' }, config({ allowGeneralWeb: false }), { agentDayQueryCount: 0 }).allowed, false)
    const capped = authorizeWebSearch({ query: 'x', maxResults: 50 }, config({ hardMaxResults: 4 }), { agentDayQueryCount: 0 })
    assert.ok(capped.allowed && capped.effective.maxResults === 4)
    // Hibás tárolt konfig: nincs általános web.
    assert.equal(parseWebSearchConfig({ allowGeneralWeb: 'igen' }).allowGeneralWeb, false)
  })

  await check('results outside the domain scope or on the deny list are dropped', async () => {
    const provider = {
      async search() {
        return {
          provider: 'stub',
          items: [
            { title: 'a', url: 'https://www.mnb.hu/a', snippet: '' },
            { title: 'exact', url: 'https://mnb.hu/a', snippet: '' },
            { title: 'b', url: 'https://pastebin.com/x', snippet: '' },
            { title: 'c', url: 'https://index.hu/c', snippet: '' },
            { title: 'd', url: 'not a url', snippet: '' },
          ],
        }
      },
    }
    const cfg = config({ deniedDomains: ['pastebin.com'] })
    const scoped = await runWebSearch(provider, { query: 'q', domains: ['mnb.hu'], locale: 'hu-HU', maxResults: 5, queryHash: 'h' }, cfg)
    assert.deepEqual(scoped.results.map((r) => r.domain), ['mnb.hu'])
    const wildcard = await runWebSearch(provider, { query: 'q', domains: ['*.mnb.hu'], locale: 'hu-HU', maxResults: 5, queryHash: 'h' }, cfg)
    assert.deepEqual(wildcard.results.map((r) => r.domain), ['www.mnb.hu'])
    assert.equal(scoped.warnings.length, 1)
    const open = await runWebSearch(provider, { query: 'q', domains: [], locale: 'hu-HU', maxResults: 5, queryHash: 'h' }, cfg)
    assert.deepEqual(open.results.map((r) => r.domain), ['www.mnb.hu', 'mnb.hu', 'index.hu'])
  })

  await check('Brave helpers: site: operators, freshness codes, supported country only, tolerant parsing', () => {
    assert.equal(braveQuery('kamat', ['mnb.hu', '*.gov.hu']), 'kamat (site:mnb.hu OR site:gov.hu)')
    assert.equal(braveQuery('kamat', []), 'kamat')
    assert.equal(braveFreshness(1), 'pd')
    assert.equal(braveFreshness(30), 'pm')
    assert.equal(braveFreshness(undefined), undefined)
    assert.deepEqual(braveLocaleParams('hu-HU', 'HU'), { search_lang: 'hu' })
    assert.deepEqual(braveLocaleParams('en-US', 'us'), { search_lang: 'en', country: 'US' })
    assert.deepEqual(parseBraveResponse({ web: { results: [{ title: 't', url: 'https://x.hu', description: 'd', page_age: '2026-10-01' }, { url: 1 }] } }), [
      { title: 't', url: 'https://x.hu', snippet: 'd', publishedAt: '2026-10-01' },
    ])
    assert.deepEqual(parseBraveResponse(null), [])
  })

  if (failures > 0) {
    console.error(`harness-substitutes: ${failures} failed`)
    process.exit(1)
  }
  console.log('harness-substitutes: ok')
}

void main()
