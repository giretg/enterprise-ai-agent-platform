/**
 * Worker-hitelesítés: a platform chat-tokenjének formátuma, audience-szétválasztás, Google OIDC.
 * Futtatás: npx tsx test/auth.test.ts
 */
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { verifyChatToken, verifyGoogleOidc } from '../src/auth.ts'

const SECRET = 's'.repeat(40)
const now = Math.floor(Date.now() / 1000)
let failures = 0

function check(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  OK  ${name}`),
      (e) => {
        failures++
        console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack : e}`)
      },
    )
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
/** Ugyanaz a formátum, mint a platform `signChatToken`-je (HS256, base64url JSON). */
function hs256(claims: Record<string, unknown>, secret = SECRET, alg = 'HS256') {
  const head = b64({ alg, typ: 'JWT' })
  const body = b64(claims)
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`
}
const base = { sub: 'u1', tenant: 'acme', tid: 't1', role: 'operator', adminInsight: false, jti: 'j', iat: now, exp: now + 600 }

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' }
function rs256(claims: Record<string, unknown>, kid = 'k1') {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' })
  const body = b64(claims)
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
}
const oidc = { iss: 'https://accounts.google.com', aud: 'https://worker.run.app', email: 'tasks@p.iam.gserviceaccount.com', email_verified: true, exp: now + 300 }
const expected = { audience: 'https://worker.run.app', email: 'tasks@p.iam.gserviceaccount.com' }

async function main() {
  await check('chat-token: érvényes böngésző-token elfogadva', () => {
    assert.equal(verifyChatToken(hs256({ ...base, aud: 'platform-chat' }), SECRET)?.tid, 't1')
  })
  await check('chat-token: a folytatási token a böngésző-API-n elutasítva', () => {
    assert.equal(verifyChatToken(hs256({ ...base, aud: 'platform-chat-turn', turnId: 'x', agentId: 'y' }), SECRET), null)
  })
  await check('chat-token: lejárt / rossz titok / alg=none → elutasítva', () => {
    assert.equal(verifyChatToken(hs256({ ...base, aud: 'platform-chat', exp: now - 1 }), SECRET), null)
    assert.equal(verifyChatToken(hs256({ ...base, aud: 'platform-chat' }, 'x'.repeat(40)), SECRET), null)
    assert.equal(verifyChatToken(hs256({ ...base, aud: 'platform-chat' }, SECRET, 'none'), SECRET), null)
  })
  await check('OIDC: érvényes Cloud Tasks token', async () => {
    assert.equal(await verifyGoogleOidc(rs256(oidc), expected, { keys: [jwk] }), true)
  })
  await check('OIDC: más audience / más service account / ismeretlen kulcs / lejárt → elutasítva', async () => {
    assert.equal(await verifyGoogleOidc(rs256({ ...oidc, aud: 'https://evil' }), expected, { keys: [jwk] }), false)
    assert.equal(await verifyGoogleOidc(rs256({ ...oidc, email: 'x@y' }), expected, { keys: [jwk] }), false)
    assert.equal(await verifyGoogleOidc(rs256(oidc, 'k2'), expected, { keys: [jwk] }), false)
    assert.equal(await verifyGoogleOidc(rs256({ ...oidc, exp: now - 1 }), expected, { keys: [jwk] }), false)
  })
  if (failures) process.exit(1)
  console.log('\nplatform-chat auth: all passed')
}

void main()
