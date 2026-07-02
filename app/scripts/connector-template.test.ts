import assert from 'node:assert/strict'
import { parseHttpApiConfig } from '../src/domain/connector/http-api-client'
import { BUILTIN_CONNECTOR_TEMPLATES } from '../src/domain/connector-template/builtin-templates'
import {
  ConnectorTemplateMaterializationError,
  materializeConnectorConfig,
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
