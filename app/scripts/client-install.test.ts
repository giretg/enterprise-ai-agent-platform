/**
 * Client Policy heartbeat-regiszter + Managed/Open kapu (#774) — DB-mentes tesztek (memóriabeli store).
 * Futtatás: npm run test:client-install
 */
import assert from 'node:assert/strict'
import {
  CLIENT_OPEN_MESSAGE,
  clientPolicyTimingFromEnv,
  createManagedGate,
  heartbeatBodySchema,
  recordHeartbeat,
  type ClientInstallStore,
  type ClientPolicyDeps,
} from '../src/domain/client-policy/client-install'
import { handleChatCompletion, type ModelGatewayDeps } from '../src/domain/model-gateway/proxy'
import type { AuditAppendInput } from '../src/lib/audit/types'

const TENANT = '22222222-2222-4222-8222-222222222222'
const OTHER_TENANT = '44444444-4444-4444-8444-444444444444'
const USER = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = '55555555-5555-4555-8555-555555555555'
const AGENT = '33333333-3333-4333-8333-333333333333'
const OTHER_AGENT = '66666666-6666-4666-8666-666666666666'
let failures = 0

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${(e as Error).message}`)
  }
}

/** A Postgres-repo kulcs-szemantikáját követi: (tenant, user, installId) install; (install, session, agent) session. */
function memoryStore(): ClientInstallStore {
  const installs = new Map<string, { at: Date; sessions: Map<string, Date> }>()
  const k = (i: { tenantId: string; userId: string; installId: string }) => `${i.tenantId}|${i.userId}|${i.installId}`
  return {
    async recordHeartbeat(i) {
      const prev = installs.get(k(i))
      const previousHeartbeatAt = prev?.at ?? null
      const row = prev ?? { at: i.now, sessions: new Map() }
      row.at = i.now
      for (const s of i.sessions) row.sessions.set(`${s}|${i.agentId}`, i.now)
      for (const [key, seen] of row.sessions) if (seen < i.sessionsOlderThan) row.sessions.delete(key)
      installs.set(k(i), row)
      return { previousHeartbeatAt }
    },
    async findInstall(i) {
      const row = installs.get(k(i))
      if (!row) return null
      return { lastHeartbeatAt: row.at, sessionLastSeenAt: i.sessionId ? (row.sessions.get(`${i.sessionId}|${i.agentId}`) ?? null) : null }
    },
  }
}

const body = (sessions: string[] = ['sess-1']) =>
  heartbeatBodySchema.parse({ configHash: 'cfg', managedDirHash: 'dir', policyVersion: 'pv1', guardVersion: '0.1', hermesVersion: '1.0', sessions })

function setup(opts: {
  expectedManagedDirHash?: string
  lookupExpectedManagedDirHash?: ClientPolicyDeps['lookupExpectedManagedDirHash']
} = {}) {
  let clock = new Date('2026-10-01T10:00:00Z')
  const audits: AuditAppendInput[] = []
  const deps: ClientPolicyDeps = {
    store: memoryStore(),
    audit: { append: async (a) => void audits.push(a) },
    timing: { intervalSeconds: 60, freshnessSeconds: 180 },
    expectedManagedDirHash: opts.expectedManagedDirHash,
    lookupExpectedManagedDirHash: opts.lookupExpectedManagedDirHash,
    now: () => clock,
  }
  const beat = (o: { tenantId?: string; userId?: string; installId?: string; agentId?: string; sessions?: string[] } = {}) =>
    recordHeartbeat(deps, { tenantId: TENANT, userId: USER, installId: 'inst', agentId: AGENT, ...o, body: body(o.sessions) })
  const gate = createManagedGate(deps)
  const ask = (o: { tenantId?: string; userId?: string; installId?: string; agentId?: string; sessionId?: string | null } = {}) =>
    gate({ tenantId: TENANT, tenantSlug: 'acme', userId: USER, agentId: AGENT, installId: 'inst', policyVersion: 'pv1', sessionId: 'sess-1', turnId: null, stream: false, ...o })
  return { beat, ask, gate, audits, advance: (s: number) => void (clock = new Date(clock.getTime() + s * 1000)) }
}

async function main() {
  console.log('Client Policy (#774)')

  await check('friss heartbeat + regisztrált session → Managed', async () => {
    const t = setup()
    await t.beat()
    assert.equal(await t.ask(), null)
    assert.equal(t.audits.length, 0)
  })

  await check('nincs heartbeat (safe-mode) → Open, érthető üzenet + eltérés-jel', async () => {
    const t = setup()
    const r = await t.ask()
    assert.equal(r?.block, CLIENT_OPEN_MESSAGE)
    assert.equal(r?.reason, 'client_open:no_heartbeat')
    assert.equal(t.audits[0].action, 'client_policy.deviation')
    assert.equal((t.audits[0].metadata as { kind: string }).kind, 'no_heartbeat')
  })

  await check('lejárt heartbeat → Open; újabb heartbeat után újra Managed', async () => {
    const t = setup()
    await t.beat()
    t.advance(179)
    assert.equal(await t.ask(), null)
    t.advance(2)
    assert.equal((await t.ask())?.reason, 'client_open:stale_heartbeat')
    await t.beat()
    assert.equal(await t.ask(), null)
  })

  await check('ismeretlen session → Open (friss heartbeat mellett is)', async () => {
    const t = setup()
    await t.beat()
    assert.equal((await t.ask({ sessionId: 'sess-ismeretlen' }))?.reason, 'client_open:session_unregistered')
    assert.equal((await t.ask({ sessionId: null }))?.reason, 'client_open:session_unregistered')
  })

  await check('a session csak a regisztráló agenthez érvényes', async () => {
    const t = setup()
    await t.beat()
    assert.equal((await t.ask({ agentId: OTHER_AGENT }))?.reason, 'client_open:session_unregistered')
  })

  await check('idegen tenant / idegen user installId-ja → Open', async () => {
    const t = setup()
    await t.beat()
    assert.equal((await t.ask({ tenantId: OTHER_TENANT }))?.reason, 'client_open:no_heartbeat')
    assert.equal((await t.ask({ userId: OTHER_USER }))?.reason, 'client_open:no_heartbeat')
    assert.equal((await t.ask({ installId: 'masik-gep' }))?.reason, 'client_open:no_heartbeat')
  })

  await check('a session külön frissül: a heartbeatből kimaradt session lejár, a friss marad', async () => {
    const t = setup()
    await t.beat({ sessions: ['sess-1'] })
    t.advance(120)
    await t.beat({ sessions: ['sess-2'] })
    t.advance(100) // sess-1 220 s-e nem látott, sess-2 100 s
    assert.equal((await t.ask({ sessionId: 'sess-1' }))?.reason, 'client_open:session_stale')
    assert.equal(await t.ask({ sessionId: 'sess-2' }), null)
  })

  await check('elmaradt heartbeat → heartbeat_gap jel a következő heartbeatnél', async () => {
    const t = setup()
    await t.beat()
    t.advance(60)
    await t.beat()
    assert.equal(t.audits.length, 0)
    t.advance(600)
    await t.beat()
    assert.equal((t.audits[0].metadata as { kind: string; gapSeconds: number }).kind, 'heartbeat_gap')
    assert.equal((t.audits[0].metadata as { gapSeconds: number }).gapSeconds, 600)
  })

  await check('managedDirHash eltérés a várttól → jel; egyezés vagy nincs várt hash → nincs', async () => {
    const mismatch = setup({ expectedManagedDirHash: 'mas' })
    await mismatch.beat()
    assert.equal((mismatch.audits[0].metadata as { kind: string }).kind, 'managed_dir_hash_mismatch')
    const ok = setup({ expectedManagedDirHash: 'dir' })
    await ok.beat()
    assert.equal(ok.audits.length, 0)
    const none = setup()
    await none.beat()
    assert.equal(none.audits.length, 0)
    const saved = setup({
      expectedManagedDirHash: 'dir',
      lookupExpectedManagedDirHash: async () => 'mentett',
    })
    await saved.beat()
    assert.equal((saved.audits[0].metadata as { kind: string }).kind, 'managed_dir_hash_mismatch')
  })

  await check('törzs-validáció: hiányzó hash / túl sok session elutasítva, session alapból üres', async () => {
    assert.equal(heartbeatBodySchema.safeParse({ configHash: 'x' }).success, false)
    assert.equal(heartbeatBodySchema.safeParse({ ...body(), sessions: Array(51).fill('s') }).success, false)
    const { sessions: _omit, ...noSessions } = body()
    assert.deepEqual(heartbeatBodySchema.parse(noSessions).sessions, [])
  })

  await check('időzítés env-ből; az ablak legalább két intervallum', async () => {
    assert.deepEqual(clientPolicyTimingFromEnv({}), { intervalSeconds: 60, freshnessSeconds: 180 })
    assert.deepEqual(clientPolicyTimingFromEnv({ CLIENT_POLICY_HEARTBEAT_INTERVAL_SECONDS: '100', CLIENT_POLICY_FRESHNESS_SECONDS: '120' }), { intervalSeconds: 100, freshnessSeconds: 200 })
    assert.deepEqual(clientPolicyTimingFromEnv({ CLIENT_POLICY_FRESHNESS_SECONDS: 'x' }), { intervalSeconds: 60, freshnessSeconds: 180 })
  })

  // A kapu a Model Gateway-en: Open kérésre nem megy provider-hívás, a Hermes 200-as szintetikus üzenetet kap.
  await check('Model Gateway: Open → szintetikus üzenet (stream és nem-stream), provider nem hívódik; Managed → átmegy', async () => {
    const t = setup()
    let providerCalls = 0
    const gwDeps: ModelGatewayDeps = {
      verify: async () =>
        ({
          ok: true,
          claims: { sub: USER, tenant: 'acme', agentId: AGENT, installId: 'inst', policyVersion: 'pv1', jti: 'j', iat: 0, exp: 9e9 },
          principal: { userId: USER, tenantId: TENANT, tenantSlug: 'acme', role: 'operator', assumed: false },
        }) as never,
      loadAgentModelConfig: async () => ({ provider: 'openrouter', model: 'v/m' }),
      getTenantPolicy: async () => ({ enabled: [{ provider: 'openrouter', model: 'v/m' }] }),
      getGlobalFallbackChain: async () => [],
      getAllowedModels: async () => null,
      providers: () => ({ baseUrl: 'https://or.test/v1', apiKey: 'k' }),
      audit: { record: async () => {} },
      hooks: { gate: t.gate },
      fetchImpl: (async () => {
        providerCalls++
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'szia' }, finish_reason: 'stop' }] }), { status: 200 })
      }) as never,
    }
    const call = (stream: boolean) =>
      handleChatCompletion(gwDeps, new Request('https://app.test/x', {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'x-excellence-session': 'sess-1' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream }),
      }))
    const open = await call(false)
    assert.equal(open.status, 200)
    assert.equal(((await open.json()) as { choices: [{ message: { content: string } }] }).choices[0].message.content, CLIENT_OPEN_MESSAGE)
    assert.ok((await (await call(true)).text()).includes('nem céges módban'))
    assert.equal(providerCalls, 0)

    await t.beat()
    const managed = await call(false)
    assert.equal(((await managed.json()) as { choices: [{ message: { content: string } }] }).choices[0].message.content, 'szia')
    assert.equal(providerCalls, 1)
  })

  if (failures) {
    console.error(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nminden teszt zöld')
}

void main()
