import assert from 'node:assert/strict'
import { backfillHttpApiConnectorConfig } from '../src/domain/connector/canonical-config'
import { parseHttpApiConfig } from '../src/domain/connector/http-api-client'
import { BUILTIN_CONNECTOR_TEMPLATES } from '../src/domain/connector-template/builtin-templates'
import {
  ConnectorTemplateMaterializationError,
  materializeConnectorConfig,
  selfCheckTemplateDescriptor,
} from '../src/domain/connector-template/materializer'
import { parseTemplateDescriptor } from '../src/domain/connector-template/template-descriptor'

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

  await test('Google Workspace materializes self-contained OAuth config', () => {
    const descriptor = parseTemplateDescriptor(BUILTIN_CONNECTOR_TEMPLATES[0])
    const config = materializeConnectorConfig(
      descriptor,
      {
        authMethodKind: 'user_delegated_oauth2',
        instanceValues: { clientId: 'google-client-id.apps.googleusercontent.com' },
        selectedScopes: ['gmail.readonly'],
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

    assert.equal(config.authMode, 'user_delegated')
    assert.equal(config.auth.type, 'oauth2')
    assert.equal(config.auth.authUrl, 'https://accounts.google.com/o/oauth2/v2/auth')
    assert.equal(config.auth.tokenUrl, 'https://oauth2.googleapis.com/token')
    assert.equal(config.auth.userInfoUrl, 'https://www.googleapis.com/oauth2/v2/userinfo')
    assert.deepEqual(config.auth.offlineParams, { access_type: 'offline' })
    assert.equal(config.auth.scopeTransform, 'gmailAlias')
    assert.equal(config.auth.secretAliasSuggested, 'secret-ref:connector-template/google-workspace/client-secret')
    assert.equal(config.auth.clientId, 'google-client-id.apps.googleusercontent.com')
    assert.ok(!JSON.stringify(config).includes('raw-client-secret'))
    assert.equal(config.provenance?.templateKey, 'google-workspace')

    const runtime = parseHttpApiConfig(config)
    assert.equal(runtime.auth.scheme, 'oauth2')
    assert.equal(runtime.auth.tokenUrl, 'https://oauth2.googleapis.com/token')
    assert.equal(runtime.auth.authUrl, 'https://accounts.google.com/o/oauth2/v2/auth')
    assert.deepEqual(runtime.auth.offlineParams, { access_type: 'offline' })
  })

  await test('all builtin templates materialize to runtime-parseable configs', () => {
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
    }
  })

  await test('missing OAuth client id fails before runtime use', () => {
    const descriptor = parseTemplateDescriptor(BUILTIN_CONNECTOR_TEMPLATES[0])
    assert.throws(
      () =>
        materializeConnectorConfig(
          descriptor,
          {
            authMethodKind: 'user_delegated_oauth2',
            instanceValues: {},
            selectedScopes: ['gmail.readonly'],
          },
          { clientSecret: 'secret-ref:client-secret' },
        ),
      ConnectorTemplateMaterializationError,
    )
  })

  await test('unknown selected scope is rejected', () => {
    const descriptor = parseTemplateDescriptor(BUILTIN_CONNECTOR_TEMPLATES[0])
    assert.throws(
      () =>
        materializeConnectorConfig(
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
