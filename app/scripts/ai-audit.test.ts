/**
 * AI Interaction Audit (#770) — DB nélküli tesztek memória-store-ral.
 * Futtatás: npm run test:ai-audit
 */
import assert from 'node:assert/strict'
import {
  MAX_CONTENT_BYTES,
  MAX_EVENTS_PER_BATCH,
  MAX_META_BYTES,
  createGatewayAuditSink,
  decryptContent,
  encryptContent,
  ingestGuardEvents,
  listAuditEvents,
  normalizeDepth,
  sweepExpiredAiAuditEvents,
  type AiAuditDeps,
  type AiInteractionRow,
  type AiInteractionStore,
  type AuditDepth,
} from '../src/domain/ai-audit/ai-audit-service'
import {
  approveUnlockRequest,
  issueUnlockRequest,
  verifyContentGrant,
} from '../src/domain/ai-audit/content-grant'
import { handleAiAuditRetentionRequest } from '../src/domain/ai-audit/retention-request'
import type { ModelCallEvent } from '../src/domain/model-gateway/proxy'

const TENANT = '22222222-2222-4222-8222-222222222222'
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999'
const USER = '11111111-1111-4111-8111-111111111111'
const AGENT = '33333333-3333-4333-8333-333333333333'
const ctx = { tenantId: TENANT, userId: USER, agentId: AGENT, installId: 'inst-1', policyVersion: 'pv1' }
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

let failures = 0
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
  }
}

function setup(depth: AuditDepth) {
  const rows: AiInteractionRow[] = []
  const store: AiInteractionStore = {
    insertMany: async (batch) => {
      let n = 0
      for (const r of batch) {
        if (rows.some((x) => x.tenantId === r.tenantId && x.id === r.id)) continue
        rows.push(r)
        n++
      }
      return n
    },
    list: async (f) =>
      rows.filter((r) => r.tenantId === f.tenantId && (!f.sessionId || r.sessionId === f.sessionId)).slice(0, f.limit),
    deleteExpired: async (now, limit) => {
      const doomed = rows.filter((r) => r.expiresAt.getTime() <= now.getTime()).slice(0, limit)
      for (const d of doomed) {
        const i = rows.indexOf(d)
        if (i >= 0) rows.splice(i, 1)
      }
      return doomed.length
    },
  }
  const deps: AiAuditDeps = {
    store,
    depthFor: async () => depth,
    now: () => new Date('2026-10-01T10:00:00Z'),
    retentionDays: () => 90,
  }
  return { rows, store, deps }
}

const ev = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n), sessionId: 'sess-1', turnId: 'turn-1', kind: 'user_prompt', content: 'Mennyi a havi díj?', meta: {}, ...over,
})

