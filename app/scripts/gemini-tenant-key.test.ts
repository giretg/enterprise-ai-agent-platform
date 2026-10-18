/**
 * Tenant Gemini-kulcs: titoktár + gateway OpenAI-kompatibilis végpont.
 * Futtatás: npm run test:gemini-tenant-key
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envProviderRegistry } from '../src/domain/model-gateway/proxy'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import {
  GEMINI_OPENAI_BASE_URL,
  geminiSecretId,
  loadGeminiTenantKey,
  parseGeminiApiKey,
  resolveGeminiApiKey,
  saveGeminiTenantKey,
} from '../src/lib/gemini-tenant-key'

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const KEY_A = 'AIzaSyTenantAKeyaaaaaaaaaaaaaaa'
const KEY_B = 'AIzaSyTenantBKeybbbbbbbbbbbbbbb'
const KEY_ENV = 'AIzaSyPlatformEnvFallbackxxxxxx'
const KEY_AQ = 'AQ.Ab8TESTONLYGeminiAuthKeyaaaaaaa'

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

async function withSecretDir(fn: () => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-key-'))
  const previousDir = process.env.CONNECTOR_SECRET_DIR
  const previousPrefix = process.env.CONNECTOR_SECRET_PREFIX
  process.env.CONNECTOR_SECRET_DIR = dir
  delete process.env.CONNECTOR_SECRET_PREFIX
  try {
    await fn()
  } finally {
    if (previousDir === undefined) delete process.env.CONNECTOR_SECRET_DIR
    else process.env.CONNECTOR_SECRET_DIR = previousDir
    if (previousPrefix === undefined) delete process.env.CONNECTOR_SECRET_PREFIX
    else process.env.CONNECTOR_SECRET_PREFIX = previousPrefix
    await rm(dir, { recursive: true, force: true })
  }
}

async function main() {
  await check('a secret id connector-key-gemini-<tenantId> alá kerül', () => {
    assert.equal(geminiSecretId(TENANT_A), `gemini-${TENANT_A}`)
  })

  await check('formátum: AIza… és AQ.… elfogadva, szemét elutasítva', () => {
    assert.equal(parseGeminiApiKey(`  ${KEY_A}  `), KEY_A)
    assert.equal(parseGeminiApiKey(`  ${KEY_AQ}  `), KEY_AQ)
    assert.throws(() => parseGeminiApiKey('sk-or-v1-not-gemini-key-xxxx'), /invalid_gemini_key/)
    assert.throws(() => parseGeminiApiKey('AIza-short'), /invalid_gemini_key/)
    assert.throws(() => parseGeminiApiKey('AQ.short'), /invalid_gemini_key/)
    assert.throws(() => parseGeminiApiKey('aq.Ab8TESTONLYGeminiAuthKeyaaaaaaa'), /invalid_gemini_key/)
    assert.throws(() => parseGeminiApiKey(''), /invalid_gemini_key/)
  })

  await check('auth-kulcs (AQ.) a titoktárba kerül, a gateway OpenAI-kompatibilis végpontot hív', async () => {
    await withSecretDir(async () => {
      await saveGeminiTenantKey(TENANT_A, KEY_AQ)
      assert.equal(await loadGeminiTenantKey(TENANT_A), KEY_AQ)
      const registry = envProviderRegistry({}, async () => null, loadGeminiTenantKey)
      const endpoint = await registry('gemini', TENANT_A)
      assert.equal(endpoint?.apiKey, KEY_AQ)
      assert.equal(endpoint?.baseUrl, GEMINI_OPENAI_BASE_URL)
    })
  })

  await check('tenant kulcs nyer az env fölött', async () => {
    const key = await resolveGeminiApiKey(TENANT_A, async () => KEY_A, { GEMINI_API_KEY: KEY_ENV })
    assert.equal(key, KEY_A)
  })

  await check('hiányzó tenant-kulcs + GEMINI_API_KEY → env', async () => {
    const key = await resolveGeminiApiKey(TENANT_A, async () => null, { GEMINI_API_KEY: KEY_ENV })
    assert.equal(key, KEY_ENV)
  })

  await check('hiányzó tenant-kulcs + GOOGLE_API_KEY → env', async () => {
    const key = await resolveGeminiApiKey(TENANT_A, async () => null, { GOOGLE_API_KEY: KEY_ENV })
    assert.equal(key, KEY_ENV)
  })

  await check('mindkettő hiányzik → nincs provider', async () => {
    const registry = envProviderRegistry({}, async () => null, async () => null)
    assert.equal(await registry('gemini', TENANT_A), null)
    assert.equal(await resolveGeminiApiKey(TENANT_A, async () => null, {}), null)
  })

  await check('második tenant kulcsa nem szivárog az elsőnek', async () => {
    const keys: Record<string, string> = { [TENANT_A]: KEY_A, [TENANT_B]: KEY_B }
    const registry = envProviderRegistry({ GEMINI_API_KEY: KEY_ENV }, async () => null, async (id) => keys[id] ?? null)
    const a = await registry('gemini', TENANT_A)
    const b = await registry('gemini', TENANT_B)
    const missing = await registry('gemini', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    assert.equal(a?.apiKey, KEY_A)
    assert.equal(b?.apiKey, KEY_B)
    assert.equal(missing?.apiKey, KEY_ENV)
    assert.equal(a?.baseUrl, GEMINI_OPENAI_BASE_URL)
    assert.notEqual(a?.apiKey, b?.apiKey)
  })

  await check('OpenRouter kulcs nem nyit Gemini-t', async () => {
    const registry = envProviderRegistry(
      { OPENROUTER_API_KEY: 'sk-or-v1-platform-env-fallbackxx' },
      async () => 'sk-or-v1-tenant-a-key-aaaaaa',
      async () => null,
    )
    assert.equal(await registry('gemini', TENANT_A), null)
    assert.equal((await registry('openrouter', TENANT_A))?.apiKey, 'sk-or-v1-tenant-a-key-aaaaaa')
  })

  await check('dev titoktár: tenantonként külön fájl, a kulcs nem keveredik', async () => {
    await withSecretDir(async () => {
      await saveGeminiTenantKey(TENANT_A, KEY_A)
      await saveGeminiTenantKey(TENANT_B, KEY_B)
      assert.equal(await loadGeminiTenantKey(TENANT_A), KEY_A)
      assert.equal(await loadGeminiTenantKey(TENANT_B), KEY_B)
      const registry = envProviderRegistry({ GEMINI_API_KEY: KEY_ENV }, async () => null, loadGeminiTenantKey)
      assert.equal((await registry('gemini', TENANT_A))?.apiKey, KEY_A)
      assert.equal((await registry('gemini', TENANT_B))?.apiKey, KEY_B)
    })
  })

  await check('audit action regisztrálva, kulcs nélkül', () => {
    assert.doesNotThrow(() => assertAuditActionRegistered('model.gemini_key.set'))
  })

  await check('csak admin menthet; a mentés nem viszi a kulcsot auditba', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/app/actions/model-config.ts'), 'utf8')
    const start = src.indexOf('export async function setGeminiApiKey')
    const next = src.indexOf('\nexport async function', start + 1)
    const fn = src.slice(start, next === -1 ? undefined : next)
    assert.match(fn, /requireTenantRole\('admin'\)/)
    assert.match(fn, /metadata: \{ configured: true \}/)
    assert.doesNotMatch(fn, /metadata:[\s\S]*apiKey/)
  })

  if (failures) {
    console.error(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nminden teszt ok')
}

void main()
