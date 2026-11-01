/**
 * A worker platform-kliense a drót-formátumon: MCP JSON-RPC (SSE-válasz), MRTR körök,
 * gateway-token + SSE chat completion (darabolt tool-hívás, usage-költség, keret-blokk fejléc).
 * Futtatás: npx tsx test/platform-client.test.ts
 */
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BUDGET_BLOCK_REASON, createPlatformClient, fileLinksOf, PLATFORM_CHAT_INSTALL_ID } from '../src/platform.ts'

let failures = 0
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack : e}`)
  }
}

const seen: Array<{ path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }> = []
let budgetBlocked = false

const sse = (payload: unknown) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`
const chunk = (delta: unknown, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }], ...extra })}\n\n`

const server = createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  seen.push({ path: req.url ?? '', headers: req.headers, body })
  if (req.url === '/api/chat/continuation') {
    res.writeHead(req.headers.authorization === 'Bearer chat' ? 200 : 401, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(req.headers.authorization === 'Bearer chat' ? { token: 'turn', expiresAt: '' } : { error: 'unauthenticated' }))
  }
  if (req.url === '/api/mcp/acme') {
    const params = body.params as { name?: string; requestState?: string }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (body.method === 'tools/list') return res.end(sse({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'gmail_send', inputSchema: { type: 'object' } }] } }))
    if (params.name === 'platform.agents.list') return res.end(sse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ agents: [{ agentId: 'a1', platformChat: true }] }) }] } }))
    if (params.name === 'gmail_send' && !params.requestState) {
      return res.end(sse({ jsonrpc: '2.0', id: 1, result: { resultType: 'input_required', requestState: 'v1.sealed', inputRequests: { confirm_write: { method: 'elicitation/create', params: { mode: 'form', message: 'Gmail új levél, címzett: anna@example.com' } } } } }))
    }
    return res.end(sse({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete', content: [{ type: 'text', text: '{"sent":true}' }] } }))
  }
  if (req.url === '/api/model-gateway/token') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ token: 'gw-jwt' }))
  }
  if (req.url === '/api/model-gateway/v1/chat/completions') {
    if (budgetBlocked) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-excellence-block-reason': BUDGET_BLOCK_REASON })
      return res.end(chunk({ role: 'assistant', content: 'A cég mai keretét erre a beszélgetésre már felhasználtuk.' }) + 'data: [DONE]\n\n')
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(chunk({ role: 'assistant', content: 'Elküldöm ' }))
    res.write(chunk({ content: 'a levelet.' }))
    res.write(chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'gmail_send', arguments: '{"to":"an' } }] }))
    // darabolt SSE-sor két TCP-csomagban
    const tail = chunk({ tool_calls: [{ index: 0, function: { arguments: 'na@example.com"}' } }] })
    res.write(tail.slice(0, 20))
    await new Promise((r) => setTimeout(r, 20))
    res.write(tail.slice(20))
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0042 } })}\n\n`)
    return res.end('data: [DONE]\n\n')
  }
  res.writeHead(404).end()
})

