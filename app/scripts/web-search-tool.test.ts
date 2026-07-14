/**
 * Web Search Tool — acceptance (WS1-WS15) + negatív (WN1-WN12) tesztek
 * (Feature-spec — WebSearchTool §9-§10).
 *
 * A meglévő Tool Broker tesztmintát követi (lásd role-template-enforcement.test.ts,
 * per-user-connector.test.ts): a determinisztikus döntési rétegeket (policy,
 * authorizer, service) izoláltan teszteli, DB nélkül.
 */
import assert from 'node:assert/strict'
import type { Agent, Connector } from '@prisma/client'
import {
  AllowlistAuthorizer,
  type ActingUserLookup,
  type RoleTemplateLookup,
} from '../src/domain/tool-broker/tool-broker-service'
import { WebSearchPolicyService, domainMatchesPattern } from '../src/domain/web-search/web-search-policy-service'
import { WebSearchService, classifySourceType } from '../src/domain/web-search/web-search-service'
import {
  HttpSearchProviderAdapter,
  StubSearchProviderAdapter,
  braveLocaleParams,
  mapRecencyDaysToBraveFreshness,
  parseBraveSearchResponse,
} from '../src/domain/web-search/search-provider-adapter'
import { DEFAULT_WEB_SEARCH_CONFIG, parseWebSearchConfig, type WebSearchConnectorConfig } from '../src/domain/web-search/web-search-types'
import type {
  AgentRepository,
  ConnectorGrantRepository,
  ToolBrokerRepository,
} from '../src/repositories/interfaces'

