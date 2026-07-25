/**
 * Rövid élettartamú titok-cache (TSC-*) — a forró, hitelesítés-ELŐTTI webhook-út
 * költség/DoS-keményítése. DB és hálózat nélkül, tiszta logikai tesztek.
 *
 * A cache SZERZŐDÉSE, amit a tesztek rögzítenek:
 *  - TTL-en belül a második kérés NEM hívja újra a feloldót (nincs Secret Manager-körforduló).
 *  - TTL lejárta után újra feloldunk (egy rotáció legfeljebb TTL-ig késik).
 *  - Az egyidejű cache-miss kérések MEGOSZTJÁK ugyanazt a folyamatban lévő feloldást.
 *  - A HIBÁT SOSEM cache-eljük (fail-closed marad; a következő hívás újrapróbál).
 *
 * Futtatás: npm run test:ttl-secret-cache
 */
import assert from 'node:assert/strict'
import { createTtlSecretCache } from '../src/lib/crypto/ttl-secret-cache'

let passed = 0
let failed = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
    failed += 1
  }
}

async function run() {
  await check('TTL-en belül a második kérés a cache-ből jön (a feloldó egyszer fut)', async () => {
    let calls = 0
    const cache = createTtlSecretCache(async () => `secret-${++calls}`, 60_000)
    const a = await cache('ref-1')
    const b = await cache('ref-1')
    assert.equal(a, 'secret-1')
    assert.equal(b, 'secret-1')
    assert.equal(calls, 1, 'a feloldónak pontosan egyszer kellett futnia')
  })

  await check('TTL lejárta után újra feloldunk (rotáció legfeljebb TTL-ig késik)', async () => {
    let calls = 0
    let clock = 1_000
    const cache = createTtlSecretCache(async () => `secret-${++calls}`, 60_000, () => clock)
    assert.equal(await cache('ref-1'), 'secret-1')
    clock += 59_999 // még a TTL-en belül
    assert.equal(await cache('ref-1'), 'secret-1')
    assert.equal(calls, 1)
    clock += 2 // most már túl a 60 mp-en
    assert.equal(await cache('ref-1'), 'secret-2')
    assert.equal(calls, 2)
  })

  await check('különböző kulcsok külön cache-elődnek', async () => {
    let calls = 0
    const cache = createTtlSecretCache(async (k) => `${k}:${++calls}`, 60_000)
    assert.equal(await cache('a'), 'a:1')
    assert.equal(await cache('b'), 'b:2')
    assert.equal(await cache('a'), 'a:1')
    assert.equal(calls, 2)
  })

  await check('egyidejű cache-miss kérések megosztják ugyanazt a feloldást (nincs thundering herd)', async () => {
    let calls = 0
    const cache = createTtlSecretCache(async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 10))
      return `secret-${calls}`
    }, 60_000)
    const [a, b, c] = await Promise.all([cache('ref-1'), cache('ref-1'), cache('ref-1')])
    assert.equal(a, 'secret-1')
    assert.equal(b, 'secret-1')
    assert.equal(c, 'secret-1')
    assert.equal(calls, 1, 'a párhuzamos miss-eknek egyetlen feloldást kellett osztaniuk')
  })

  await check('a HIBÁT nem cache-eljük — a következő hívás újrapróbál (fail-closed)', async () => {
    let calls = 0
    const cache = createTtlSecretCache(async () => {
      calls += 1
      if (calls === 1) throw new Error('secret manager 429')
      return 'secret-ok'
    }, 60_000)
    await assert.rejects(() => cache('ref-1'), /429/)
    // A hiba nem ragadt be: a következő hívás újra feloldja, és most sikerül.
    assert.equal(await cache('ref-1'), 'secret-ok')
    assert.equal(calls, 2)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run()
