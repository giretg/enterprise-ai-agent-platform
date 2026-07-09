/**
 * agent-memory-persistent-cross-conversation-spec.md §3.2/§16 S3 — capture-idő
 * content-guard: secret/kulcs → hard-block (kategória-címke), lágy PII → warn.
 *
 * Futtatás: npm run test:memory-content-guard
 */
import assert from 'node:assert/strict'
import { scanMemoryContentForSecrets } from '../src/domain/memory/memory-content-guard'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function run() {
  await test('tiszta szöveg → nincs találat', () => {
    const r = scanMemoryContentForSecrets(['A projekt következő lépése a Prisma modell.', null, undefined])
    assert.deepEqual(r.secrets, [])
    assert.deepEqual(r.softPii, [])
  })

  await test('privát kulcs blokk → hard-block találat', () => {
    const r = scanMemoryContentForSecrets(['-----BEGIN RSA PRIVATE KEY-----\nMIIE...'])
    assert.ok(r.secrets.includes('private_key_block'))
  })

  await test('AWS access key id → hard-block', () => {
    const r = scanMemoryContentForSecrets(['a kulcs: AKIAIOSFODNN7EXAMPLE vége'])
    assert.ok(r.secrets.includes('aws_access_key_id'))
  })

  await test('Stripe secret key → hard-block', () => {
    const r = scanMemoryContentForSecrets(['sk_live_0123456789abcdefABCDEF'])
    assert.ok(r.secrets.includes('stripe_secret_key'))
  })

  await test('GitHub token → hard-block', () => {
    const r = scanMemoryContentForSecrets(['ghp_0123456789012345678901234567890123AB'])
    assert.ok(r.secrets.includes('github_token'))
  })

  await test('e-mail cím → lágy PII warn, NEM block', () => {
    const r = scanMemoryContentForSecrets(['kontakt: janos.kovacs@example.com'])
    assert.deepEqual(r.secrets, [])
    assert.ok(r.softPii.includes('email'))
  })

  await test('a modul-szintű regex újrahasználat állapotmentes (kétszeri hívás egyezik)', () => {
    const input = ['AKIAIOSFODNN7EXAMPLE']
    const a = scanMemoryContentForSecrets(input)
    const b = scanMemoryContentForSecrets(input)
    assert.deepEqual(a, b)
  })

  console.log(failures === 0 ? '\n✅ memory-content-guard: mind zöld' : `\n❌ ${failures} bukás`)
  if (failures > 0) process.exit(1)
}

void run()
