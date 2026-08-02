/**
 * Következmény-kapu — risk-class (nem taint × side-effect).
 * Futtatás: npm run test:consequence-gate
 *
 * Forgatókönyvek:
 *  (a) workspace-írás külső adat után is auto (nincs kapu);
 *  (b) gmail_send mindig kapu;
 *  (c) ticket_create auto (még tainted-szerű külső olvasás után is);
 *  (d) file_delete kapu;
 *  (e) envelope továbbra is becsomagolja az external_untrusted eredményt;
 *  (f) xlsx_create NEM kapu (régi általános mellékhatás-kapu megszűnt);
 *  (g) kapu után nincs újabb tool-kör;
 *  (h) http_api_request write/danger / nem allowlistelt → kapu (policy unit);
 *  (i) http_api_request allowlistelt read → auto (policy unit);
 *  (j) initialTainted NEM kapuzza a workspace-írást;
 *  (k) read-only connector + http_api_request → denied a HITL előtt (nincs jóváhagyási kártya).
 */
import assert from 'node:assert/strict'
import { runAgentToolLoop, type ToolLoopConsequenceApprovalEvent } from '../src/domain/agent/chat-tool-loop'
import {
  evaluateHttpApiRequestGate,
  evaluateHttpApiWriteGrant,
  httpApiWriteGrantDeniedMessage,
  requiresConsequenceApproval,
} from '../src/domain/tool-broker/consequence-gate-policy'
import { EXTERNAL_DATA_WARNING, EXTERNAL_DATA_OPEN } from '../src/domain/tool-broker/tool-result-envelope'
import type { ModelGateway, ModelConfig, GatewayMessage, GatewayToolCall, ToolDefinition } from '../src/domain/gateway/model-gateway'
import type { ToolBrokerService, ToolBrokerInvokeInput } from '../src/domain/tool-broker/tool-broker-service'
import type { ToolBrokerRepository } from '../src/repositories/interfaces'
import type { HttpApiConfig } from '../src/domain/connector/http-api-client'
import { fakeToolBrokerSuccess } from './fixtures/tool-broker-result'

