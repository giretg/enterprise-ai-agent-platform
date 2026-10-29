/**
 * Google konnektorok szintjei (platform / tenant / felhasználó) — DB és élő hálózat nélkül.
 * Futtatás: npm run test:google-account-binding
 *
 * Lefedi: a tenant-szintű fiókkötés normalizálását és futásidejű határát, a platform-szintű
 * Google Ads developer token injektálását, és a felhasználói hozzáférés-hiányra adott hintet.
 */
import assert from 'node:assert/strict'
import {
  buildGoogleAccountBinding,
  checkGoogleAccountAllowed,
  describeGoogleAccountBinding,
  parseGoogleAccountBindingConfig,
} from '../src/domain/connector/google-account-binding'
import {
  HttpApiClient as RuntimeHttpApiClient,
  HttpApiError,
  parseHttpApiConfig,
  type HttpApiConfig,
  type HttpApiCredentials,
} from '../src/domain/connector/http-api-client'
import { applyPlatformGoogleAdsDeveloperToken } from '../src/domain/enterprise-tools/handlers/http-api'
import { normalizeConnectorConfig } from '../src/domain/provisioning/connector-config'
import {
  loadGoogleAdsDeveloperToken,
  toGoogleAdsDeveloperTokenPublicView,
} from '../src/lib/google-ads-developer-token'

class HttpApiClient extends RuntimeHttpApiClient {
  constructor(config: HttpApiConfig, credentials: HttpApiCredentials) {
    super(config, credentials, async () => ['8.8.8.8'])
  }
}

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Aktiválás után a delegált konnektor a felhasználó grant-tokenjét Bearerként küldi.
const googleOauth = { type: 'bearer_token' }

function adsConfig(extra: Record<string, unknown> = {}) {
  return {
    provider: 'google-ads',
    baseUrl: 'https://googleads.googleapis.com',
    egressHosts: ['googleads.googleapis.com'],
    authMode: 'user_delegated',
    auth: googleOauth,
    googleAccountBinding: { accountIds: ['1234567890'], managerAccountId: '9876543210' },
    ...extra,
  }
}

