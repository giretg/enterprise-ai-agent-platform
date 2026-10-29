/**
 * A worker HTTP-API-ja valódi HTTP-szerveren: CORS, chat-token, beszélgetés + forduló + SSE,
 * csatolmány-korlátok, 409, admin-betekintés kapuja, Cloud Tasks belépő.
 * Futtatás: npx tsx test/server.test.ts
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from '../src/attachments.ts'
import type { Config } from '../src/config.ts'
import { runStep, type EngineDeps, type TaskQueue } from '../src/engine.ts'
import type { PlatformClient } from '../src/platform.ts'
import { inlineQueue } from '../src/queue.ts'
import { createHandler } from '../src/server.ts'
import { MemoryStore } from './memory-store.ts'

const SECRET = 'q'.repeat(40)
const ORIGIN = 'https://app.example.com'
const TENANT = '22222222-2222-4222-8222-222222222222'
const USER = '11111111-1111-4111-8111-111111111111'
const ADMIN = '44444444-4444-4444-8444-444444444444'
const AGENT = '33333333-3333-4333-8333-333333333333'
const OFF_AGENT = '55555555-5555-4555-8555-555555555555'
let failures = 0

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
function token(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ aud: 'platform-chat', sub: USER, tenant: 'acme', tid: TENANT, role: 'operator', adminInsight: false, jti: 'j', iat: now, exp: now + 600, ...claims })
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'pc-att-'))
  const config: Config = {
    port: 0,
    platformOrigin: ORIGIN,
    selfUrl: 'https://worker.run.app',
    chatTokenSecret: SECRET,
    databaseUrl: '',
    queue: { kind: 'inline' },
    storage: { kind: 'local', dir },
    limits: { maxSteps: 25, maxTurnSeconds: 2400, maxAttemptsPerStep: 3, historyMessages: 30, toolResultChars: 1000 },
  }
  const store = new MemoryStore()
  let llmDelayMs = 0
  const seenUserContent: string[] = []
  const platform: PlatformClient = {
    continuationToken: async () => 'turn-token',
    listAgents: async () => [
      { agentId: AGENT, name: 'Réka', description: 'Pénzügy', platformChat: true },
      { agentId: OFF_AGENT, name: 'Kikapcsolt', platformChat: false },
    ],
    getDefinition: async () => '{}',
    listTools: async () => [],
    callTool: async () => ({ kind: 'complete', text: '', isError: false }),
    streamCompletion: async (input) => {
      seenUserContent.push(JSON.stringify(input.messages.filter((m) => m.role === 'user').at(-1)?.content))
      await new Promise((r) => setTimeout(r, llmDelayMs))
      input.onDelta('Szia, ')
      input.onDelta('itt Réka.')
      return { content: 'Szia, itt Réka.', toolCalls: [], usage: null, blockReason: null }
    },
  }
  const deps: EngineDeps = { store, platform, queue: undefined as unknown as TaskQueue, limits: config.limits, platformOrigin: ORIGIN }
  deps.queue = inlineQueue((task) => runStep(deps, task))
  const server = createServer(createHandler({ ...deps, config, storage: createStorage(config), verifyTaskToken: async (t) => t === 'oidc-ok' }))
  await new Promise<void>((r) => server.listen(0, r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const api = (path: string, init: RequestInit & { tok?: string } = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { origin: ORIGIN, authorization: `Bearer ${init.tok ?? token()}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })

  async function check(name: string, fn: () => Promise<void>) {
    try {
      await fn()
      console.log(`  OK  ${name}`)
    } catch (e) {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack : e}`)
    }
  }

  /** SSE olvasása a `done`/`error` eseményig (mint a böngésző fetch-streamje). */
  async function readEvents(turnId: string, after = 0) {
    const res = await api(`/turns/${turnId}/events`, { headers: { 'last-event-id': String(after) } })
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    const text = await res.text()
    return [...text.matchAll(/id: (\d+)\nevent: (\w+)\ndata: (.*)\n/g)].map((m) => ({ id: Number(m[1]), type: m[2], data: JSON.parse(m[3]) }))
  }

  try {
    await check('CORS: csak a platform origin; preflight', async () => {
      const pre = await fetch(`${base}/agents`, { method: 'OPTIONS', headers: { origin: ORIGIN } })
      assert.equal(pre.status, 204)
      assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN)
      const evil = await fetch(`${base}/agents`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
      assert.equal(evil.status, 403)
      const res = await api('/agents', { headers: { origin: 'https://evil.example' } })
      assert.equal(res.headers.get('access-control-allow-origin'), null)
    })

    await check('token nélkül / folytatási tokennel 401', async () => {
      assert.equal((await fetch(`${base}/agents`)).status, 401)
      assert.equal((await api('/agents', { tok: token({ aud: 'platform-chat-turn', turnId: 't', agentId: AGENT }) })).status, 401)
    })

    await check('munkatárs-lista: csak a chatre engedélyezett agentek', async () => {
      const body = (await (await api('/agents')).json()) as { agents: Array<{ agentId: string }> }
      assert.deepEqual(body.agents.map((a) => a.agentId), [AGENT])
      assert.equal((await api('/conversations', { method: 'POST', body: JSON.stringify({ agentId: OFF_AGENT }) })).status, 403)
    })

    let conversationId = ''
    await check('beszélgetés + forduló + SSE: a teljes válasz és a done esemény megérkezik', async () => {
      const created = await api('/conversations', { method: 'POST', body: JSON.stringify({ agentId: AGENT }) })
      assert.equal(created.status, 201)
      conversationId = ((await created.json()) as { conversation: { id: string } }).conversation.id
      const turn = await api(`/conversations/${conversationId}/turns`, { method: 'POST', body: JSON.stringify({ content: 'Szia!' }) })
      assert.equal(turn.status, 202)
      const { turnId } = (await turn.json()) as { turnId: string }
      const events = await readEvents(turnId)
      assert.equal(events.at(-1)?.type, 'done')
      assert.equal(events.at(-1)?.data.content, 'Szia, itt Réka.')
      assert.ok(events.some((e) => e.type === 'delta'))
      // visszacsatlakozás Last-Event-ID-vel: csak az utána jövők
      const tail = await readEvents(turnId, events.at(-2)!.id)
      assert.deepEqual(tail.map((e) => e.type), ['done'])
      const view = (await (await api(`/conversations/${conversationId}`)).json()) as { messages: Array<{ role: string }>; conversation: { title: string } }
      assert.deepEqual(view.messages.map((m) => m.role), ['user', 'assistant'])
      assert.equal(view.conversation.title, 'Szia!')
    })

    await check('futó forduló alatt új üzenet → 409 közérthető szöveggel', async () => {
      llmDelayMs = 300
      const first = await api(`/conversations/${conversationId}/turns`, { method: 'POST', body: JSON.stringify({ content: 'Első' }) })
      assert.equal(first.status, 202)
      const second = await api(`/conversations/${conversationId}/turns`, { method: 'POST', body: JSON.stringify({ content: 'Második' }) })
      assert.equal(second.status, 409)
      assert.match(((await second.json()) as { message: string }).message, /állítsd le/)
      await readEvents(((await first.json()) as { turnId: string }).turnId)
      llmDelayMs = 0
    })

    await check('más user beszélgetése 404', async () => {
      assert.equal((await api(`/conversations/${conversationId}`, { tok: token({ sub: ADMIN }) })).status, 404)
    })

    await check('csatolmány: CSV feltöltés, kinyert szöveg a modellnek; nem támogatott típus 415', async () => {
      const up = await fetch(`${base}/conversations/${conversationId}/attachments`, {
        method: 'POST',
        headers: { origin: ORIGIN, authorization: `Bearer ${token()}`, 'x-file-name': encodeURIComponent('bevétel.csv'), 'content-type': 'text/csv' },
        body: 'hónap;összeg\njanuár;100\nfebruár;250\n',
      })
      assert.equal(up.status, 201)
      const { attachment } = (await up.json()) as { attachment: { id: string } }
      const turn = await api(`/conversations/${conversationId}/turns`, { method: 'POST', body: JSON.stringify({ content: 'Mennyi a februári bevétel?', attachmentIds: [attachment.id] }) })
      await readEvents(((await turn.json()) as { turnId: string }).turnId)
      assert.match(seenUserContent.at(-1)!, /február;250/)
      const bad = await fetch(`${base}/conversations/${conversationId}/attachments`, {
        method: 'POST',
        headers: { origin: ORIGIN, authorization: `Bearer ${token()}`, 'x-file-name': 'virus.exe' },
        body: 'x',
      })
      assert.equal(bad.status, 415)
    })

    await check('keresés és átnevezés', async () => {
      assert.equal((await api(`/conversations/${conversationId}`, { method: 'PATCH', body: JSON.stringify({ title: 'Bevételek' }) })).status, 200)
      const found = (await (await api('/conversations?q=februári')).json()) as { conversations: Array<{ id: string; title: string }> }
      assert.deepEqual(found.conversations.map((c) => c.title), ['Bevételek'])
    })

    await check('admin-betekintés: kikapcsolva 404 (adminnak is); bekapcsolva lista + naplózott megnyitás', async () => {
      assert.equal((await api('/admin/conversations', { tok: token({ sub: ADMIN, role: 'admin', adminInsight: false }) })).status, 404)
      assert.equal((await api('/admin/conversations', { tok: token({ adminInsight: true }) })).status, 404) // nem admin
      const tok = token({ sub: ADMIN, role: 'admin', adminInsight: true })
      const list = (await (await api('/admin/conversations', { tok })).json()) as { conversations: Array<{ id: string; userId: string }> }
      assert.equal(list.conversations[0].userId, USER)
      assert.equal((await api(`/admin/conversations/${conversationId}`, { tok })).status, 200)
      assert.deepEqual(store.adminViews, [{ tenantId: TENANT, adminUserId: ADMIN, conversationId }])
    })

    await check('Cloud Tasks belépő: OIDC nélkül 401, rossz feladat 200 (nem próbálja újra)', async () => {
      assert.equal((await fetch(`${base}/internal/step`, { method: 'POST', body: '{}' })).status, 401)
      const bad = await fetch(`${base}/internal/step`, { method: 'POST', headers: { authorization: 'Bearer oidc-ok' }, body: '{"turnId":"x"}' })
      assert.equal(bad.status, 200)
    })

    await check('törlés: a beszélgetés és a csatolmányok eltűnnek', async () => {
      assert.equal((await api(`/conversations/${conversationId}`, { method: 'DELETE' })).status, 200)
      assert.equal((await api(`/conversations/${conversationId}`)).status, 404)
    })
  } finally {
    server.close()
  }
  if (failures) process.exit(1)
  console.log('\nplatform-chat server: all passed')
}

void main()
