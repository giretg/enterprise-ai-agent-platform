/**
 * Egress-allowlist futásidejű bővítés (EA-*) — a PlatformSettingsService
 * extendEgressAllowlist / getEgressAllowlist tesztjei (Feature-spec — WebFetch-Egress
 * §9, §11.1, §12.2). Fakes-szel, DB nélkül.
 *
 * A `connector.egress_allowlist.extend` KÜLÖN, auditált admin-aktus: SSRF-tiltott hostot
 * nem enged hozzáadni (defense-in-depth), idempotens, tenant-bucketelt, és a `__global__`
 * bucket tenant-független. A tényleges enforcement a validátoré/fetch-őré marad.
 */
import assert from 'node:assert/strict'
import { PlatformSettingsService } from '../src/domain/platform-settings/platform-settings-service'
import type { AuditRepository, PlatformSettingsRepository } from '../src/repositories/interfaces'

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

type AuditRow = { action: string; actorType: string; actorId: string; metadata: unknown }

function makeService() {
  const store = new Map<string, unknown>()
  const audits: AuditRow[] = []
  const settings: Pick<PlatformSettingsRepository, 'get' | 'set'> = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value)
    },
  }
  const audit: Pick<AuditRepository, 'append'> = {
    append: async (data) => {
      audits.push({
        action: data.action,
        actorType: data.actorType as string,
        actorId: data.actorId as string,
        metadata: data.metadata,
      })
      return data as never
    },
  }
  const svc = new PlatformSettingsService(
    settings as PlatformSettingsRepository,
    audit as AuditRepository,
  )
  return { svc, audits }
}

async function main() {
  console.log('=== Egress-allowlist bővítés ===')

  await test('EA-1 új host hozzáadása → added, olvasható, auditált (actor=human)', async () => {
    const { svc, audits } = makeService()
    const res = await svc.extendEgressAllowlist('tenant-a', 'API.Example.COM', 'admin-1', {
      sourceType: 'official',
      draftId: 'draft-9',
    })
    assert.equal(res.ok, true)
    assert.equal(res.ok && res.added, true)
    assert.equal(res.ok && res.host, 'api.example.com') // normalizált (kisbetűs)
    const hosts = await svc.getEgressAllowlist('tenant-a')
    assert.deepEqual(hosts, ['api.example.com'])
    assert.equal(audits.length, 1)
    assert.equal(audits[0].action, 'connector.egress_allowlist.extend')
    assert.equal(audits[0].actorType, 'human')
    assert.equal(audits[0].actorId, 'admin-1')
  })

  await test('EA-2 idempotens: ugyanaz a host mégegyszer → added:false, nincs új audit', async () => {
    const { svc, audits } = makeService()
    await svc.extendEgressAllowlist('tenant-a', 'api.example.com', 'admin-1')
    const again = await svc.extendEgressAllowlist('tenant-a', 'api.example.com', 'admin-1')
    assert.equal(again.ok && again.added, false)
    assert.equal(audits.length, 1) // csak az első bővítés auditált
  })

  await test('EA-3 URL-t is elfogad, hostname-re normalizál (port/path levágva)', async () => {
    const { svc } = makeService()
    const res = await svc.extendEgressAllowlist('t', 'https://docs.example.com:443/v1/spec', 'a')
    assert.equal(res.ok && res.host, 'docs.example.com')
  })

  await test('EA-4 SSRF-tiltott host elutasítva (localhost/metadata/nyers IP/exfil-sink)', async () => {
    const { svc, audits } = makeService()
    for (const bad of ['localhost', '169.254.169.254', '10.0.0.5', 'webhook.site']) {
      const res = await svc.extendEgressAllowlist('t', bad, 'a')
      assert.equal(res.ok, false, `${bad} nem lehet ok`)
      assert.equal(!res.ok && res.reason, 'forbidden_host', `${bad} → forbidden_host`)
    }
    assert.equal(audits.length, 0) // tiltott host SOHA nem auditálódik extend-ként
    assert.deepEqual(await svc.getEgressAllowlist('t'), [])
  })

  await test('EA-5 érvénytelen host → invalid_host', async () => {
    const { svc } = makeService()
    for (const bad of ['   ', 'has space.com', 'http://', '..']) {
      const res = await svc.extendEgressAllowlist('t', bad, 'a')
      assert.equal(res.ok, false, `${bad} nem lehet ok`)
      assert.equal(!res.ok && res.reason, 'invalid_host', `${bad} → invalid_host`)
    }
  })

  await test('EA-6 tenant-izoláció + __global__ merge', async () => {
    const { svc } = makeService()
    await svc.extendEgressAllowlist('tenant-a', 'a-only.example.com', 'admin')
    await svc.extendEgressAllowlist('tenant-b', 'b-only.example.com', 'admin')
    await svc.extendEgressAllowlist(null, 'global.example.com', 'admin') // null tenant → __global__

    const a = await svc.getEgressAllowlist('tenant-a')
    assert.ok(a.includes('a-only.example.com'))
    assert.ok(a.includes('global.example.com')) // a global mindenkinek látszik
    assert.ok(!a.includes('b-only.example.com')) // más tenant hostja NEM

    const b = await svc.getEgressAllowlist('tenant-b')
    assert.ok(b.includes('b-only.example.com'))
    assert.ok(b.includes('global.example.com'))
    assert.ok(!b.includes('a-only.example.com'))
  })

  await test('EA-7 üres tár → üres lista (nincs korábbi setting)', async () => {
    const { svc } = makeService()
    assert.deepEqual(await svc.getEgressAllowlist('tenant-x'), [])
    assert.deepEqual(await svc.getEgressAllowlist(null), [])
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt BUKOTT.`)
    process.exit(1)
  }
  console.log('\nMinden egress-allowlist-extend teszt zöld.')
}

void main()
