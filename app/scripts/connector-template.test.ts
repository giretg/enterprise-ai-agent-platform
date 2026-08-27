import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { backfillHttpApiConnectorConfig } from '../src/domain/connector/canonical-config'
import { parseHttpApiConfig } from '../src/domain/connector/http-api-client'
import { BUILTIN_CONNECTOR_TEMPLATES } from '../src/domain/connector-template/builtin-templates'
import { GLOBAL_CUSTOM_CONNECTOR_TEMPLATES } from '../src/domain/connector-template/custom-template-seeds'
import {
  ConnectorTemplateMaterializationError,
  materializeConnectorConfig,
  selfCheckTemplateDescriptor,
} from '../src/domain/connector-template/materializer'
import { materializeGmailConnectorConfig } from '../src/domain/connector-template/gmail-connector-config'
import { parseTemplateDescriptor } from '../src/domain/connector-template/template-descriptor'
import { HttpSandboxConnectionTester } from '../src/domain/provisioning/sandbox-connection-tester'
import {
  applyMigrationWithSecretCompensation,
  isOstorosborBearerMigrationCandidate,
  rematerializeOstorosborConnectorConfig,
} from '../src/domain/connector-template/ostorosbor-bearer-migration'
import { enrichOstorosborConnectorConfig } from '../src/domain/connector-template/ostorosbor-config-enrichment'

let failures = 0
function pass(name: string) {
  console.log(`  ✓ ${name}`)
}
function fail(name: string, err: unknown) {
  failures += 1
  console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
}
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    pass(name)
  } catch (err) {
    fail(name, err)
  }
}

