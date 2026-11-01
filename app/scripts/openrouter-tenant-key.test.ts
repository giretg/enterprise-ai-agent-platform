/**
 * Tenant OpenRouter-kulcs (#805): titoktár + gateway elsőbbség.
 * Futtatás: npm run test:openrouter-tenant-key
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envProviderRegistry } from '../src/domain/model-gateway/proxy'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import {
  loadOpenRouterTenantKey,
  openRouterSecretId,
  parseOpenRouterApiKey,
  resolveOpenRouterApiKey,
  saveOpenRouterTenantKey,
} from '../src/lib/openrouter-tenant-key'

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const KEY_A = 'sk-or-v1-tenant-a-key-aaaaaa'
const KEY_B = 'sk-or-v1-tenant-b-key-bbbbbb'
const KEY_ENV = 'sk-or-v1-platform-env-fallback'

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
  const dir = await mkdtemp(join(tmpdir(), 'openrouter-key-'))
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
  await check('a secret id connector-key-openrouter-<tenantId> alá kerül', () => {
    assert.equal(openRouterSecretId(TENANT_A), `openrouter-${TENANT_A}`)
  })

  await check('formátum: sk-or-… elfogadva, szemét elutasítva', () => {
    assert.equal(parseOpenRouterApiKey(`  ${KEY_A}  `), KEY_A)
    assert.throws(() => parseOpenRouterApiKey('sk-openai-not-this'), /invalid_openrouter_key/)
    assert.throws(() => parseOpenRouterApiKey('sk-or-short'), /invalid_openrouter_key/)
    assert.throws(() => parseOpenRouterApiKey(''), /invalid_openrouter_key/)
  })

  await check('tenant kulcs nyer az env fölött', async () => {
    const key = await resolveOpenRouterApiKey(TENANT_A, async () => KEY_A, { OPENROUTER_API_KEY: KEY_ENV })
    assert.equal(key, KEY_A)
  })

  await check('hiányzó tenant-kulcs + env → env', async () => {
    const key = await resolveOpenRouterApiKey(TENANT_A, async () => null, { OPENROUTER_API_KEY: KEY_ENV })
    assert.equal(key, KEY_ENV)
  })

  await check('mindkettő hiányzik → nincs provider', async () => {
    const registry = envProviderRegistry({}, async () => null)
    assert.equal(await registry('openrouter', TENANT_A), null)
    assert.equal(await resolveOpenRouterApiKey(TENANT_A, async () => null, {}), null)
  })

  await check('második tenant kulcsa nem szivárog az elsőnek', async () => {
    const keys: Record<string, string> = { [TENANT_A]: KEY_A, [TENANT_B]: KEY_B }
    const registry = envProviderRegistry({ OPENROUTER_API_KEY: KEY_ENV }, async (id) => keys[id] ?? null)
    const a = await registry('openrouter', TENANT_A)
    const b = await registry('openrouter', TENANT_B)
    const missing = await registry('openrouter', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    assert.equal(a?.apiKey, KEY_A)
    assert.equal(b?.apiKey, KEY_B)
    assert.equal(missing?.apiKey, KEY_ENV)
    assert.notEqual(a?.apiKey, b?.apiKey)
  })

  await check('dev titoktár: tenantonként külön fájl, a kulcs nem keveredik', async () => {
    await withSecretDir(async () => {
      await saveOpenRouterTenantKey(TENANT_A, KEY_A)
      await saveOpenRouterTenantKey(TENANT_B, KEY_B)
      assert.equal(await loadOpenRouterTenantKey(TENANT_A), KEY_A)
      assert.equal(await loadOpenRouterTenantKey(TENANT_B), KEY_B)
      const registry = envProviderRegistry({ OPENROUTER_API_KEY: KEY_ENV }, loadOpenRouterTenantKey)
      assert.equal((await registry('openrouter', TENANT_A))?.apiKey, KEY_A)
      assert.equal((await registry('openrouter', TENANT_B))?.apiKey, KEY_B)
    })
  })

  await check('audit action regisztrálva, kulcs nélkül', () => {
    assert.doesNotThrow(() => assertAuditActionRegistered('model.openrouter_key.set'))
  })

  await check('csak admin menthet; a mentés nem viszi a kulcsot auditba', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/app/actions/model-config.ts'), 'utf8')
    const start = src.indexOf('export async function setOpenRouterApiKey')
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