async function main() {
  console.log('google account binding tests')

  await test('fiókazonosítók normalizálása providerenként', () => {
    assert.deepEqual(buildGoogleAccountBinding('google-ads', { accountIds: ['123-456-7890', '1234567890'] }), {
      accountIds: ['1234567890'],
    })
    assert.deepEqual(buildGoogleAccountBinding('google-analytics', { accountIds: ['properties/42'] }), {
      accountIds: ['42'],
    })
    assert.deepEqual(
      buildGoogleAccountBinding('google-search-console', {
        accountIds: ['https://Example.com', 'sc-domain:EXAMPLE.hu'],
      }),
      { accountIds: ['https://example.com/', 'sc-domain:example.hu'] },
    )
    assert.throws(() => buildGoogleAccountBinding('google-ads', { accountIds: ['12345'] }), /10 számjegy/)
    assert.throws(() => buildGoogleAccountBinding('google-ads', { accountIds: [] }), /Legalább egy/)
    // Az MCC csak Google Ads-nél értelmes; más providernél nem tároljuk.
    assert.deepEqual(
      buildGoogleAccountBinding('google-analytics', { accountIds: ['42'], managerAccountId: '9876543210' }),
      { accountIds: ['42'] },
    )
  })

  await test('kötés csak Google fiókos providerre menthető (config séma)', () => {
    assert.throws(
      () =>
        normalizeConnectorConfig({
          ...adsConfig(),
          provider: 'billingo',
        }),
      /googleAccountBinding/,
    )
    const ok = normalizeConnectorConfig(adsConfig())
    assert.deepEqual(ok.googleAccountBinding?.accountIds, ['1234567890'])
    assert.throws(() => parseGoogleAccountBindingConfig('google-ads', { accountIds: 'x' }), /string array/)
  })

  await test('futásidejű határ: csak a kötött fiókra mehet hívás', () => {
    const ads = buildGoogleAccountBinding('google-ads', { accountIds: ['1234567890'] })
    assert.equal(checkGoogleAccountAllowed('google-ads', ads, '/v25/customers/1234567890/googleAds:search').allowed, true)
    assert.equal(checkGoogleAccountAllowed('google-ads', ads, '/v25/customers/5555555555/googleAds:search').allowed, false)
    assert.equal(checkGoogleAccountAllowed('google-ads', ads, '/v25/customers/1234567890').allowed, true)
    // Fiók-független hívás (a felhasználó elérhető fiókjai) nem korlátozott.
    assert.equal(checkGoogleAccountAllowed('google-ads', ads, '/v25/customers:listAccessibleCustomers').allowed, true)

    const ga = buildGoogleAccountBinding('google-analytics', { accountIds: ['42'] })
    assert.equal(checkGoogleAccountAllowed('google-analytics', ga, '/v1beta/properties/42:runReport').allowed, true)
    assert.equal(checkGoogleAccountAllowed('google-analytics', ga, '/v1beta/properties/43:runReport').allowed, false)
    assert.equal(checkGoogleAccountAllowed('google-analytics', ga, '/v1beta/properties/0/metadata').allowed, true)
    // www.googleapis.com/{service}/v… előtag ne kerülje meg a kötést (Admin API / Ads).
    assert.equal(
      checkGoogleAccountAllowed('google-analytics', ga, '/analyticsadmin/v1beta/properties/43').allowed,
      false,
    )
    assert.equal(
      checkGoogleAccountAllowed('google-analytics', ga, '/analyticsadmin/v1beta/properties/42/dataStreams')
        .allowed,
      true,
    )
    assert.equal(
      checkGoogleAccountAllowed(
        'google-ads',
        ads,
        '/googleads/v25/customers/5555555555/googleAds:search',
      ).allowed,
      false,
    )
    assert.equal(
      checkGoogleAccountAllowed(
        'google-ads',
        ads,
        '/googleads/v25/customers/1234567890/googleAds:search',
      ).allowed,
      true,
    )

    const sc = buildGoogleAccountBinding('google-search-console', { accountIds: ['https://www.example.com/'] })
    assert.equal(
      checkGoogleAccountAllowed(
        'google-search-console',
        sc,
        '/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F/searchAnalytics/query',
      ).allowed,
      true,
    )
    assert.equal(
      checkGoogleAccountAllowed('google-search-console', sc, '/webmasters/v3/sites/sc-domain%3Aother.com/sitemaps')
        .allowed,
      false,
    )
    assert.equal(checkGoogleAccountAllowed('google-search-console', sc, '/webmasters/v3/sites').allowed, true)
    assert.equal(
      checkGoogleAccountAllowed('google-search-console', sc, '/v1/urlInspection/index:inspect', {
        inspectionUrl: 'https://www.other.com/x',
        siteUrl: 'https://www.other.com/',
      }).allowed,
      false,
    )
    assert.equal(
      checkGoogleAccountAllowed('google-search-console', sc, '/v1/urlInspection/index:inspect', {}).allowed,
      false,
    )
    // Kötés nélküli régi konnektor: visszafelé kompatibilisen korlátlan.
    assert.equal(checkGoogleAccountAllowed('google-ads', undefined, '/v25/customers/5555555555').allowed, true)
  })

  await test('HttpApiClient: nem kötött fiók → google_account_not_allowed, érthető okkal', async () => {
    const client = new HttpApiClient(parseHttpApiConfig(adsConfig()), 'stub-token')
    await assert.rejects(
      client.request({ method: 'POST', path: '/v25/customers/5555555555/googleAds:search', body: {} }),
      (e: unknown) =>
        e instanceof HttpApiError &&
        e.code === 'google_account_not_allowed' &&
        (e.reason ?? '').includes('123-456-7890'),
    )
    const ok = await client.request({ method: 'POST', path: '/v25/customers/1234567890/googleAds:search', body: {} })
    assert.equal(ok.ok, true)
  })

  await test('MCC kötés → login-customer-id platform-injektált fejléc (modell nem adhatja meg)', async () => {
    const config = parseHttpApiConfig(adsConfig())
    assert.equal(config.requestHeaders?.['login-customer-id'], '9876543210')
    const client = new HttpApiClient(config, 'stub-token')
    await assert.rejects(
      client.request({
        method: 'GET',
        path: '/v25/customers/1234567890',
        headers: { 'login-customer-id': '5555555555' },
      }),
      (e: unknown) => e instanceof HttpApiError && e.code === 'platform_injected_header',
    )
  })

  await test('developer token: platform-szintű érték felülírja a régi tenant-fejlécet', async () => {
    const legacy = parseHttpApiConfig(adsConfig({ requestHeaders: { 'Developer-Token': 'tenant-legacy' } }))
    const applied = await applyPlatformGoogleAdsDeveloperToken(legacy, async () => ({
      developerToken: 'platform-token',
      source: 'platform',
    }))
    assert.deepEqual(
      Object.entries(applied.requestHeaders ?? {}).filter(([name]) => name.toLowerCase() === 'developer-token'),
      [['developer-token', 'platform-token']],
    )
  })

  await test('developer token: platformon nincs → régi tenant-fejléc tartalék, különben érthető hiba', async () => {
    const legacy = parseHttpApiConfig(adsConfig({ requestHeaders: { 'developer-token': 'tenant-legacy' } }))
    const kept = await applyPlatformGoogleAdsDeveloperToken(legacy, async () => null)
    assert.equal(kept.requestHeaders?.['developer-token'], 'tenant-legacy')

    await assert.rejects(
      applyPlatformGoogleAdsDeveloperToken(parseHttpApiConfig(adsConfig()), async () => null),
      (e: unknown) => e instanceof HttpApiError && e.code === 'google_ads_developer_token_missing',
    )
    // Nem Google Ads konnektorra nincs hatása.
    const ga = parseHttpApiConfig({
      ...adsConfig(),
      provider: 'google-analytics',
      googleAccountBinding: { accountIds: ['42'] },
    })
    assert.equal(await applyPlatformGoogleAdsDeveloperToken(ga, async () => null), ga)
  })

  await test('developer token betöltése: platform → env sorrend; a UI nem kapja meg a tokent', async () => {
    const previous = process.env.GOOGLE_ADS_DEVELOPER_TOKEN
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'env-token-1234'
    try {
      const fromPlatform = await loadGoogleAdsDeveloperToken({
        getPlatformValue: async () => ({ developerToken: 'platform-token-abcd' }),
      })
      assert.deepEqual(fromPlatform, { developerToken: 'platform-token-abcd', source: 'platform' })
      const fromEnv = await loadGoogleAdsDeveloperToken({ getPlatformValue: async () => null })
      assert.equal(fromEnv?.source, 'env')
      const view = toGoogleAdsDeveloperTokenPublicView(fromPlatform)
      assert.equal(JSON.stringify(view).includes('platform-token'), false)
      assert.equal(view.hint, '…abcd')
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN
      else process.env.GOOGLE_ADS_DEVELOPER_TOKEN = previous
    }
  })

  await test('403 a Google-tól → hint a felhasználó saját hozzáféréséről', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    try {
      const client = new HttpApiClient(parseHttpApiConfig(adsConfig()), 'user-access-token')
      const res = await client.request({
        method: 'GET',
        path: '/v25/customers/1234567890',
        context: {
          agent: { id: 'agent-1' },
          connector: { id: 'connector-1', name: 'Google Ads' },
          actingUser: { id: 'user-1', email: 'marketing@example.com', tenantId: 'tenant-1' },
          tenant: { id: 'tenant-1' },
          call: { id: 'call-1', idempotencyKey: 'call-1' },
          now: { iso: '2026-10-14T00:00:00.000Z' },
        },
      })
      assert.equal(res.ok, false)
      assert.match(res.hint ?? '', /saját, csatlakoztatott Google-fiókjának nincs joga/)
      assert.match(res.hint ?? '', /123-456-7890/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('modell-leírás: a kötött fiókot megnevezi', () => {
    const text = describeGoogleAccountBinding(
      'google-ads',
      buildGoogleAccountBinding('google-ads', { accountIds: ['1234567890'] }),
    )
    assert.match(text ?? '', /123-456-7890/)
    assert.equal(describeGoogleAccountBinding('google-ads', undefined), null)
  })

  if (failures > 0) {
    console.error(`\n${failures} google account binding test(s) failed`)
    process.exit(1)
  }
  console.log('\ngoogle account binding tests passed')
}

void main()