async function main() {
  console.log('connector template materializer')

  await test('builtin descriptors validate', () => {
    for (const descriptor of BUILTIN_CONNECTOR_TEMPLATES) {
      assert.equal(parseTemplateDescriptor(descriptor).key, descriptor.key)
    }
  })

  await test('Gmail template materializes delegated oauth config', () => {
    const descriptor = parseTemplateDescriptor(BUILTIN_CONNECTOR_TEMPLATES[0])
    assert.equal(descriptor.connectorType, 'gmail')
    const config = materializeGmailConnectorConfig(
      descriptor,
      {
        authMethodKind: 'user_delegated_oauth2',
        instanceValues: { clientId: 'google-client-id.apps.googleusercontent.com' },
        selectedScopes: ['gmail.modify'],
      },
      { clientSecret: 'secret-ref:connector-template/google-workspace/client-secret' },
      {
        templateId: 'template-1',
        templateKey: 'google-workspace',
        templateVersion: 1,
        templateOrigin: 'builtin',
        materializedAt: '2026-07-02T00:00:00.000Z',
      },
    )

    assert.equal(config.provider, 'google')
    assert.equal(config.oauth.authUrl, 'https://accounts.google.com/o/oauth2/v2/auth')
    assert.equal(config.oauth.tokenUrl, 'https://oauth2.googleapis.com/token')
    assert.equal(config.oauth.userInfoUrl, 'https://www.googleapis.com/oauth2/v2/userinfo')
    assert.deepEqual(config.oauth.offlineParams, { access_type: 'offline' })
    assert.equal(config.oauth.scopeTransform, 'gmailAlias')
    assert.equal(config.oauth.clientId, 'google-client-id.apps.googleusercontent.com')
    assert.ok(config.oauth.scopes.includes('https://www.googleapis.com/auth/gmail.modify'))
    assert.ok(!JSON.stringify(config).includes('raw-client-secret'))
    assert.equal(config.provenance?.templateKey, 'google-workspace')
  })

  await test('all builtin http_api templates materialize to runtime-parseable configs', () => {
    const inputs: Record<
      string,
      {
        authMethodKind: 'api_key' | 'bearer' | 'basic' | 'service_oauth2' | 'user_delegated_oauth2'
        instanceValues: Record<string, string>
        secretAliases: Record<string, string>
      }
    > = {
      'google-workspace': {
        authMethodKind: 'user_delegated_oauth2',
        instanceValues: { clientId: 'google-client-id.apps.googleusercontent.com' },
        secretAliases: { clientSecret: 'secret-ref:google-client-secret' },
      },
      'microsoft-365': {
        authMethodKind: 'user_delegated_oauth2',
        instanceValues: { clientId: 'microsoft-client-id' },
        secretAliases: { clientSecret: 'secret-ref:microsoft-client-secret' },
      },
      'jira-cloud': {
        authMethodKind: 'api_key',
        instanceValues: { siteHost: 'example.atlassian.net' },
        secretAliases: { apiToken: 'secret-ref:jira-api-token' },
      },
      slack: {
        authMethodKind: 'bearer',
        instanceValues: {},
        secretAliases: { botToken: 'secret-ref:slack-bot-token' },
      },
    }

    for (const rawDescriptor of BUILTIN_CONNECTOR_TEMPLATES) {
      const descriptor = parseTemplateDescriptor(rawDescriptor)
      if ((descriptor.connectorType ?? 'http_api') === 'gmail') continue
      if ((descriptor.connectorType ?? 'http_api') === 'google_drive') continue
      const input = inputs[descriptor.key]
      assert.ok(input, `missing test input for ${descriptor.key}`)
      const config = materializeConnectorConfig(
        descriptor,
        {
          authMethodKind: input.authMethodKind,
          instanceValues: input.instanceValues,
        },
        input.secretAliases,
        {
          templateKey: descriptor.key,
          templateVersion: 1,
          templateOrigin: 'builtin',
          materializedAt: '2026-07-02T00:00:00.000Z',
        },
      )
      const runtime = parseHttpApiConfig(config)
      assert.ok(runtime.baseUrl.startsWith('https://'))
      assert.ok((config.proposedTools ?? []).length > 0)
      assert.equal(config.provenance?.templateKey, descriptor.key)
      // WP-3: endpoint-listás, nem-github http_api sablon alapból korlátozott, és a
      // korlát a runtime configon is átjön (a modell csak a listát hívhatja).
      assert.equal(config.restrictToEndpoints, true, `${descriptor.key} should restrict endpoints`)
      assert.equal(runtime.restrictToEndpoints, true)
    }
  })

  await test('Gmail draft materializes without client id (platform OAuth supplies it)', () => {
    const descriptor = parseTemplateDescriptor(BUILTIN_CONNECTOR_TEMPLATES[0])
    const config = materializeGmailConnectorConfig(
      descriptor,
      {
        authMethodKind: 'user_delegated_oauth2',
        instanceValues: {},
        selectedScopes: ['gmail.modify'],
      },
      {},
    )
    assert.equal(config.oauth.clientId, undefined)
    assert.ok(config.oauth.scopes.length > 0)
    assert.ok(descriptor.activationHelp?.includes('platform Google OAuth'))
  })

  await test('unknown selected Gmail scope is rejected', () => {
    const descriptor = parseTemplateDescriptor(BUILTIN_CONNECTOR_TEMPLATES[0])
    assert.throws(
      () =>
        materializeGmailConnectorConfig(
          descriptor,
          {
            authMethodKind: 'user_delegated_oauth2',
            instanceValues: { clientId: 'client-id' },
            selectedScopes: ['drive.admin'],
          },
          { clientSecret: 'secret-ref:client-secret' },
        ),
      ConnectorTemplateMaterializationError,
    )
  })

  await test('valid custom descriptor passes template self-check', () => {
    const descriptor = parseTemplateDescriptor({
      key: 'acme-crm',
      displayName: 'Acme CRM',
      baseUrl: 'https://api.acme.example',
      egressHosts: ['api.acme.example'],
      authMethods: [{ kind: 'api_key', header: 'X-Api-Key' }],
      endpoints: [{ name: 'list_contacts', method: 'GET', path: '/v1/contacts', access: 'read' }],
      instanceFields: [
        { name: 'apiToken', label: 'API token', type: 'secret', target: 'auth.secretAliasSuggested' },
      ],
    })
    const config = selfCheckTemplateDescriptor(descriptor)
    assert.equal(config.auth.type, 'api_key_header')
    assert.equal(config.provenance?.templateOrigin, 'custom')
    // a self-check által materializált config futásidőben is parse-olható (materialization contract)
    parseHttpApiConfig(config)
  })

  await test('seeded GitHub custom descriptor materializes to runtime-parseable config', () => {
    const rawDescriptor = GLOBAL_CUSTOM_CONNECTOR_TEMPLATES.find((item) => item.key === 'github')
    assert.ok(rawDescriptor, 'missing github custom template')
    const descriptor = parseTemplateDescriptor(rawDescriptor)
    assert.ok(descriptor.activationHelp?.includes('Personal access token'))

    const config = materializeConnectorConfig(
      descriptor,
      {
        authMethodKind: 'bearer',
        instanceValues: { repositoryAccess: 'giretg/ostorosbor-crm, excellence/partner-api' },
      },
      { personalAccessToken: 'secret-ref:github-pat' },
      {
        templateKey: descriptor.key,
        templateVersion: 1,
        templateOrigin: 'custom',
        materializedAt: '2026-07-06T00:00:00.000Z',
      },
    )

    const runtime = parseHttpApiConfig(config)
    assert.equal(runtime.baseUrl, 'https://api.github.com')
    assert.equal(runtime.auth.scheme, 'bearer')
    assert.deepEqual(runtime.githubRepositoryAccess, {
      mode: 'selected',
      repositories: ['giretg/ostorosbor-crm', 'excellence/partner-api'],
    })
    assert.ok((config.proposedTools ?? []).every((tool) => tool.path.startsWith('/repos/{owner}/{repo}')))
    assert.ok(!(config.proposedTools ?? []).some((tool) => tool.name === 'list_user_repositories'))
  })

  await test('seeded GitHub custom descriptor keeps account-wide tools in any mode', () => {
    const rawDescriptor = GLOBAL_CUSTOM_CONNECTOR_TEMPLATES.find((item) => item.key === 'github')
    assert.ok(rawDescriptor, 'missing github custom template')
    const config = materializeConnectorConfig(
      parseTemplateDescriptor(rawDescriptor),
      {
        authMethodKind: 'bearer',
        instanceValues: { repositoryAccess: '*' },
      },
      { personalAccessToken: 'secret-ref:github-pat' },
    )
    assert.deepEqual(parseHttpApiConfig(config).githubRepositoryAccess, { mode: 'any' })
    assert.ok((config.proposedTools ?? []).some((tool) => tool.name === 'list_user_repositories'))
    // WP-3 kivétel: GitHub repo-scope connectort NEM korlátozzuk endpoint-listával —
    // azt a repository-határ őrzi, a katalógusa szándékosan tágabb.
    assert.equal(config.restrictToEndpoints, undefined)
  })

  await test('all seeded custom descriptors parse; marketing templates self-check', () => {
    const marketingKeys = new Set([
      'google-search-console',
      'google-analytics',
      'google-ads',
      'meta-ads',
    ])
    for (const rawDescriptor of GLOBAL_CUSTOM_CONNECTOR_TEMPLATES) {
      const descriptor = parseTemplateDescriptor(rawDescriptor)
      assert.equal(descriptor.key, rawDescriptor.key)
      if (!marketingKeys.has(descriptor.key)) continue
      const config = selfCheckTemplateDescriptor(descriptor)
      parseHttpApiConfig(config)
      assert.equal(config.provenance?.templateKey, descriptor.key)
    }
  })

  await test('Google Ads template injects developer-token request header', () => {
    const rawDescriptor = GLOBAL_CUSTOM_CONNECTOR_TEMPLATES.find((item) => item.key === 'google-ads')
    assert.ok(rawDescriptor, 'missing google-ads custom template')
    const config = materializeConnectorConfig(
      parseTemplateDescriptor(rawDescriptor),
      {
        authMethodKind: 'user_delegated_oauth2',
        instanceValues: {
          clientId: 'google-ads-client-id.apps.googleusercontent.com',
          developerToken: 'dev-token-example',
          loginCustomerId: '1234567890',
        },
      },
      { clientSecret: 'secret-ref:google-ads-oauth-client-secret' },
    )
    const runtime = parseHttpApiConfig(config)
    assert.equal(runtime.baseUrl, 'https://googleads.googleapis.com')
    assert.equal(config.requestHeaders?.['developer-token'], 'dev-token-example')
    assert.equal(config.requestHeaders?.['login-customer-id'], '1234567890')
    assert.equal(config.auth.type, 'oauth2')
    assert.equal(config.auth.scope, 'https://www.googleapis.com/auth/adwords')
    assert.equal(config.restrictToEndpoints, true)
    assert.ok((config.proposedTools ?? []).some((tool) => tool.name === 'search'))
  })

  await test('marketing custom templates expose documented hosts and default read tools', () => {
    const expected = {
      'google-search-console': {
        baseUrl: 'https://searchconsole.googleapis.com',
        auth: 'user_delegated_oauth2',
        defaultTool: 'query_search_analytics',
      },
      'google-analytics': {
        baseUrl: 'https://analyticsdata.googleapis.com',
        auth: 'user_delegated_oauth2',
        defaultTool: 'run_report',
      },
      'google-ads': {
        baseUrl: 'https://googleads.googleapis.com',
        auth: 'user_delegated_oauth2',
        defaultTool: 'list_accessible_customers',
      },
      'meta-ads': {
        baseUrl: 'https://graph.facebook.com/v26.0',
        auth: 'bearer',
        defaultTool: 'list_ad_accounts',
      },
    } as const

    for (const [key, spec] of Object.entries(expected)) {
      const raw = GLOBAL_CUSTOM_CONNECTOR_TEMPLATES.find((item) => item.key === key)
      assert.ok(raw, `missing ${key} custom template`)
      const descriptor = parseTemplateDescriptor(raw)
      assert.equal(descriptor.baseUrl, spec.baseUrl)
      assert.equal(descriptor.authMethods[0]?.kind, spec.auth)
      assert.ok(descriptor.endpoints.some((endpoint) => endpoint.name === spec.defaultTool && endpoint.default))
    }
  })

  await test('broken custom descriptor fails template self-check', () => {
    // Séma-szinten érvényes, de a példány materializálása elbukik: az instance-mező
    // egy nem támogatott config-targetre mutat → a mentés self-checkje elutasítja.
    const descriptor = parseTemplateDescriptor({
      key: 'broken-provider',
      displayName: 'Broken Provider',
      baseUrl: 'https://api.broken.example',
      egressHosts: ['api.broken.example'],
      authMethods: [{ kind: 'bearer' }],
      instanceFields: [
        { name: 'weird', label: 'Weird field', type: 'string', target: 'auth.doesNotExist' },
      ],
    })
    assert.throws(
      () => selfCheckTemplateDescriptor(descriptor),
      ConnectorTemplateMaterializationError,
    )
  })

  await test('legacy provisioning config backfills to canonical runtime config', () => {
    const result = backfillHttpApiConnectorConfig({
      provider: 'jira-cloud',
      baseUrl: 'https://example.atlassian.net/',
      auth: { type: 'api_key_header', headerName: 'Authorization' },
      proposedTools: [
        { name: 'myself', method: 'GET', path: '/rest/api/3/myself', access: 'read' },
        { name: 'create_issue', method: 'POST', path: '/rest/api/3/issue', access: 'write' },
      ],
    })

    assert.equal(result.changed, true)
    assert.deepEqual(result.config.auth, { scheme: 'header', header: 'Authorization' })
    assert.equal('proposedTools' in result.config, false)
    assert.deepEqual(result.config.endpoints, [
      { method: 'GET', path: '/rest/api/3/myself' },
      { method: 'POST', path: '/rest/api/3/issue' },
    ])
    const runtime = parseHttpApiConfig(result.config)
    assert.equal(runtime.baseUrl, 'https://example.atlassian.net')
  })

  await test('Ostorosbor bearer migráció csak aktív, bizonyított sablonpéldányt választ ki', () => {
    const trapConfig = {
      provider: 'ostorosbor-crm-sales-delegated',
      baseUrl: 'https://crm.ostorosbor.example/api/connector/v1',
      egressHosts: ['crm.ostorosbor.example'],
      authMode: 'service',
      auth: { type: 'api_key_header', headerName: 'Authorization' },
      scopesSuggested: [],
      proposedTools: [],
      provenance: { templateKey: 'ostorosbor-crm-sales-delegated' },
    }

    assert.equal(
      isOstorosborBearerMigrationCandidate({
        type: 'http_api',
        lifecycleState: 'active',
        config: trapConfig,
      }),
      true,
    )
    assert.equal(
      isOstorosborBearerMigrationCandidate({
        type: 'http_api',
        lifecycleState: 'draft',
        config: trapConfig,
      }),
      false,
      'draft connector nem migrálható',
    )
    assert.equal(
      isOstorosborBearerMigrationCandidate({
        type: 'http_api',
        lifecycleState: 'active',
        config: { ...trapConfig, provider: 'foreign-crm', provenance: undefined },
      }),
      false,
      'idegen Authorization-headeres connector nem migrálható',
    )
  })

  await test('Ostorosbor enrich backfill hiányzó requestHeaders-t régi draft configban', () => {
    const { config, changed } = enrichOstorosborConnectorConfig({
      provider: 'ostorosbor-crm-sales-delegated',
      baseUrl: 'https://crm.example/api/connector/v1',
      egressHosts: ['crm.example'],
      authMode: 'service',
      auth: { type: 'bearer_token' },
      scopesSuggested: [],
      proposedTools: [{ name: 'list_accounts', method: 'GET', path: '/accounts', access: 'read' }],
    })
    assert.equal(changed, true)
    assert.deepEqual(config.requestHeaders, {
      'X-Agent-Id': '{{agent.id}}',
      'X-Acting-User': '{{actingUser.email}}',
      'X-Connector-Call-Id': '{{call.id}}',
    })
  })

  await test('Ostorosbor enrich: meglévő POST /reports/query → risk:read (HITL kikapcsolás)', () => {
    const { config, changed } = enrichOstorosborConnectorConfig({
      provider: 'custom-import',
      baseUrl: 'https://crm.example/api/connector/v1',
      egressHosts: ['crm.example'],
      authMode: 'service',
      auth: { type: 'bearer_token' },
      scopesSuggested: [],
      proposedTools: [
        {
          name: 'queryReport',
          method: 'POST',
          path: '/reports/query',
          access: 'write',
        },
        {
          name: 'exportReport',
          method: 'POST',
          path: '/reports/exports',
          access: 'write',
          risk: 'write',
        },
      ],
    })
    assert.equal(changed, true)
    const query = config.proposedTools.find((t) => t.path === '/reports/query')
    const exp = config.proposedTools.find((t) => t.path === '/reports/exports')
    assert.equal(query?.risk, 'read')
    assert.equal(exp?.risk, 'read')
  })

  await test('Ostorosbor enrich: service-insight hiányzó report végpontokat pótol', () => {
    const { config, changed } = enrichOstorosborConnectorConfig({
      provider: 'ostorosbor-crm-service-insight',
      baseUrl: 'https://crm.example/api/connector/v1',
      egressHosts: ['crm.example'],
      authMode: 'service',
      auth: { type: 'bearer_token' },
      scopesSuggested: [],
      proposedTools: [{ name: 'list_accounts', method: 'GET', path: '/accounts', access: 'read' }],
      requestHeaders: {
        'X-Agent-Id': '{{agent.id}}',
        'X-Acting-User': '{{actingUser.email}}',
        'X-Connector-Call-Id': '{{call.id}}',
      },
    })
    assert.equal(changed, true)
    assert.ok(config.proposedTools.some((t) => t.method === 'POST' && t.path === '/reports/query' && t.risk === 'read'))
    assert.ok(config.proposedTools.some((t) => t.method === 'POST' && t.path === '/reports/exports' && t.risk === 'read'))
  })

  await test('Ostorosbor bearer migráció újramaterializál, sandbox /accounts 200', async () => {
    const config = rematerializeOstorosborConnectorConfig({
      id: 'connector-1',
      type: 'http_api',
      lifecycleState: 'active',
      secretAlias: 'secret-ref:connector/connector-1',
      config: {
        provider: 'ostorosbor-crm-sales-delegated',
        baseUrl: 'https://crm.ostorosbor.example/api/connector/v1',
        egressHosts: ['crm.ostorosbor.example'],
        authMode: 'service',
        auth: { type: 'api_key_header', headerName: 'Authorization' },
        scopesSuggested: [],
        proposedTools: [
          { name: 'list_accounts', method: 'GET', path: '/accounts', access: 'read' },
          { name: 'create_task', method: 'POST', path: '/tasks', access: 'write' },
        ],
        provenance: {
          templateKey: 'ostorosbor-crm-sales-delegated',
          templateVersion: 1,
          templateOrigin: 'custom',
        },
      },
    })

    assert.deepEqual(config.auth, {
      type: 'bearer_token',
      secretAliasSuggested: 'secret-ref:connector/connector-1',
    })
    assert.deepEqual(config.requestHeaders, {
      'X-Agent-Id': '{{agent.id}}',
      'X-Acting-User': '{{actingUser.email}}',
      'X-Connector-Call-Id': '{{call.id}}',
    })
    assert.equal(config.baseUrl, 'https://crm.ostorosbor.example/api/connector/v1')
    assert.deepEqual(
      config.proposedTools.map((tool) => tool.name),
      ['list_accounts', 'create_task'],
    )
    assert.equal(config.restrictToEndpoints, true)

    const calls: string[] = []
    const sandbox = new HttpSandboxConnectionTester({
      resolveEgressAllowlist: async () => ['crm.ostorosbor.example'],
      fetchImpl: async (url) => {
        calls.push(url)
        return { status: 200, type: 'basic' } as Response
      },
    })
    const result = await sandbox.test({ config, secretAlias: null, tenantId: 'tenant-1' })
    assert.equal(result.ok, true)
    assert.equal(result.statusCode, 200)
    assert.deepEqual(calls, ['https://crm.ostorosbor.example/api/connector/v1/accounts'])
  })

  await test('Ostorosbor migráció config-hibánál visszaállítja az eredeti secretet', async () => {
    const savedSecrets: string[] = []
    await assert.rejects(() =>
      applyMigrationWithSecretCompensation({
        originalSecret: 'Bearer original-token',
        strippedSecret: 'original-token',
        saveSecret: async (value) => {
          savedSecrets.push(value)
        },
        updateConfig: async () => {
          throw new Error('database unavailable')
        },
      }),
    )
    assert.deepEqual(savedSecrets, ['original-token', 'Bearer original-token'])
  })

  await test('agent connector nézet csak kötést szerkeszt, strukturális update nincs kiexportálva', () => {
    const agentConnectorSource = readFileSync(
      resolve(process.cwd(), 'src/components/agents/api-connector-list.tsx'),
      'utf8',
    )
    const platformActionsSource = readFileSync(
      resolve(process.cwd(), 'src/app/actions/platform.ts'),
      'utf8',
    )

    assert.doesNotMatch(agentConnectorSource, /EditApiConnectorForm/)
    assert.match(agentConnectorSource, /href="\/control-plane\/provisioning"/)
    assert.doesNotMatch(
      platformActionsSource,
      /export async function updateHttpApiConnectorForAgent/,
    )
  })

  await test('legacy Google oauth backfill writes explicit provider metadata once', () => {
    const result = backfillHttpApiConnectorConfig(
      {
        provider: 'google-workspace',
        baseUrl: 'https://gmail.googleapis.com',
        auth: { type: 'oauth2', clientId: 'client-id', scope: 'gmail.readonly' },
        proposedTools: [{ name: 'profile', method: 'GET', path: '/gmail/v1/users/me/profile', access: 'read' }],
      },
      { connectorType: 'http_api', connectorName: 'Google Workspace' },
    )

    assert.equal(result.addedGoogleOauthDefaults, true)
    assert.deepEqual(result.config.auth, {
      scheme: 'oauth2',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: 'client-id',
      scope: 'gmail.readonly',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
      accountEmailField: 'email',
      offlineParams: { access_type: 'offline' },
      scopeTransform: 'gmailAlias',
    })
    parseHttpApiConfig(result.config)
  })

  await test('legacy gmail connector oauth block backfills without http_api auth shape', () => {
    const result = backfillHttpApiConnectorConfig(
      {
        provider: 'google',
        oauth: {
          clientId: 'gmail-client-id',
          scopes: ['https://www.googleapis.com/auth/gmail.modify'],
        },
      },
      { connectorType: 'gmail', connectorName: 'Gmail (felhasználói)' },
    )

    assert.equal(result.changed, true)
    assert.equal(result.addedGoogleOauthDefaults, true)
    assert.deepEqual(result.config.oauth, {
      clientId: 'gmail-client-id',
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
      accountEmailField: 'email',
      offlineParams: { access_type: 'offline' },
      scopeTransform: 'gmailAlias',
    })
  })

  if (failures > 0) {
    console.error(`\n${failures} connector-template test(s) failed`)
    process.exit(1)
  }
  console.log('\nconnector template tests passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