let failures = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`)
  }
}

function bankingStrictConfig(overrides: Partial<WebSearchConnectorConfig> = {}): WebSearchConnectorConfig {
  return {
    ...DEFAULT_WEB_SEARCH_CONFIG,
    allowedDomains: ['*.gov.hu', 'mnb.hu', 'docs.stripe.com'],
    deniedDomains: ['pastebin.com', '*.onion'],
    allowGeneralWeb: false,
    ...overrides,
  }
}

function buildAuthorizer(opts: {
  agentRole: Agent['role']
  capabilityAllowed: boolean
  connector: Connector | null
}) {
  const tools = {
    findCapability: async () => (opts.capabilityAllowed ? { allowed: true } : { allowed: false }),
    findConnectorForAgent: async () =>
      opts.connector ? { connector: opts.connector, agentSecretAlias: null } : null,
    findConnectorForAgentById: async () => null,
  } as unknown as ToolBrokerRepository

  const agents = {
    // A web_search connector tenant-szintű: az agentnek ugyanabban a tenantban kell lennie,
    // különben az authorizer `tenant_isolation`-nel utasít el, mielőtt a connectorhoz érne.
    findById: async () => ({ id: 'agent-1', role: opts.agentRole, tenantId: 'tenant-1' }) as Agent,
  } as unknown as AgentRepository

  const grants = { findActiveGrant: async () => null } as unknown as ConnectorGrantRepository

  const lookupActingUser: ActingUserLookup = async () => ({ status: 'active' })
  const lookupRoleTemplate: RoleTemplateLookup = async () => ({
    toolAccessAllowed: opts.agentRole !== 'orchestrator',
  })

  return new AllowlistAuthorizer(tools, agents, grants, lookupActingUser, lookupRoleTemplate)
}

function activeConnector(config: WebSearchConnectorConfig, tenantId = 'tenant-1'): Connector {
  return {
    id: 'connector-web-search',
    type: 'web_search',
    name: 'Web Search',
    authMode: 'agent_owned',
    scope: 'global',
    secretAlias: null,
    version: 1,
    config: config as unknown as Connector['config'],
    lifecycleState: 'active',
    tenantId,
    createdAt: new Date(),
  } as Connector
}

async function main() {
  console.log('=== Web Search Tool — domain matching ===')

  await test('left-anchored wildcard matches subdomain', () => {
    assert.equal(domainMatchesPattern('sub.example.com', '*.example.com'), true)
  })
  await test('left-anchored wildcard does NOT match bare apex', () => {
    assert.equal(domainMatchesPattern('example.com', '*.example.com'), false)
  })
  await test('example.com.evil.tld does not match example.com (no suffix attack)', () => {
    assert.equal(domainMatchesPattern('example.com.evil.tld', 'example.com'), false)
  })
  await test('exact match works', () => {
    assert.equal(domainMatchesPattern('mnb.hu', 'mnb.hu'), true)
  })

  console.log('\n=== WS2/WN2 — capability nélkül: TOOL_NOT_AUTHORIZED, provider hívás nélkül ===')
  await test('worker, capability_not_allowed → deny', async () => {
    const authorizer = buildAuthorizer({ agentRole: 'worker', capabilityAllowed: false, connector: null })
    const result = await authorizer.authorize({ agentId: 'agent-1', tool: 'web_search' })
    assert.equal(result.allowed, false)
    if (!result.allowed) assert.equal(result.reason, 'capability_not_allowed')
  })

  console.log('\n=== WS3/WN3 — orchestrator sosem hívhat web_search-öt ===')
  await test('orchestrator + tévesen kapott capability sor → mégis deny (role-gate elsőbbsége)', async () => {
    const authorizer = buildAuthorizer({ agentRole: 'orchestrator', capabilityAllowed: true, connector: null })
    const result = await authorizer.authorize({ agentId: 'agent-1', tool: 'web_search' })
    assert.equal(result.allowed, false)
    if (!result.allowed) assert.equal(result.reason, 'orchestrator_tool_less')
  })

  console.log('\n=== WN10 — inactive/draft connectorral keresés → CONNECTOR_NOT_ACTIVE ===')
  await test('draft connector → connector_not_active', async () => {
    const config = bankingStrictConfig()
    const draftConnector = { ...activeConnector(config), lifecycleState: 'draft' } as Connector
    const authorizer = buildAuthorizer({ agentRole: 'worker', capabilityAllowed: true, connector: draftConnector })
    const result = await authorizer.authorize({ agentId: 'agent-1', tool: 'web_search' })
    assert.equal(result.allowed, false)
    if (!result.allowed) assert.equal(result.reason, 'connector_not_active')
  })

  console.log('\n=== WS1 — pozitív flow: capability + aktív connector → authorize allowed ===')
  await test('worker, capability allowed, aktív connector → allowed', async () => {
    const config = bankingStrictConfig()
    const authorizer = buildAuthorizer({
      agentRole: 'worker',
      capabilityAllowed: true,
      connector: activeConnector(config),
    })
    const result = await authorizer.authorize({ agentId: 'agent-1', tool: 'web_search' })
    assert.equal(result.allowed, true)
  })

  console.log('\n=== WS5/WS6/WN6 — domain allowlist banki presetben ===')
  const policy = new WebSearchPolicyService()

  await test('WN6 — nem allowlistelt domain banki presetben → domain_not_allowed', () => {
    const decision = policy.authorize(
      { query: 'kártyaszabvány módosítás' },
      bankingStrictConfig(),
      { enabled: true, scopedQueryCount: 0, agentDayQueryCount: 0 },
    )
    // alapértelmezett (domains paraméter nélkül) a tenant allowlist megy ki — ez engedett.
    assert.equal(decision.allowed, true)
  })

  await test('WN6 — explicit kért domain nincs az allowlisten → domain_not_allowed', () => {
    const decision = policy.authorize(
      { query: 'kártyaszabvány módosítás', domains: ['evil.example'] },
      bankingStrictConfig(),
      { enabled: true, scopedQueryCount: 0, agentDayQueryCount: 0 },
    )
    assert.equal(decision.allowed, false)
    if (!decision.allowed) assert.equal(decision.reason, 'domain_not_allowed')
  })

  await test('WS5/WN7 — tiltólistás domain kérése → domain_denied', () => {
    const decision = policy.authorize(
      { query: 'visa scheme update', domains: ['pastebin.com'] },
      bankingStrictConfig(),
      { enabled: true, scopedQueryCount: 0, agentDayQueryCount: 0 },
    )
    assert.equal(decision.allowed, false)
    if (!decision.allowed) assert.equal(decision.reason, 'domain_denied')
  })

  await test('domains paraméter csak szűkíthet, allowlistet nem bővíthet', () => {
    const decision = policy.authorize(
      { query: 'mnb árfolyam', domains: ['mnb.hu', 'evil.example'] },
      bankingStrictConfig(),
      { enabled: true, scopedQueryCount: 0, agentDayQueryCount: 0 },
    )
    assert.equal(decision.allowed, true)
    if (decision.allowed) assert.deepEqual(decision.effective.domains, ['mnb.hu'])
  })

  console.log('\n=== WS7/WN4/WN5 — query-safety guard ===')
  await test('WN4 — query API-kulcs mintát tartalmaz → query_policy_blocked, provider nem hívódik', () => {
    const decision = policy.authorize(
      { query: 'mi a hiba ha api_key: sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      bankingStrictConfig(),
      { enabled: true, scopedQueryCount: 0, agentDayQueryCount: 0 },
    )
    assert.equal(decision.allowed, false)
    if (!decision.allowed) assert.equal(decision.reason, 'query_policy_blocked')
  })

  await test('WN5 — query PAN-szerű kártyaszámot tartalmaz → query_policy_blocked', () => {
    const decision = policy.authorize(
      { query: 'mit jelent ez a tranzakció: 4111111111111111' },
      bankingStrictConfig(),
      { enabled: true, scopedQueryCount: 0, agentDayQueryCount: 0 },
    )
    assert.equal(decision.allowed, false)
    if (!decision.allowed) assert.equal(decision.reason, 'query_policy_blocked')
  })

  await test('agent sensitivity felmentéssel a PAN-os query is átmegy', () => {
    const decision = policy.authorize(
      { query: 'mit jelent ez a tranzakció: 4111111111111111' },
      bankingStrictConfig(),
      {
        enabled: true,
        scopedQueryCount: 0,
        agentDayQueryCount: 0,
        bypassSensitivity: true,
      },
    )
    assert.equal(decision.allowed, true)
  })

  await test('tiszta, üzleti célú query átmegy a query-safety guardon', () => {
    const decision = policy.authorize(
      { query: 'mnb árfolyam közlemény 2026' },
      bankingStrictConfig(),
      { enabled: true, scopedQueryCount: 0, agentDayQueryCount: 0 },
    )
    assert.equal(decision.allowed, true)
  })

  console.log('\n=== WS8/WN9 — rate-limit ===')
  await test('WN9 — napi agent-limit felett → rate_limited, provider nem hívódik', () => {
    const decision = policy.authorize(
      { query: 'mnb árfolyam' },
      bankingStrictConfig({ maxQueriesPerAgentDay: 5 }),
      { enabled: true, scopedQueryCount: 0, agentDayQueryCount: 5 },
    )
    assert.equal(decision.allowed, false)
    if (!decision.allowed) assert.equal(decision.reason, 'rate_limited')
  })

  await test('ticket-limit felett → rate_limited', () => {
    const decision = policy.authorize(
      { query: 'mnb árfolyam' },
      bankingStrictConfig({ maxQueriesPerTicket: 2 }),
      { enabled: true, scopedQueryCount: 2, agentDayQueryCount: 0 },
    )
    assert.equal(decision.allowed, false)
    if (!decision.allowed) assert.equal(decision.reason, 'rate_limited')
  })

  await test('beszélgetés-scope limit (chat, ticket nélkül) → rate_limited', () => {
    const decision = policy.authorize(
      { query: 'telex vezető hír' },
      bankingStrictConfig({ maxQueriesPerTicket: 10 }),
      { enabled: true, scopedQueryCount: 10, agentDayQueryCount: 0 },
    )
    assert.equal(decision.allowed, false)
    if (!decision.allowed) assert.equal(decision.reason, 'rate_limited')
  })

  console.log('\n=== WS13 — kill-switch ===')
  await test('kill-switch aktív → web_search_disabled, provider nem hívódik', () => {
    const decision = policy.authorize(
      { query: 'mnb árfolyam' },
      bankingStrictConfig(),
      { enabled: false, scopedQueryCount: 0, agentDayQueryCount: 0 },
    )
    assert.equal(decision.allowed, false)
    if (!decision.allowed) assert.equal(decision.reason, 'web_search_disabled')
  })

  console.log('\n=== WS14/WN12 — maxResults policy-cap, nincs 400 ===')
  await test('maxResults=100 → effective a hardMaxResults-ra vágva', () => {
    const decision = policy.authorize(
      { query: 'mnb árfolyam', maxResults: 100 },
      bankingStrictConfig({ hardMaxResults: 10 }),
      { enabled: true, scopedQueryCount: 0, agentDayQueryCount: 0 },
    )
    assert.equal(decision.allowed, true)
    if (decision.allowed) {
      assert.equal(decision.effective.maxResultsRequested, 100)
      assert.equal(decision.effective.maxResultsEffective, 10)
    }
  })

  console.log('\n=== I-WS-10/WS10 — audit: sosem nyers query, csak hash ===')
  await test('effective.queryHash nem tartalmazza a nyers querystringet', () => {
    const rawQuery = 'nagyon-specifikus-belso-kereses-amit-nem-szabad-naplozni'
    const decision = policy.authorize(
      { query: rawQuery },
      bankingStrictConfig(),
      { enabled: true, scopedQueryCount: 0, agentDayQueryCount: 0 },
    )
    assert.equal(decision.allowed, true)
    if (decision.allowed) {
      assert.equal(decision.effective.queryHash.includes(rawQuery), false)
      assert.match(decision.effective.queryHash, /^[0-9a-f]{16}$/)
    }
  })

  console.log('\n=== WS1/WS9 — pozitív flow stub providerrel ===')
  const service = new WebSearchService(async () => new StubSearchProviderAdapter(), policy)

  await test('WS1 — capability-s agent normalizált találatokat kap stub providertől', async () => {
    const config = bankingStrictConfig()
    const decision = policy.authorize(
      { query: 'mnb árfolyam', domains: ['mnb.hu'] },
      config,
      { enabled: true, scopedQueryCount: 0, agentDayQueryCount: 0 },
    )
    assert.equal(decision.allowed, true)
    if (!decision.allowed) return
    const { result, resultDomains } = await service.search(decision.effective, config)
    assert.ok(result.results.length > 0)
    assert.equal(result.queryMeta.provider, 'stub')
    for (const item of result.results) {
      assert.equal(item.domain, 'mnb.hu')
    }
    assert.deepEqual(resultDomains, result.results.map((r) => r.domain))
  })

  console.log('\n=== WN7 — provider tiltott domain találatot ad → kiszűrve ===')
  await test('denied domain a találatok között → kiszűrve, warning', async () => {
    const config = bankingStrictConfig({ allowGeneralWeb: true, allowedDomains: [] })
    class DeniedDomainAdapter extends StubSearchProviderAdapter {
      async search() {
        return {
          provider: 'stub',
          items: [
            { title: 'ok', url: 'https://mnb.hu/ok', snippet: 'ok' },
            { title: 'bad', url: 'https://pastebin.com/bad', snippet: 'bad' },
          ],
        }
      }
    }
    const svc = new WebSearchService(async () => new DeniedDomainAdapter(), policy)
    const decision = policy.authorize(
      { query: 'public info' },
      config,
      { enabled: true, scopedQueryCount: 0, agentDayQueryCount: 0 },
    )
    assert.equal(decision.allowed, true)
    if (!decision.allowed) return
    const { result, deniedDomainsMatched } = await svc.search(decision.effective, config)
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].domain, 'mnb.hu')
    assert.deepEqual(deniedDomainsMatched, ['pastebin.com'])
    assert.ok(result.warnings.some((w) => w.code === 'RESULTS_FILTERED_DENIED_DOMAIN'))
  })

  console.log('\n=== Forrás-minősítés (§5.6) ===')
  await test('hivatalos domain → official_source label', async () => {
    const config = bankingStrictConfig({ allowGeneralWeb: true, allowedDomains: [] })
    class GovAdapter extends StubSearchProviderAdapter {
      async search() {
        return { provider: 'stub', items: [{ title: 'rendelet', url: 'https://valami.gov.hu/x', snippet: 's' }] }
      }
    }
    const svc = new WebSearchService(async () => new GovAdapter(), policy)
    const decision = policy.authorize({ query: 'jogszabály' }, config, {
      enabled: true,
      scopedQueryCount: 0,
      agentDayQueryCount: 0,
    })
    assert.equal(decision.allowed, true)
    if (!decision.allowed) return
    const { result } = await svc.search(decision.effective, config)
    assert.equal(result.results[0].sourceType, 'official')
    assert.ok(result.results[0].policyLabels.includes('official_source'))
  })

  await test('bare apex hivatalos domain (gov.hu, nem csak subdomain) → official', () => {
    assert.equal(classifySourceType('gov.hu'), 'official')
    assert.equal(classifySourceType('valami.gov.hu'), 'official')
    assert.equal(classifySourceType('notgov.hu'), 'unknown')
  })

  console.log('\n=== Brave adapter — freshness + válasz parse ===')
  await test('braveLocaleParams HU esetén nem küld country-t (Brave nem támogatja)', () => {
    assert.deepEqual(braveLocaleParams('hu-HU', 'HU'), { search_lang: 'hu' })
  })
  await test('braveLocaleParams DE esetén country=DE', () => {
    assert.deepEqual(braveLocaleParams('de-DE', 'DE'), { search_lang: 'de', country: 'DE' })
  })
  await test('mapRecencyDaysToBraveFreshness Brave kódokat ad, nem „Nd” formátumot', () => {
    assert.equal(mapRecencyDaysToBraveFreshness(1), 'pd')
    assert.equal(mapRecencyDaysToBraveFreshness(3), 'pw')
    assert.equal(mapRecencyDaysToBraveFreshness(14), 'pm')
    assert.equal(mapRecencyDaysToBraveFreshness(90), 'py')
    assert.equal(mapRecencyDaysToBraveFreshness(0), undefined)
  })
  await test('parseBraveSearchResponse a web.results mezőt olvassa', () => {
    const items = parseBraveSearchResponse({
      web: {
        results: [
          {
            title: 'Telex főcím',
            url: 'https://telex.hu/fohir',
            description: 'A nap vezető híre',
            page_age: '2026-07-02T05:00:00',
          },
        ],
      },
    })
    assert.equal(items.length, 1)
    assert.equal(items[0].title, 'Telex főcím')
    assert.equal(items[0].snippet, 'A nap vezető híre')
    assert.equal(items[0].publishedAt, '2026-07-02T05:00:00')
  })
  await test('parseBraveSearchResponse fallback top-level results mezőre', () => {
    const items = parseBraveSearchResponse({
      results: [{ title: 'x', url: 'https://example.com', description: 'y' }],
    })
    assert.equal(items.length, 1)
  })
  await test('HttpSearchProviderAdapter Brave: freshness=pd és Cache-Control header', async () => {
    const originalFetch = globalThis.fetch
    let capturedUrl = ''
    let capturedHeaders: HeadersInit | undefined
    globalThis.fetch = async (input, init) => {
      capturedUrl = String(input)
      capturedHeaders = init?.headers
      return new Response(
        JSON.stringify({
          web: {
            results: [{ title: 'hír', url: 'https://telex.hu/a', description: 'snippet' }],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    try {
      const adapter = new HttpSearchProviderAdapter({
        apiUrl: 'https://api.search.brave.com/res/v1/web/search',
        apiKey: 'test-key',
      })
      const res = await adapter.search({
        query: 'telex.hu vezető hír ma',
        domains: [],
        recencyDays: 1,
        locale: 'hu-HU',
        region: 'HU',
        maxResults: 5,
        safeSearch: 'strict',
      })
      assert.equal(res.items.length, 1)
      assert.ok(capturedUrl.includes('freshness=pd'), `url: ${capturedUrl}`)
      assert.ok(capturedUrl.includes('search_lang=hu'), `url: ${capturedUrl}`)
      assert.ok(!capturedUrl.includes('country='), `url: ${capturedUrl}`)
      assert.ok(!capturedUrl.includes('ui_lang='), `url: ${capturedUrl}`)
      const headers = capturedHeaders as Record<string, string>
      assert.equal(headers['Cache-Control'], 'no-cache')
      assert.equal(headers['X-Subscription-Token'], 'test-key')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  console.log('\n=== Adapter resolver — provider CONNECTOR-onként, nem globális env-állapot ===')
  await test('resolveAdapter megkapja a connector configot és a secretAlias-t', async () => {
    const calls: Array<{ provider: string; secretAlias: string | null }> = []
    const config = bankingStrictConfig({ provider: 'custom_search_api', allowGeneralWeb: true, allowedDomains: [] })
    const svc = new WebSearchService(async (cfg, secretAlias) => {
      calls.push({ provider: cfg.provider, secretAlias })
      return new StubSearchProviderAdapter()
    }, policy)
    const decision = policy.authorize({ query: 'public info' }, config, {
      enabled: true,
      scopedQueryCount: 0,
      agentDayQueryCount: 0,
    })
    assert.equal(decision.allowed, true)
    if (!decision.allowed) return
    await svc.search(decision.effective, config, 'env:SOME_KEY')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].provider, 'custom_search_api')
    assert.equal(calls[0].secretAlias, 'env:SOME_KEY')
  })

  console.log('\n=== Connector config parse — defaults ===')
  await test('parseWebSearchConfig hiányos/üres configból biztonságos defaultot ad', () => {
    const parsed = parseWebSearchConfig(null)
    assert.equal(parsed.allowGeneralWeb, false)
    assert.equal(parsed.logRawQuery, false)
    assert.deepEqual(parsed.allowedDomains, [])
  })
  await test('parseWebSearchConfig megőrzi a custom provider API URL-t', () => {
    const parsed = parseWebSearchConfig({
      provider: 'custom_search_api',
      providerApiUrl: ' https://api.bing.microsoft.com/v7.0/search ',
    })
    assert.equal(parsed.provider, 'custom_search_api')
    assert.equal(parsed.providerApiUrl, 'https://api.bing.microsoft.com/v7.0/search')
  })

  if (failures > 0) {
    console.error(`\n${failures} web_search teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden web_search teszt zöld.')
}

main()
