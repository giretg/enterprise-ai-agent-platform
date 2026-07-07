/**
 * secret-config — determinisztikus fail-closed titok-feloldó tesztek.
 *
 * A meglévő tesztmintát követi (egress-guard.test.ts): saját mini-runner + node assert,
 * DB nélkül. A cél annak igazolása, hogy éles környezetben (NODE_ENV=production) a
 * platform SOHA nem esik vissza beégetett fejlesztői kulcsra, fejlesztésben viszont a
 * determinisztikus dev-default marad, és a valós, konfigurált titok mindig érvényesül.
 */
import assert from 'node:assert/strict'
import { resolveSigningSecret, isProductionRuntime } from '../src/lib/crypto/secret-config'
import { signWriteGateToken, verifyWriteGateSignature } from '../src/lib/crypto/hash-chain'

let failures = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`)
  }
}

/** Env-változók biztonságos beállítása/visszaállítása egy teszt idejére. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k]
    if (overrides[k] === undefined) delete process.env[k]
    else process.env[k] = overrides[k]
  }
  try {
    fn()
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

const DEV_DEFAULT = 'dev-test-secret-change-in-prod'

async function main() {
  console.log('\n=== resolveSigningSecret ===')

  await test('SC-1 nem-production + hiányzó titok → dev-default', () => {
    withEnv({ NODE_ENV: 'development', SC_TEST_SECRET: undefined }, () => {
      assert.equal(resolveSigningSecret(['SC_TEST_SECRET'], DEV_DEFAULT), DEV_DEFAULT)
    })
  })

  await test('SC-2 valós, konfigurált titok → azt adja vissza (dev-ben is)', () => {
    withEnv({ NODE_ENV: 'development', SC_TEST_SECRET: 'a-real-strong-secret' }, () => {
      assert.equal(resolveSigningSecret(['SC_TEST_SECRET'], DEV_DEFAULT), 'a-real-strong-secret')
    })
  })

  await test('SC-3 production + hiányzó titok → FAIL CLOSED (dob)', () => {
    withEnv({ NODE_ENV: 'production', SC_TEST_SECRET: undefined }, () => {
      assert.equal(isProductionRuntime(), true)
      assert.throws(() => resolveSigningSecret(['SC_TEST_SECRET'], DEV_DEFAULT), /Nincs beállítva valós titok/)
    })
  })

  await test('SC-4 production + valós titok → átmegy (nincs dob)', () => {
    withEnv({ NODE_ENV: 'production', SC_TEST_SECRET: 'prod-grade-secret-value' }, () => {
      assert.equal(resolveSigningSecret(['SC_TEST_SECRET'], DEV_DEFAULT), 'prod-grade-secret-value')
    })
  })

  await test('SC-5 production + placeholder-marker érték is fail-closed', () => {
    withEnv({ NODE_ENV: 'production', SC_TEST_SECRET: 'still-change-in-prod' }, () => {
      assert.throws(() => resolveSigningSecret(['SC_TEST_SECRET'], DEV_DEFAULT), /Nincs beállítva valós titok/)
    })
  })

  await test('SC-6 alternatív (fallback) env-változó feloldása prioritás szerint', () => {
    withEnv({ NODE_ENV: 'production', SC_PRIMARY: undefined, SC_FALLBACK: 'fallback-secret' }, () => {
      assert.equal(resolveSigningSecret(['SC_PRIMARY', 'SC_FALLBACK'], DEV_DEFAULT), 'fallback-secret')
    })
  })

  await test('SC-7 elsődleges env nyer az alternatíva felett', () => {
    withEnv({ NODE_ENV: 'production', SC_PRIMARY: 'primary-secret', SC_FALLBACK: 'fallback-secret' }, () => {
      assert.equal(resolveSigningSecret(['SC_PRIMARY', 'SC_FALLBACK'], DEV_DEFAULT), 'primary-secret')
    })
  })

  console.log('\n=== integráció: write-gate token aláírás lusta feloldással ===')

  await test('SC-8 dev-ben a write-gate aláírás/verifikáció kerek', () => {
    withEnv({ NODE_ENV: 'development', WRITE_GATE_SECRET: undefined }, () => {
      const params = {
        tokenHash: 'a'.repeat(64),
        expectedDiffHash: 'b'.repeat(64),
        ticketId: 'ticket-1',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      }
      const sig = signWriteGateToken(params)
      assert.equal(verifyWriteGateSignature({ ...params, signature: sig }), true)
      assert.equal(
        verifyWriteGateSignature({ ...params, signature: 'c'.repeat(sig.length) }),
        false,
      )
    })
  })

  await test('SC-9 production + hiányzó WRITE_GATE_SECRET → az aláírás fail-closed', () => {
    withEnv({ NODE_ENV: 'production', WRITE_GATE_SECRET: undefined }, () => {
      assert.throws(
        () =>
          signWriteGateToken({
            tokenHash: 'a'.repeat(64),
            expectedDiffHash: 'b'.repeat(64),
            ticketId: 'ticket-1',
            expiresAt: new Date('2030-01-01T00:00:00.000Z'),
          }),
        /Nincs beállítva valós titok/,
      )
    })
  })

  if (failures > 0) {
    console.error(`\n${failures} secret-config teszt BUKOTT.`)
    process.exit(1)
  }
  console.log('\nMinden secret-config teszt zöld.')
}

void main()