async function main() {
  await new Promise<void>((r) => server.listen(0, r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const client = createPlatformClient(origin)
  const access = { token: 'turn', tenantSlug: 'acme', agentId: 'a1', sessionId: 'conv-1' }
  try {
    await check('folytatási token: a böngésző chat-tokenjével', async () => {
      assert.equal(await client.continuationToken({ chatToken: 'chat', turnId: 't', agentId: 'a1' }), 'turn')
      await assert.rejects(client.continuationToken({ chatToken: 'bad', turnId: 't', agentId: 'a1' }))
    })

    await check('MCP: tools/list és agents.list SSE-válaszból; állapotmentes 2026-07-28 envelope + agent-kötés', async () => {
      assert.deepEqual((await client.listTools(access)).map((t) => t.name), ['gmail_send'])
      const req = seen.at(-1)!
      assert.equal(req.headers['mcp-protocol-version'], '2026-07-28')
      assert.equal(req.headers['x-excellence-agent-id'], 'a1')
      assert.equal(req.headers.authorization, 'Bearer turn')
      const meta = (req.body.params as { _meta: Record<string, unknown> })._meta
      assert.deepEqual(meta['io.modelcontextprotocol/clientCapabilities'], { elicitation: { form: {} } })
      assert.deepEqual(await client.listAgents({ token: 'chat', tenantSlug: 'acme' }), [{ agentId: 'a1', platformChat: true }])
    })

    await check('#1024 fájl-linkek: resource_link + adattárház exportUrl; idegen cím és hibás eredmény nem kártya', async () => {
      const origin = 'https://app.example.com'
      const url = `${origin}/api/control-plane/document-exports/e1`
      const exported = {
        content: [
          { type: 'text', text: JSON.stringify({ exportId: 'e1', downloadUrl: url, expiresAt: '2026-11-07T10:00:00.000Z' }) },
          { type: 'resource_link', uri: url, name: 'Riport.xlsx', mimeType: 'application/xlsx', size: 1234 },
          { type: 'resource_link', uri: 'https://evil.example/x.exe', name: 'x.exe' },
        ],
      }
      assert.deepEqual(fileLinksOf('document_export', exported, origin), [
        { url, name: 'Riport.xlsx', mimeType: 'application/xlsx', size: 1234, expiresAt: '2026-11-07T10:00:00.000Z', exportId: 'e1' },
      ])
      assert.deepEqual(fileLinksOf('document_export', { ...exported, isError: true }, origin), [])
      const warehouse = { content: [{ type: 'text', text: JSON.stringify({ dataset: 'szamlak', exportUrl: `${origin}/api/control-plane/warehouse/export/szamlak` }) }] }
      assert.deepEqual(fileLinksOf('warehouse.export_dataset', warehouse, origin), [
        {
          url: `${origin}/api/control-plane/warehouse/export/szamlak`,
          name: 'szamlak.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: null,
          expiresAt: null,
          exportId: null,
        },
      ])
      // Más eszköz „exportUrl” mezője (pl. külső MCP-n át) nem lesz kártya.
      assert.deepEqual(fileLinksOf('mcp_call', warehouse, origin), [])
    })

    await check('MRTR: input_required → űrlap-üzenet; második kör inputResponses + requestState', async () => {
      const first = await client.callTool({ ...access, name: 'gmail_send', args: { to: 'anna@example.com' } })
      assert.deepEqual(first, { kind: 'input_required', requestState: 'v1.sealed', inputKey: 'confirm_write', message: 'Gmail új levél, címzett: anna@example.com' })
      const second = await client.callTool({ ...access, name: 'gmail_send', args: { to: 'anna@example.com' }, approval: { requestState: 'v1.sealed', inputKey: 'confirm_write', decision: 'approve' } })
      assert.deepEqual(second, { kind: 'complete', text: '{"sent":true}', isError: false, files: [] })
      const params = seen.at(-1)!.body.params as Record<string, unknown>
      assert.deepEqual(params.inputResponses, { confirm_write: { action: 'accept', content: { decision: 'approve' } } })
      assert.equal(params.requestState, 'v1.sealed')
    })

    await check('modell: gateway-token a szerveroldali installra, stream deltákkal, darabolt tool-hívással, költséggel', async () => {
      const deltas: string[] = []
      const out = await client.streamCompletion({ ...access, conversationId: 'conv-1', turnId: 'turn-1', messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: (d) => deltas.push(d) })
      const tokenReq = seen.find((s) => s.path === '/api/model-gateway/token')!
      assert.deepEqual(tokenReq.body, { tenantSlug: 'acme', agentId: 'a1', installId: PLATFORM_CHAT_INSTALL_ID, sessionId: 'conv-1' })
      const completion = seen.at(-1)!
      assert.equal(completion.headers['x-excellence-session'], 'conv-1')
      assert.equal(completion.headers['x-excellence-turn'], 'turn-1')
      assert.equal(completion.headers.authorization, 'Bearer gw-jwt')
      assert.deepEqual(deltas, ['Elküldöm ', 'a levelet.'])
      assert.deepEqual(out.toolCalls, [{ id: 'call_1', name: 'gmail_send', arguments: '{"to":"anna@example.com"}' }])
      assert.deepEqual(out.usage, { promptTokens: 100, completionTokens: 20, costUsd: 0.0042 })
      assert.equal(out.blockReason, null)
    })

    await check('keret-blokk: a fejlécből felismerve, a szöveg nem megy deltaként', async () => {
      budgetBlocked = true
      const deltas: string[] = []
      const out = await client.streamCompletion({ ...access, conversationId: 'conv-1', turnId: 't', messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: (d) => deltas.push(d) })
      assert.equal(out.blockReason, BUDGET_BLOCK_REASON)
      assert.match(out.content, /keretét/)
      assert.deepEqual(deltas, [])
    })
  } finally {
    server.close()
  }
  if (failures) process.exit(1)
  console.log('\nplatform-chat platform client: all passed')
}

void main()
