/**
 * Platform Google OAuth feloldási sorrend: platform_settings → env → tenant legacy.
 *
 * Futtatás: npx tsx scripts/platform-google-oauth.test.ts
 */
import assert from 'node:assert/strict'
import { PlatformSettingsService } from '../src/domain/platform-settings/platform-settings-service'
import type { AuditRepository, PlatformSettingsRepository } from '../src/repositories/interfaces'
import {
  GOOGLE_OAUTH_PLATFORM_KEY,
  GOOGLE_OAUTH_SERVICE_KEYS,
  parseGoogleOAuthFields,
  readGoogleOAuthConfigFromEnv,
  readTenantGoogleOAuthConfig,
  resolveGoogleOAuthConfig,
  toGoogleOAuthPublicView,
  googleOAuthServiceForConnector,
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

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.error(`  FAIL ${name}:`, error)
  }
}

function inMemoryPlatformSettings() {
  const store = new Map<string, unknown>()
  const events: Array<{ action: string; targetId: string | null; metadata: unknown }> = []
  const settingsRepo: PlatformSettingsRepository = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value)
    },
  }
  const auditRepo = {
    append: async (event: { action: string; targetId: string | null; metadata: unknown }) => {
      events.push({ action: event.action, targetId: event.targetId, metadata: event.metadata })
      return event
    },
  } as unknown as AuditRepository
  return { svc: new PlatformSettingsService(settingsRepo, auditRepo), events, store }
}

async function main() {
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

  await checkAsync('upsertGoogleOAuthConfig audit targetId UUID-oszlopba nem ír setting-kulcsot', async () => {
    const { svc, events, store } = inMemoryPlatformSettings()
    const actorId = 'aaaaaaaa-bbbb-4000-8000-000000000001'
    await svc.upsertGoogleOAuthConfig(
      {
        clientId: '346824017066-test.apps.googleusercontent.com',
        clientSecret: 'test-secret',
        redirectUri: 'https://ai.example.com/api/connectors/oauth/callback',
      },
      actorId,
    )
    assert.equal(store.has(GOOGLE_OAUTH_PLATFORM_KEY), true)
    assert.equal(events.length, 1)
    assert.equal(events[0].action, 'platform.oauth.google.update')
    assert.equal(events[0].targetId, null)
    assert.equal((events[0].metadata as { settingKey: string }).settingKey, GOOGLE_OAUTH_PLATFORM_KEY)
  })

  await checkAsync('upsertGoogleDriveOAuthConfig audit targetId UUID-oszlopba nem ír setting-kulcsot', async () => {
    const { svc, events } = inMemoryPlatformSettings()
    await svc.upsertGoogleDriveOAuthConfig(
      { clientId: 'drive-client', clientSecret: 'drive-secret' },
      'aaaaaaaa-bbbb-4000-8000-000000000001',
    )
    assert.equal(events[0].targetId, null)
    assert.equal((events[0].metadata as { settingKey: string }).settingKey, GOOGLE_OAUTH_SERVICE_KEYS.drive)
  })

  await checkAsync('upsertGoogleDrivePickerConfig audit targetId UUID-oszlopba nem ír setting-kulcsot', async () => {
    const { svc, events } = inMemoryPlatformSettings()
    await svc.upsertGoogleDrivePickerConfig(
      { apiKey: 'picker-key', appId: 'picker-app' },
      'aaaaaaaa-bbbb-4000-8000-000000000001',
    )
    assert.equal(events[0].targetId, null)
    assert.equal((events[0].metadata as { settingKey: string }).settingKey, 'oauth.google.drive.picker')
  })

  await checkAsync('upsertGoogleApiOAuthConfig persists oauth.google.api', async () => {
    const { svc, store } = inMemoryPlatformSettings()
    await svc.upsertGoogleApiOAuthConfig(
      { clientId: 'api-client', clientSecret: 'api-secret' },
      'aaaaaaaa-bbbb-4000-8000-000000000001',
    )
    assert.equal(store.has(GOOGLE_OAUTH_SERVICE_KEYS.api), true)
  })

  check('googleOAuthServiceForConnector maps marketing templates to api service', () => {
    assert.equal(
      googleOAuthServiceForConnector({ connectorType: 'http_api', provider: 'google-analytics' }),
      'api',
    )
  })

  if (failures > 0) {
    console.error(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nAll checks passed.')
}

void main()
