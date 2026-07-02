/**
 * egress-guard — determinisztikus SSRF/allowlist őr tesztek
 * (Feature-spec — WebFetch-Egress §3.1 „A" réteg, §7.1). DB nélkül, fakes-szel.
 *
 * A meglévő tesztmintát követi (web-search-tool.test.ts): saját mini-runner + node assert.
 */
import assert from 'node:assert/strict'
import {
  guardEgressUrl,
  isForbiddenHost,
  isPrivateOrReservedIp,
  matchForbiddenHost,
} from '../src/domain/net/egress-guard'

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

const ALLOW = ['docs.stripe.com', 'developers.google.com']

async function main() {
  console.log('\n=== SSRF host-minták ===')
  await test('EG-1 raw IPv4 host → forbidden', () => {
    assert.equal(matchForbiddenHost('10.0.0.5'), 'raw_ip_host')
    assert.equal(isForbiddenHost('192.168.1.1'), true)
  })

  await test('EG-2 localhost / metadata / exfil sink → forbidden', () => {
    assert.equal(matchForbiddenHost('localhost'), 'localhost_host')
    assert.equal(matchForbiddenHost('metadata.google.internal'), 'metadata_host')
    // A metadata IP nyers IPv4-ként is tiltott (raw_ip_host mintát üt előbb) — a lényeg, hogy blokkolt.
    assert.equal(isForbiddenHost('169.254.169.254'), true)
    assert.equal(matchForbiddenHost('evil.webhook.site'), 'known_exfil_sink')
  })

  await test('EG-3 normal doc host is not forbidden', () => {
    assert.equal(matchForbiddenHost('docs.stripe.com'), null)
  })

  console.log('\n=== Privát/reserved IP tartományok ===')
  await test('EG-4 private/reserved IPv4 ranges', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '127.0.0.1', '169.254.1.1', '0.0.0.0', '100.64.0.1']) {
      assert.equal(isPrivateOrReservedIp(ip), true, `${ip} should be private/reserved`)
    }
  })

  await test('EG-5 public IPv4 is allowed', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1']) {
      assert.equal(isPrivateOrReservedIp(ip), false, `${ip} should be public`)
    }
  })

  await test('EG-6 IPv6 loopback/ULA/link-local + mapped IPv4', () => {
    assert.equal(isPrivateOrReservedIp('::1'), true)
    assert.equal(isPrivateOrReservedIp('fc00::1'), true)
    assert.equal(isPrivateOrReservedIp('fe80::1'), true)
    assert.equal(isPrivateOrReservedIp('::ffff:169.254.169.254'), true)
    assert.equal(isPrivateOrReservedIp('2606:4700:4700::1111'), false)
  })

  console.log('\n=== guardEgressUrl teljes lánc ===')
  await test('EG-7 https + allowlisted host → ok', async () => {
    const r = await guardEgressUrl({ url: 'https://docs.stripe.com/api', allowlistHosts: ALLOW })
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.host, 'docs.stripe.com')
  })

  await test('EG-8 non-https scheme → scheme_blocked', async () => {
    for (const url of ['http://docs.stripe.com', 'file:///etc/passwd', 'data:text/html,x', 'ftp://docs.stripe.com']) {
      const r = await guardEgressUrl({ url, allowlistHosts: ALLOW })
      assert.equal(r.ok, false)
      assert.equal(!r.ok && r.reason, 'scheme_blocked')
    }
  })

  await test('EG-9 SSRF host wins over allowlist → ssrf_blocked', async () => {
    for (const url of ['https://169.254.169.254/latest/meta-data', 'https://10.0.0.1/x', 'https://localhost/x']) {
      const r = await guardEgressUrl({ url, allowlistHosts: ['169.254.169.254', '10.0.0.1', 'localhost'] })
      assert.equal(r.ok, false)
      assert.equal(!r.ok && r.reason, 'ssrf_blocked')
    }
  })

  await test('EG-10 host not on allowlist → egress_not_allowlisted', async () => {
    const r = await guardEgressUrl({ url: 'https://random-blog.example/x', allowlistHosts: ALLOW })
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.reason, 'egress_not_allowlisted')
  })

  await test('EG-11 DNS-rebinding: allowlisted host → private IP → ssrf_blocked', async () => {
    const r = await guardEgressUrl({
      url: 'https://docs.stripe.com/api',
      allowlistHosts: ALLOW,
      resolveHostIps: async () => ['169.254.169.254'],
    })
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.reason, 'ssrf_blocked')
    assert.equal(!r.ok && r.detail, 'resolved_private_ip')
  })

  await test('EG-12 DNS resolve to public IP → ok', async () => {
    const r = await guardEgressUrl({
      url: 'https://docs.stripe.com/api',
      allowlistHosts: ALLOW,
      resolveHostIps: async () => ['151.101.0.1'],
    })
    assert.equal(r.ok, true)
  })

  await test('EG-13 invalid url → invalid_url', async () => {
    const r = await guardEgressUrl({ url: 'not a url', allowlistHosts: ALLOW })
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.reason, 'invalid_url')
  })

  if (failures > 0) {
    console.error(`\n${failures} egress-guard teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden egress-guard teszt zöld.')
}

main()