async function main() {
  await check('ismeretlen audit_depth → metadata (a legkevesebbet tároló)', async () => {
    assert.equal(normalizeDepth('wat'), 'metadata')
    assert.equal(normalizeDepth(undefined), 'metadata')
  })

  await check('titkosítás oda-vissza; a tárolt boríték nem tartalmaz nyílt szöveget; tenantonként más kulcs', async () => {
    const sealed = encryptContent(TENANT, 'titkos prompt')
    assert.ok(!sealed.includes('titkos'))
    assert.equal(decryptContent(TENANT, sealed), 'titkos prompt')
    assert.throws(() => decryptContent(OTHER_TENANT, sealed))
  })

  await check('idempotens ingest: ismételt id nem duplikál', async () => {
    const s = setup('plus_tool_results')
    assert.deepEqual(await ingestGuardEvents(s.deps, ctx, { events: [ev(1), ev(2)] }), { ok: true, received: 2, stored: 2 })
    assert.deepEqual(await ingestGuardEvents(s.deps, ctx, { events: [ev(1), ev(3)] }), { ok: true, received: 2, stored: 1 })
    assert.equal(s.rows.length, 3)
  })

  await check('a payload tenant/user/agent/install/source mezője figyelmen kívül marad (a tokenből jön)', async () => {
    const s = setup('plus_tool_results')
    await ingestGuardEvents(s.deps, ctx, {
      events: [ev(1, { tenantId: OTHER_TENANT, userId: uuid(7), agentId: uuid(8), installId: 'rogue', source: 'gateway', policyVersion: 'x' })],
    })
    const r = s.rows[0]
    assert.equal(r.tenantId, TENANT)
    assert.equal(r.userId, USER)
    assert.equal(r.agentId, AGENT)
    assert.equal(r.installId, 'inst-1')
    assert.equal(r.source, 'guard')
    assert.equal(r.policyVersion, 'pv1')
  })

  await check('a Guard nem küldhet model_call-t (az a gatewayé); hibás payload → 400', async () => {
    const s = setup('plus_tool_results')
    assert.deepEqual(await ingestGuardEvents(s.deps, ctx, { events: [ev(1, { kind: 'model_call' })] }), { ok: false, status: 400, code: 'bad_request' })
    assert.equal((await ingestGuardEvents(s.deps, ctx, { events: [] })).ok, false)
    assert.equal((await ingestGuardEvents(s.deps, ctx, { events: [ev(1, { id: 'nem-uuid' })] })).ok, false)
    assert.equal((await ingestGuardEvents(s.deps, ctx, null)).ok, false)
    assert.equal(s.rows.length, 0)
  })

  await check('méret-kapuk: túl sok esemény, túl nagy tartalom, túl nagy meta → 413, semmi nem íródik', async () => {
    const s = setup('plus_tool_results')
    const many = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) => ev(i + 1))
    assert.deepEqual(await ingestGuardEvents(s.deps, ctx, { events: many }), { ok: false, status: 413, code: 'too_many_events' })
    const big = 'x'.repeat(MAX_CONTENT_BYTES + 1)
    assert.deepEqual(await ingestGuardEvents(s.deps, ctx, { events: [ev(1), ev(2, { content: big })] }), { ok: false, status: 413, code: 'content_too_large' })
    const bigMeta = { k: 'x'.repeat(MAX_META_BYTES) }
    assert.deepEqual(await ingestGuardEvents(s.deps, ctx, { events: [ev(3, { meta: bigMeta })] }), { ok: false, status: 413, code: 'meta_too_large' })
    assert.equal(s.rows.length, 0)
  })

  await check('metaadat-mélység: a content üres az adatbázisban (nem csak elrejtve), a meta megmarad', async () => {
    const s = setup('metadata')
    await ingestGuardEvents(s.deps, ctx, {
      events: [ev(1), ev(2, { kind: 'tool_call', content: { result: 'titok' }, meta: { tool: 'bash', where: 'local' } })],
    })
    assert.ok(s.rows.every((r) => r.content === null))
    assert.deepEqual(s.rows[1].meta, { tool: 'bash', where: 'local' })
  })

  await check('prompt+válasz mélység: a prompt tárolódik, a tool-eredmény nem; plus_tool_results: mindkettő', async () => {
    const a = setup('prompt_and_response')
    await ingestGuardEvents(a.deps, ctx, { events: [ev(1), ev(2, { kind: 'tool_call', content: { result: 'titok' } })] })
    assert.ok(a.rows[0].content)
    assert.equal(a.rows[1].content, null)
    const b = setup('plus_tool_results')
    await ingestGuardEvents(b.deps, ctx, { events: [ev(1, { kind: 'tool_call', content: { result: 'titok' } })] })
    assert.deepEqual(JSON.parse(decryptContent(TENANT, b.rows[0].content!)), { result: 'titok' })
  })

  await check('lejárat: alapból +90 nap', async () => {
    const s = setup('plus_tool_results')
    await ingestGuardEvents(s.deps, ctx, { events: [ev(1)] })
    assert.equal(s.rows[0].expiresAt.toISOString(), '2026-12-30T10:00:00.000Z')
  })

  const modelCall = (over: Partial<ModelCallEvent> = {}): ModelCallEvent => ({
    ...ctx, tenantSlug: 'acme', sessionId: 'sess-1', turnId: 'turn-1', stream: false,
    requestedModel: null, model: 'openrouter/a', substituted: false, failedCandidates: [], outcome: 'ok',
    request: { model: 'a', messages: [{ role: 'user', content: 'szia' }, { role: 'tool', content: 'TOOL-TITOK' }] },
    response: { content: 'válasz', toolCalls: [], finishReason: 'stop' },
    usage: { promptTokens: 7, completionTokens: 3 }, latencyMs: 12, ...over,
  })

  await check('gateway-írás: model_call/gateway; sessionId/turnId összefűzhető a Guard-eseményekkel', async () => {
    const s = setup('plus_tool_results')
    await createGatewayAuditSink(s.deps).record(modelCall())
    await ingestGuardEvents(s.deps, ctx, { events: [ev(1, { kind: 'tool_call', meta: { tool: 'bash', where: 'local' } })] })
    const [gw, guard] = s.rows
    assert.equal(gw.kind, 'model_call')
    assert.equal(gw.source, 'gateway')
    assert.equal(gw.meta.model, 'openrouter/a')
    assert.deepEqual(gw.meta.usage, { promptTokens: 7, completionTokens: 3 })
    assert.equal(gw.meta.policyDecision, 'allowed')
    assert.equal(guard.source, 'guard')
    assert.equal(guard.meta.where, 'local')
    assert.deepEqual([gw.sessionId, gw.turnId], [guard.sessionId, guard.turnId])
    assert.equal((await listAuditEvents(s.store, { tenantId: TENANT, sessionId: 'sess-1', limit: 50 }, { decrypt: false })).length, 2)
  })

  await check('gateway-írás prompt+válasz mélységben: a tool-eredmény kiesik a tárolt kérésből', async () => {
    const s = setup('prompt_and_response')
    await createGatewayAuditSink(s.deps).record(modelCall())
    const stored = decryptContent(TENANT, s.rows[0].content!)
    assert.ok(stored.includes('szia') && stored.includes('válasz'))
    assert.ok(!stored.includes('TOOL-TITOK'))
  })

  await check('gateway-írás metaadat-mélységben: content null; blokk is rekordot kap', async () => {
    const s = setup('metadata')
    const sink = createGatewayAuditSink(s.deps)
    await sink.record(modelCall())
    await sink.record(modelCall({ outcome: 'blocked', blockReason: 'pan', model: null, request: null, response: null }))
    assert.ok(s.rows.every((r) => r.content === null))
    assert.equal(s.rows[1].meta.policyDecision, 'denied')
    assert.equal(s.rows[1].meta.blockReason, 'pan')
  })

  await check('olvasó: alapból nincs content; decrypt=true visszafejt; tenant-szűrés', async () => {
    const s = setup('plus_tool_results')
    await ingestGuardEvents(s.deps, ctx, { events: [ev(1, { content: { q: 'mennyi?' } })] })
    const plain = await listAuditEvents(s.store, { tenantId: TENANT, limit: 10 }, { decrypt: false })
    assert.equal(plain[0].hasContent, true)
    assert.ok(!('content' in plain[0]))
    const clear = await listAuditEvents(s.store, { tenantId: TENANT, limit: 10 }, { decrypt: true })
    assert.deepEqual(clear[0].content, { q: 'mennyi?' })
    assert.equal((await listAuditEvents(s.store, { tenantId: OTHER_TENANT, limit: 10 }, { decrypt: true })).length, 0)
  })

  await check('retenciós sweep: a lejárt sor törlődik, a még élő megmarad; a limit vág', async () => {
    const s = setup('plus_tool_results')
    await ingestGuardEvents(s.deps, ctx, { events: [ev(1), ev(2)] })
    s.rows[0].expiresAt = new Date('2026-09-01T00:00:00Z')
    s.rows[1].expiresAt = new Date('2026-12-30T10:00:00Z')
    const hidden = await listAuditEvents(s.store, { tenantId: TENANT, limit: 10 }, {
      decrypt: false,
      now: new Date('2026-10-01T10:00:00Z'),
    })
    assert.equal(hidden.length, 1)
    assert.equal(s.rows.length, 2)
    assert.deepEqual(await sweepExpiredAiAuditEvents(s.store, { now: new Date('2026-10-01T10:00:00Z'), limit: 10 }), {
      deleted: 1,
    })
    assert.equal(s.rows.length, 1)
    assert.equal(s.rows[0].id, uuid(2))
    const listed = await listAuditEvents(s.store, { tenantId: TENANT, limit: 10 }, {
      decrypt: false,
      now: new Date('2026-10-01T10:00:00Z'),
    })
    assert.equal(listed.length, 1)
  })

  await check('retenciós sweep élő hívó: érvényes tokennel a sweep lefut; hiányzó/hibás tokennél el sem indul', async () => {
    const TOKEN = 'sweep-token-abc123'
    let calls = 0
    const ok = await handleAiAuditRetentionRequest(
      { providedToken: TOKEN, expectedToken: TOKEN },
      async () => {
        calls += 1
        return { deleted: 4 }
      },
    )
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { ok: true, deleted: 4 })
    assert.equal(calls, 1)

    const denied = await handleAiAuditRetentionRequest(
      { providedToken: 'wrong', expectedToken: TOKEN },
      async () => {
        calls += 1
        return { deleted: 0 }
      },
    )
    assert.equal(denied.status, 401)
    assert.equal(calls, 1)

    const missing = await handleAiAuditRetentionRequest(
      { providedToken: TOKEN, expectedToken: undefined },
      async () => {
        calls += 1
        return { deleted: 0 }
      },
    )
    assert.equal(missing.status, 401)
    assert.equal(calls, 1)
  })

  const GRANT_KEY = 'test-ai-audit-grant-key-32-bytes-min!!'
  const ADMIN_A = USER
  const ADMIN_B = '44444444-4444-4444-8444-444444444444'
  const ADMIN_C = '55555555-5555-4555-8555-555555555555'

  await check('négy szem: A kér, B jóváhagy; A vagy B olvashat, C és az önjóváhagyás nem', async () => {
    const now = new Date('2026-10-01T10:00:00Z')
    const requestToken = issueUnlockRequest(GRANT_KEY, { tenantId: TENANT, requesterId: ADMIN_A, now })
    const self = approveUnlockRequest(GRANT_KEY, requestToken, { tenantId: TENANT, approverId: ADMIN_A, now })
    assert.deepEqual(self, { ok: false, code: 'same_actor' })
    const cross = approveUnlockRequest(GRANT_KEY, requestToken, { tenantId: OTHER_TENANT, approverId: ADMIN_B, now })
    assert.deepEqual(cross, { ok: false, code: 'tenant_mismatch' })
    const approved = approveUnlockRequest(GRANT_KEY, requestToken, { tenantId: TENANT, approverId: ADMIN_B, now })
    assert.equal(approved.ok, true)
    if (!approved.ok) throw new Error('expected grant')
    assert.equal(verifyContentGrant(GRANT_KEY, approved.token, { tenantId: TENANT, readerId: ADMIN_A, now }).ok, true)
    assert.equal(verifyContentGrant(GRANT_KEY, approved.token, { tenantId: TENANT, readerId: ADMIN_B, now }).ok, true)
    assert.deepEqual(verifyContentGrant(GRANT_KEY, approved.token, { tenantId: TENANT, readerId: ADMIN_C, now }), {
      ok: false,
      code: 'not_party',
    })
    assert.deepEqual(verifyContentGrant(GRANT_KEY, null, { tenantId: TENANT, readerId: ADMIN_A, now }), {
      ok: false,
      code: 'invalid_token',
    })
    const later = new Date('2026-10-01T10:16:00Z')
    assert.equal(
      verifyContentGrant(GRANT_KEY, approved.token, { tenantId: TENANT, readerId: ADMIN_A, now: later }).ok,
      false,
    )
  })

  if (failures) process.exit(1)
  console.log('\nmind OK')
}

void main()