let failures = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : String(e)}`)
  }
}

const MODEL_CONFIG: ModelConfig = { provider: 'chatgpt-oauth', model: 'stub' }

type GatewayCallArgs = {
  messages: GatewayMessage[]
  tools?: ToolDefinition[]
}
type FakeResponse = { content?: string; toolCalls?: GatewayToolCall[] }

function fakeGateway(responses: FakeResponse[], record: GatewayCallArgs[]): ModelGateway {
  let i = 0
  return {
    call: async (args: GatewayCallArgs) => {
      record.push(args)
      const r = responses[Math.min(i, responses.length - 1)]
      i++
      return { content: r.content ?? '', ...(r.toolCalls?.length ? { toolCalls: r.toolCalls } : {}), usage: { promptTokens: 1, completionTokens: 1 } }
    },
  } as unknown as ModelGateway
}

/**
 * Tool-onkénti, a kimeneti szerződésnek MEGFELELŐ dublőr-kimenet. A kapu-teszt
 * nem a szerződést méri, de a szerződést sértő dublőr `failed`-et adna, és a
 * kapu-viselkedés helyett hibát mérnénk.
 */
function stubOutputFor(tool: string): unknown {
  switch (tool) {
    case 'web_search':
      return {
        results: [{ rank: 1, title: 'hír', url: 'https://example.test', snippet: '…' }],
        queryMeta: { provider: 'stub', resultCount: 1, domainsEffective: [] },
        warnings: [],
      }
    case 'document_read':
      return {
        documentId: 'd1',
        filename: 'doc.pdf',
        totalPages: 1,
        pages: [{ page: 1, heading: 'H', text: 'szöveg' }],
        truncated: false,
      }
    case 'file_write':
      return { path: 'r.txt', bytesWritten: 12 }
    case 'file_delete':
      return { deleted: true, path: 'r.txt' }
    case 'xlsx_create':
      return { path: 'r.xlsx', sheets: 1 }
    case 'ticket_create':
      return { ok: true, ticketId: 'ticket-1', state: 'new', assigneeType: 'human', assigneeId: null }
    case 'gmail_send':
      return { messageId: 'msg-1' }
    case 'http_api_request':
      return { ok: true, status: 200, body: { ok: true } }
    case 'http_api_get':
      return { ok: true, status: 200, body: { items: [{ id: 1 }] } }
    default:
      return { ok: true }
  }
}

function fakeToolBroker() {
  const invoked: ToolBrokerInvokeInput[] = []
  const gated: ToolBrokerInvokeInput[] = []
  const broker = {
    invoke: async (input: ToolBrokerInvokeInput) => {
      invoked.push(input)
      // issue #195 — a dublőr a broker VALÓDI alakját adja (kétcsatornás eredmény
      // + kötelező kimenetel), a szerződés-kapun keresztül.
      return fakeToolBrokerSuccess(input.tool, stubOutputFor(input.tool))
    },
    recordConsequenceGateBlock: async (input: ToolBrokerInvokeInput) => {
      gated.push(input)
    },
  } as unknown as ToolBrokerService
  return { broker, invoked, gated }
}

const fakeToolCaps = { findConnectorsForAgent: async () => [] } as unknown as ToolBrokerRepository

function toolNames(inputs: ToolBrokerInvokeInput[]): string[] {
  return inputs.map((i) => i.tool)
}

async function runLoop(
  responses: FakeResponse[],
  allowedTools: string[],
  gw: GatewayCallArgs[],
  extras?: {
    createConsequenceApproval?: (
      invoke: ToolBrokerInvokeInput,
    ) => Promise<ToolLoopConsequenceApprovalEvent>
    onConsequenceApproval?: (event: ToolLoopConsequenceApprovalEvent) => void | Promise<void>
    initialTainted?: boolean
  },
) {
  const { broker, invoked, gated } = fakeToolBroker()
  const result = await runAgentToolLoop({
    gateway: fakeGateway(responses, gw),
    toolBroker: broker,
    toolCaps: fakeToolCaps,
    agentId: 'agent-1',
    agentVersion: 1,
    context: { conversationId: 'conv-1' },
    mode: 'chat',
    actingUserId: 'user-1',
    messages: [{ role: 'user', content: 'feladat' }],
    modelConfig: MODEL_CONFIG,
    allowedTools: allowedTools as never,
    ...(extras?.createConsequenceApproval
      ? { createConsequenceApproval: extras.createConsequenceApproval }
      : {}),
    ...(extras?.onConsequenceApproval ? { onConsequenceApproval: extras.onConsequenceApproval } : {}),
    ...(extras?.initialTainted ? { initialTainted: true } : {}),
  })
  return { result, invoked, gated }
}

const sampleHttpConfig: HttpApiConfig = {
  baseUrl: 'https://api.example.com',
  auth: { scheme: 'bearer' },
  endpoints: [
    { method: 'GET', path: '/parcels', risk: 'read' },
    { method: 'POST', path: '/parcels', risk: 'write' },
    { method: 'DELETE', path: '/parcels/:id', risk: 'danger' },
  ],
}

async function main() {
  console.log('=== következmény-kapu risk-class ===')

  await test('(a) külső olvasás UTÁN file_write auto (nincs kapu)', async () => {
    const gw: GatewayCallArgs[] = []
    const { invoked, gated } = await runLoop(
      [
        { toolCalls: [{ id: 'c1', name: 'tulajdoni_lap_parse', input: { path: 'lap.pdf' } }] },
        { toolCalls: [{ id: 'c2', name: 'file_write', input: { path: 'parse.py', content: 'x' } }] },
        { content: 'kész' },
      ],
      ['tulajdoni_lap_parse', 'file_write'],
      gw,
    )
    assert.deepEqual(toolNames(invoked), ['tulajdoni_lap_parse', 'file_write'])
    assert.equal(gated.length, 0)
  })

  await test('(b) gmail_send mindig kapu', async () => {
    const gw: GatewayCallArgs[] = []
    const { invoked, gated } = await runLoop(
      [
        { toolCalls: [{ id: 'c1', name: 'gmail_send', input: { to: 'x@y.hu' } }] },
        { content: 'kész' },
      ],
      ['gmail_send'],
      gw,
      {
        createConsequenceApproval: async (invoke) => ({
          approvalId: 'appr-send',
          toolName: invoke.tool,
          summary: invoke.tool,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      },
    )
    assert.equal(invoked.length, 0)
    assert.deepEqual(toolNames(gated), ['gmail_send'])
    const toolMsg = gw[gw.length - 1].messages.find((m) => m.role === 'tool' && m.toolCallId === 'c1')
    assert.match(toolMsg!.content ?? '', /JÓVÁHAGYÁS SZÜKSÉGES/)
    assert.match(toolMsg!.content ?? '', /kilép|visszafordíthatatlan|tartós/i)
  })

  await test('(c) ticket_create auto külső olvasás után is', async () => {
    const gw: GatewayCallArgs[] = []
    const { invoked, gated } = await runLoop(
      [
        {
          toolCalls: [
            { id: 'c1', name: 'gmail_get_message', input: { id: 'm1' } },
            { id: 'c2', name: 'ticket_create', input: { title: 'teendő' } },
          ],
        },
        { content: 'kész' },
      ],
      ['gmail_get_message', 'ticket_create'],
      gw,
    )
    assert.deepEqual(toolNames(invoked), ['gmail_get_message', 'ticket_create'])
    assert.equal(gated.length, 0)
  })

  await test('(d) file_delete kapu', async () => {
    const gw: GatewayCallArgs[] = []
    const { invoked, gated } = await runLoop(
      [
        { toolCalls: [{ id: 'c1', name: 'file_delete', input: { path: 'a.txt' } }] },
        { content: 'kész' },
      ],
      ['file_delete'],
      gw,
    )
    assert.equal(invoked.length, 0)
    assert.deepEqual(toolNames(gated), ['file_delete'])
  })

  await test('(e) external_untrusted eredmény továbbra is becsomagolva megy a modellnek', async () => {
    const gw: GatewayCallArgs[] = []
    await runLoop(
      [
        { toolCalls: [{ id: 'c1', name: 'web_search', input: { query: 'hír' } }] },
        { content: 'kész' },
      ],
      ['web_search'],
      gw,
    )
    const toolMsg = gw[1].messages.find((m) => m.role === 'tool' && m.toolCallId === 'c1')
    assert.ok(toolMsg!.content?.includes(EXTERNAL_DATA_WARNING))
    assert.ok(toolMsg!.content?.includes(EXTERNAL_DATA_OPEN))
  })

  await test('(f) xlsx_create NEM kapu (még document_read után sem)', async () => {
    const gw: GatewayCallArgs[] = []
    const { invoked, gated } = await runLoop(
      [
        { toolCalls: [{ id: 'c1', name: 'document_read', input: { documentId: 'd1' } }] },
        {
          toolCalls: [
            { id: 'c2', name: 'xlsx_create', input: { path: 'r.xlsx', sheets: [{ name: 'S' }] } },
          ],
        },
        { content: 'kész' },
      ],
      ['document_read', 'xlsx_create'],
      gw,
    )
    assert.deepEqual(toolNames(invoked), ['document_read', 'xlsx_create'])
    assert.equal(gated.length, 0)
  })

  await test('(g) kapu után nincs újabb tool-kör', async () => {
    const gw: GatewayCallArgs[] = []
    await runLoop(
      [
        { toolCalls: [{ id: 'c1', name: 'gmail_send', input: { to: 'a@b.hu' } }] },
        { content: 'összefoglaló a gombról' },
        { toolCalls: [{ id: 'c2', name: 'gmail_send', input: { to: 'c@d.hu' } }] },
      ],
      ['gmail_send'],
      gw,
    )
    assert.equal(gw.length, 2, `gateway hívások: ${gw.length}`)
    assert.equal(gw[1].tools, undefined, 'a záró hívás tool nélküli')
  })

  await test('(h) http_api_request: nem allowlistelt / write / danger → kapu', async () => {
    const connectors = [{ id: 'conn-1', config: sampleHttpConfig, accessMode: 'write' as const }]
    assert.equal(
      evaluateHttpApiRequestGate(
        { connectorId: 'conn-1', method: 'POST', path: '/unknown' },
        connectors,
      ).reason,
      'http_api_not_allowlisted',
    )
    assert.equal(
      evaluateHttpApiRequestGate(
        { connectorId: 'conn-1', method: 'POST', path: '/parcels' },
        connectors,
      ).reason,
      'http_api_write_or_danger',
    )
    assert.equal(
      evaluateHttpApiRequestGate(
        { connectorId: 'conn-1', method: 'DELETE', path: '/parcels/1' },
        connectors,
      ).reason,
      'http_api_write_or_danger',
    )
  })

  await test('(i) http_api_request: allowlistelt read → auto', async () => {
    const connectors = [{ id: 'conn-1', config: sampleHttpConfig, accessMode: 'write' as const }]
    // http_api_request GET allowlistelt read végpontra — ritka, de nem kapu.
    const d = evaluateHttpApiRequestGate(
      { connectorId: 'conn-1', method: 'GET', path: '/parcels' },
      connectors,
    )
    assert.equal(d.required, false)
  })

  await test('(j) initialTainted NEM kapuzza a workspace-írást', async () => {
    const gw: GatewayCallArgs[] = []
    const { invoked, gated } = await runLoop(
      [
        {
          toolCalls: [
            { id: 'c1', name: 'xlsx_append_rows', input: { path: 'r.xlsx', rows: [['a']] } },
          ],
        },
        { content: 'kész' },
      ],
      ['xlsx_append_rows'],
      gw,
      { initialTainted: true },
    )
    assert.deepEqual(toolNames(invoked), ['xlsx_append_rows'])
    assert.equal(gated.length, 0)
  })

  await test('policy: ALWAYS gated toolok', async () => {
    for (const tool of [
      'gmail_send',
      'file_delete',
      'repo_open_pull_request',
      'sandbox.request_promotion',
      'sandbox.commit',
      'memory_propose',
    ]) {
      assert.equal(requiresConsequenceApproval(tool).required, true, tool)
    }
    assert.equal(requiresConsequenceApproval('file_write').required, false)
    assert.equal(requiresConsequenceApproval('ticket_create').required, false)
    assert.equal(requiresConsequenceApproval('board_write').required, false)
  })

  await test('policy: connector defaultRisk write → minden request kapu', async () => {
    const connectors = [
      {
        id: 'conn-1',
        config: { ...sampleHttpConfig, defaultRisk: 'write' as const },
        accessMode: 'write' as const,
      },
    ]
    assert.equal(
      evaluateHttpApiRequestGate(
        { connectorId: 'conn-1', method: 'GET', path: '/parcels' },
        connectors,
      ).required,
      true,
    )
  })

  await test('write-grant: read-only connector → http_api_request tiltva a HITL előtt', () => {
    const connectors = [{ id: 'crm-ro', config: sampleHttpConfig, accessMode: 'read' as const }]
    const denied = evaluateHttpApiWriteGrant(
      { connectorId: 'crm-ro', method: 'POST', path: '/parcels' },
      connectors,
    )
    assert.equal(denied.allowed, false)
    if (denied.allowed) return
    assert.equal(denied.reason, 'missing_http_api_connector_write_crm-ro')
    assert.match(
      httpApiWriteGrantDeniedMessage(denied.reason, denied.connectorId),
      /csak olvasási jogod van/,
    )
  })

  await test('write-grant: write assignment → engedélyezett (HITL külön dönt)', () => {
    const connectors = [{ id: 'crm-rw', config: sampleHttpConfig, accessMode: 'write' as const }]
    assert.deepEqual(
      evaluateHttpApiWriteGrant(
        { connectorId: 'crm-rw', method: 'POST', path: '/parcels' },
        connectors,
      ),
      { allowed: true },
    )
  })

  await test('loop: read-only CRM + http_api_request → denied, NINCS jóváhagyási kártya', async () => {
    const gw: GatewayCallArgs[] = []
    let approvals = 0
    const { broker, invoked, gated } = fakeToolBroker()
    const toolCaps = {
      findConnectorsForAgent: async () => [
        {
          connector: {
            id: 'fee173de-read-only',
            name: 'CRM ReadOnly',
            type: 'http_api',
            config: {
              baseUrl: 'https://crm.example/api/v1',
              auth: { scheme: 'bearer' },
              endpoints: [
                {
                  method: 'GET',
                  path: '/orders',
                  risk: 'read',
                  parameters: [{ name: 'X-Partner-Scope', in: 'header', required: true }],
                },
                { method: 'POST', path: '/reports/query', risk: 'write' },
              ],
            },
            tenantId: null,
            lifecycleState: 'active',
            authMode: 'service',
          },
          accessMode: 'read',
          agentSecretAlias: null,
        },
      ],
    } as unknown as ToolBrokerRepository

    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [
              {
                id: 'c1',
                name: 'http_api_request',
                input: {
                  connectorId: 'fee173de-read-only',
                  method: 'POST',
                  path: '/reports/query',
                  body: { q: 'x' },
                },
              },
            ],
          },
          { content: 'kész' },
        ],
        gw,
      ),
      toolBroker: broker,
      toolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-ro' },
      mode: 'chat',
      actingUserId: 'user-1',
      messages: [{ role: 'user', content: 'riport' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['http_api_get', 'http_api_request'] as never,
      createConsequenceApproval: async () => {
        approvals += 1
        return {
          approvalId: 'should-not-create',
          toolName: 'http_api_request',
          summary: 'nope',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
      },
    })

    assert.equal(approvals, 0, 'nem nyithat consequence-approvalt')
    assert.equal(gated.length, 0, 'nem recordConsequenceGateBlock')
    assert.equal(invoked.length, 0, 'broker.invoke nem fut')
    assert.equal(result.deniedCount, 1)
    const toolMsg = gw
      .flatMap((c) => c.messages)
      .find((m) => m.role === 'tool' && m.toolCallId === 'c1')
    assert.match(
      toolMsg!.content ?? '',
      /DENIED: missing_http_api_connector_write_fee173de-read-only/,
    )
    assert.match(toolMsg!.content ?? '', /http_api_get/)
    assert.doesNotMatch(toolMsg!.content ?? '', /JÓVÁHAGYÁS SZÜKSÉGES/)
    const catalog = gw[0].messages.find(
      (m) => m.role === 'system' && m.content?.includes('CRM ReadOnly'),
    )
    assert.ok(catalog)
    assert.match(catalog.content ?? '', /ÍRÁSJOG NINCS/)
    assert.match(catalog.content ?? '', /NEM HÍVHATÓ \(nincs írásjog\)/)
    assert.match(catalog.content ?? '', /Hívói fejlécek: X-Partner-Scope \(kötelező\)/)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
