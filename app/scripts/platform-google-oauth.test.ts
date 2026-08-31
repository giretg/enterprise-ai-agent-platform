/**
 * Platform Google OAuth feloldási sorrend: platform_settings → env → tenant legacy.
 *
 * Futtatás: npx tsx scripts/platform-google-oauth.test.ts
 */
import assert from 'node:assert/strict'
import {
  parseGoogleOAuthFields,
  readGoogleOAuthConfigFromEnv,
  readTenantGoogleOAuthConfig,
  resolveGoogleOAuthConfig,
  toGoogleOAuthPublicView,
} from '../src/lib/platform-google-oauth-config'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.error(`  FAIL ${name}:`, error)
  }
}

function main() {
  check('parse rejects incomplete fields', () => {
    assert.equal(parseGoogleOAuthFields({ clientId: 'id' }), null)
    assert.equal(parseGoogleOAuthFields({ clientSecret: 'secret' }), null)
    assert.equal(parseGoogleOAuthFields(null), null)
  })

  check('parse accepts a complete client', () => {
    assert.deepEqual(parseGoogleOAuthFields({
      clientId: '  id  ',
      clientSecret: ' secret ',
      redirectUri: ' https://app.example/callback ',
    }), {
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://app.example/callback',
    })
  })

  check('platform value wins over env and tenant', () => {
    const resolved = resolveGoogleOAuthConfig({
      platformValue: { clientId: 'platform-id', clientSecret: 'platform-secret' },
      envConfig: { clientId: 'env-id', clientSecret: 'env-secret' },
      tenantSettings: [{ oauth: { google: { clientId: 'tenant-id', clientSecret: 'tenant-secret' } } }],
    })
    assert.deepEqual(resolved, {
      source: 'platform',
      config: { clientId: 'platform-id', clientSecret: 'platform-secret' },
    })
  })

  check('env wins over tenant harvest', () => {
    const resolved = resolveGoogleOAuthConfig({
      platformValue: null,
      envConfig: { clientId: 'env-id', clientSecret: 'env-secret', redirectUri: 'https://env/cb' },
      tenantSettings: [{ oauth: { google: { clientId: 'tenant-id', clientSecret: 'tenant-secret' } } }],
    })
    assert.equal(resolved?.source, 'env')
    assert.equal(resolved?.config.clientId, 'env-id')
  })

  check('harvests the first complete tenant config', () => {
    const resolved = resolveGoogleOAuthConfig({
      platformValue: null,
      envConfig: null,
      tenantSettings: [
        { language: 'hu' },
        { oauth: { google: { clientId: 'tenant-id', clientSecret: 'tenant-secret' } } },
      ],
    })
    assert.deepEqual(resolved, {
      source: 'tenant_legacy',
      config: { clientId: 'tenant-id', clientSecret: 'tenant-secret' },
    })
  })

  check('drive harvest ignores gmail oauth.google (no cross-service leak)', () => {
    const resolved = resolveGoogleOAuthConfig({
      platformValue: null,
      envConfig: null,
      service: 'drive',
      tenantSettings: [
        { oauth: { google: { clientId: 'gmail-id', clientSecret: 'gmail-secret' } } },
      ],
    })
    assert.equal(resolved, null)
  })

  check('drive harvest uses oauth.drive tenant key', () => {
    const resolved = resolveGoogleOAuthConfig({
      platformValue: null,
      envConfig: null,
      service: 'drive',
      tenantSettings: [
        {
          oauth: {
            google: { clientId: 'gmail-id', clientSecret: 'gmail-secret' },
            drive: { clientId: 'drive-id', clientSecret: 'drive-secret' },
          },
        },
      ],
    })
    assert.deepEqual(resolved, {
      source: 'tenant_legacy',
      config: { clientId: 'drive-id', clientSecret: 'drive-secret' },
    })
  })

  check('public view never includes the secret', () => {
    const view = toGoogleOAuthPublicView({
      source: 'env',
      config: { clientId: 'id', clientSecret: 'secret', redirectUri: 'https://cb' },
    })
    assert.equal(view.configured, true)
    assert.equal(view.persisted, false)
    assert.equal(view.clientId, 'id')
    assert.equal(view.redirectUri, 'https://cb')
    assert.equal('clientSecret' in view, false)
  })

  check('tenant settings reader understands the legacy shape', () => {
    const config = readTenantGoogleOAuthConfig({
      oauth: { google: { clientId: 'id', clientSecret: 'secret' } },
    })
    assert.deepEqual(config, { clientId: 'id', clientSecret: 'secret' })
  })

  check('env reader uses GMAIL_OAUTH_* when present', () => {
    const prevId = process.env.GMAIL_OAUTH_CLIENT_ID
    const prevSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET
    const prevRedirect = process.env.GMAIL_OAUTH_REDIRECT_URI
    process.env.GMAIL_OAUTH_CLIENT_ID = 'env-client'
    process.env.GMAIL_OAUTH_CLIENT_SECRET = 'env-secret'
    process.env.GMAIL_OAUTH_REDIRECT_URI = 'http://localhost/cb'
    try {
      assert.deepEqual(readGoogleOAuthConfigFromEnv(), {
        clientId: 'env-client',
        clientSecret: 'env-secret',
        redirectUri: 'http://localhost/cb',
      })
    } finally {
      if (prevId === undefined) delete process.env.GMAIL_OAUTH_CLIENT_ID
      else process.env.GMAIL_OAUTH_CLIENT_ID = prevId
      if (prevSecret === undefined) delete process.env.GMAIL_OAUTH_CLIENT_SECRET
      else process.env.GMAIL_OAUTH_CLIENT_SECRET = prevSecret
      if (prevRedirect === undefined) delete process.env.GMAIL_OAUTH_REDIRECT_URI
      else process.env.GMAIL_OAUTH_REDIRECT_URI = prevRedirect
    }
  })

  if (failures > 0) {
    console.error(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nAll checks passed.')
}

main()
