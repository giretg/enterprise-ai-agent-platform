/**
 * Platform MODEL_GATEWAY_JWT_KEY (#805): titoktár + env fallback.
 * Futtatás: npm run test:model-gateway-jwt-key
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import {
  forgetModelGatewayJwtKeyCache,
  generateModelGatewayJwtKey,
  loadModelGatewayJwtKeyFromStore,
  MODEL_GATEWAY_JWT_SECRET_ID,
  parseModelGatewayJwtKey,
  resolveModelGatewayJwtKey,
  saveModelGatewayJwtKey,
} from '../src/lib/model-gateway-jwt-key'

const KEY_STORE = 's'.repeat(32)
const KEY_ENV = 'e'.repeat(32)
const KEY_SHORT = 'too-short-for-jwt-hmac'

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
  const dir = await mkdtemp(join(tmpdir(), 'gateway-jwt-'))
  const previousDir = process.env.CONNECTOR_SECRET_DIR
  const previousPrefix = process.env.CONNECTOR_SECRET_PREFIX
  process.env.CONNECTOR_SECRET_DIR = dir
  delete process.env.CONNECTOR_SECRET_PREFIX
  forgetModelGatewayJwtKeyCache()
  try {
    await fn()
  } finally {
    forgetModelGatewayJwtKeyCache()
    if (previousDir === undefined) delete process.env.CONNECTOR_SECRET_DIR
    else process.env.CONNECTOR_SECRET_DIR = previousDir
    if (previousPrefix === undefined) delete process.env.CONNECTOR_SECRET_PREFIX
    else process.env.CONNECTOR_SECRET_PREFIX = previousPrefix
    await rm(dir, { recursive: true, force: true })
  }
}

async function main() {
  await check('a secret id platform-szintű, nem tenantos', () => {
    assert.equal(MODEL_GATEWAY_JWT_SECRET_ID, 'model-gateway-jwt')
    assert.doesNotMatch(MODEL_GATEWAY_JWT_SECRET_ID, /tenant/)
  })

  await check('legalább 32 karakter; rövidebb elutasítva', () => {
    assert.equal(parseModelGatewayJwtKey(`  ${KEY_STORE}  `), KEY_STORE)
    assert.throws(() => parseModelGatewayJwtKey(KEY_SHORT), /invalid_jwt_key/)
    assert.throws(() => parseModelGatewayJwtKey(''), /invalid_jwt_key/)
  })

  await check('generált kulcs elég hosszú és nem ismétlődik', () => {
    const a = generateModelGatewayJwtKey()
    const b = generateModelGatewayJwtKey()
    assert.ok(a.length >= 32)
    assert.ok(b.length >= 32)
    assert.notEqual(a, b)
  })

  await check('titoktár nyer az env fölött', async () => {
    const key = await resolveModelGatewayJwtKey({ MODEL_GATEWAY_JWT_KEY: KEY_ENV }, async () => KEY_STORE)
    assert.equal(key, KEY_STORE)
  })

  await check('hiányzó titok + env → env', async () => {
    const key = await resolveModelGatewayJwtKey({ MODEL_GATEWAY_JWT_KEY: KEY_ENV }, async () => null)
    assert.equal(key, KEY_ENV)
  })

  await check('mindkettő hiányzik / rövid env → nincs kulcs', async () => {
    assert.equal(await resolveModelGatewayJwtKey({}, async () => null), null)
    assert.equal(
      await resolveModelGatewayJwtKey({ MODEL_GATEWAY_JWT_KEY: KEY_SHORT }, async () => null),
      null,
    )
  })

  await check('dev titoktár: mentés után a resolve a tárolt kulcsot adja, env nélkül is', async () => {
    await withSecretDir(async () => {
      assert.equal(await loadModelGatewayJwtKeyFromStore(), null)
      await saveModelGatewayJwtKey(KEY_STORE)
      assert.equal(await loadModelGatewayJwtKeyFromStore(), KEY_STORE)
      assert.equal(await resolveModelGatewayJwtKey({}), KEY_STORE)
    })
  })

  await check('audit action regisztrálva', () => {
    assert.doesNotThrow(() => assertAuditActionRegistered('model.gateway_jwt_key.set'))
  })

  if (failures) {
    console.error(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nminden teszt ok')
}

void main()
