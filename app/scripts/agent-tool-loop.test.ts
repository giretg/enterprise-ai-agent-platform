/**
 * Determinisztikus teszt az egységes agent tool loophoz és a /process routinghoz.
 * Futtatás: npm run test:tool-loop
 *
 * Élő modell / DB NÉLKÜL: a Gateway-t és a ToolBrokert befecskendezett fake-ekkel
 * helyettesítjük, így a loop kontextus-kezelése (chat vs. task) és a routing
 * tisztán igazolható.
 */
import assert from 'node:assert/strict'
import {
  listAllowedChatTools,
  runAgentToolLoop,
  recoverOpenAiToolCallsFromText,
} from '../src/domain/agent/chat-tool-loop'
import { assembleContext } from '../src/domain/conversation/context-assembly'
import { resolveTicketProcessRoute } from '../src/lib/ticket-process-route'
import type { ModelGateway, ModelConfig, GatewayMessage, GatewayToolCall, ToolDefinition } from '../src/domain/gateway/model-gateway'
import type {
  ToolBrokerService,
  ToolBrokerInvokeInput,
  ToolBrokerInvokeResult,
} from '../src/domain/tool-broker/tool-broker-service'
import type { AuditRepository, ToolBrokerRepository } from '../src/repositories/interfaces'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✅ ${name}`))
    .catch((e) => {
      failures++
      console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

const MODEL_CONFIG: ModelConfig = { provider: 'chatgpt-oauth', model: 'stub' }

type GatewayCallArgs = {
  agentId: string
  ticketId?: string
  conversationId?: string
  messages: GatewayMessage[]
  modelConfig: ModelConfig
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
      return {
        content: r.content ?? '',
        ...(r.toolCalls?.length ? { toolCalls: r.toolCalls } : {}),
        usage: { promptTokens: 1, completionTokens: 1 },
      }
    },
  } as unknown as ModelGateway
}

function fakeToolBroker(record: ToolBrokerInvokeInput[]): ToolBrokerService {
  return {
    invoke: async (input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> => {
      record.push(input)
      return {
        denied: false,
        result: { ok: true },
        resultMeta: {},
        latencyMs: 1,
      } as unknown as ToolBrokerInvokeResult
    },
  } as unknown as ToolBrokerService
}

function fakeToolBrokerResult(
  record: ToolBrokerInvokeInput[],
  result: Record<string, unknown>,
): ToolBrokerService {
  return {
    invoke: async (input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> => {
      record.push(input)
      return {
        denied: false,
        result,
        resultMeta: {},
        latencyMs: 1,
      } as unknown as ToolBrokerInvokeResult
    },
  } as unknown as ToolBrokerService
}

const fakeToolCaps = {
  findConnectorsForAgent: async () => [],
} as unknown as ToolBrokerRepository

function fakeAudit(record: Array<Record<string, unknown>>): AuditRepository {
  return {
    append: async (data) => {
      record.push(data as unknown as Record<string, unknown>)
      return {
        id: `audit-${record.length}`,
        seq: record.length,
        createdAt: new Date(),
        hash: `hash-${record.length}`,
        prevHash: record.length === 1 ? 'genesis' : `hash-${record.length - 1}`,
        ...data,
      } as never
    },
    findMany: async () => [],
    findAll: async () => [],
    getActionCounts: async () => ({}),
  }
}

async function main() {
  console.log('=== agent tool loop + routing teszt ===')

  await check('context assembly: törölt tartalom kimarad, budget determinisztikusan vág és audit nem tartalmaz contentet', async () => {
    const auditEvents: Array<Record<string, unknown>> = []
    const assembled = await assembleContext({
      audit: fakeAudit(auditEvents),
      conversationId: 'conv-ctx',
      agentId: 'agent-1',
      agentVersion: 7,
      actingUserId: 'user-1',
      memoryVersion: 3,
      documentAliases: ['kb:source-b', 'kb:source-a', 'kb:source-a'],
      budgetTokens: 20,
      recencyWindowMessages: 10,
      messages: [
        {
          id: 'm1',
          seq: 1,
          role: 'user',
          content: 'old secret content',
          contentDeletedAt: null,
          createdAt: new Date('2025-12-31T00:00:00Z'),
        },
        {
          id: 'm2',
          seq: 2,
          role: 'agent',
          content: null,
          contentDeletedAt: new Date('2026-01-01T00:00:00Z'),
          createdAt: new Date('2025-12-31T00:01:00Z'),
        },
        {
          id: 'm3',
          seq: 3,
          role: 'user',
          content: 'x'.repeat(200),
          contentDeletedAt: null,
          createdAt: new Date('2025-12-31T00:02:00Z'),
        },
        {
          id: 'm4',
          seq: 4,
          role: 'user',
          content: 'latest',
          contentDeletedAt: null,
          createdAt: new Date('2025-12-31T00:03:00Z'),
        },
      ],
    })

    assert.deepEqual(assembled.messageSeqs, [4])
    assert.deepEqual(assembled.skippedDeletedSeqs, [2])
    assert.deepEqual(assembled.droppedSeqs, [1, 3])
    assert.deepEqual(assembled.documentAliases, ['kb:source-a', 'kb:source-b'])
    assert.equal(auditEvents[0].action, 'context.assembled')
    assert.equal(auditEvents[1].action, 'context.truncated')
    assert.ok(!JSON.stringify(auditEvents).includes('old secret content'))
    assert.ok(!JSON.stringify(auditEvents).includes('latest'))
    assert.ok(!JSON.stringify(auditEvents).includes('xxxxxxxx'))
  })

  await check('task mód: ticketId kontextus megy a gateway-nek és a brokernek', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          { toolCalls: [{ id: 'c1', name: 'file_read', input: { path: 'a.txt' } }] },
          { content: 'Kész a feladat.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 3,
      context: { ticketId: 'ticket-1' },
      mode: 'task',
      messages: [{ role: 'user', content: 'olvasd be a.txt' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['file_read'],
    })

    assert.equal(result.content, 'Kész a feladat.')
    assert.equal(result.toolCallCount, 1)
    assert.equal(brokerCalls.length, 1)
    assert.equal(brokerCalls[0].ticketId, 'ticket-1')
    assert.equal(brokerCalls[0].conversationId, undefined)
    assert.equal(brokerCalls[0].tool, 'file_read')
    // a gateway is ticketId kontextust kapott (guardrail / audit célból)
    assert.equal(gwCalls[0].ticketId, 'ticket-1')
    assert.equal(gwCalls[0].conversationId, undefined)
  })

  await check('életjel: a loop MINDEN kör elején meghívja az onTurnStart horgot', async () => {
    // chat-agent-turn-resilience-spec.md D8/D10 — erre épül a forduló-rekord
    // heartbeatje, amiből egy elhalt futás kívülről felismerhető.
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const turnStarts: number[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          { toolCalls: [{ id: 'c1', name: 'file_read', input: { path: 'a.txt' } }] },
          { toolCalls: [{ id: 'c2', name: 'file_read', input: { path: 'b.txt' } }] },
          { content: 'Kész.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 3,
      context: { conversationId: 'conv-1' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'olvasd be a fájlokat' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['file_read'],
      onTurnStart: (turnIndex) => {
        turnStarts.push(turnIndex)
      },
    })

    assert.equal(result.content, 'Kész.')
    assert.deepEqual(turnStarts, [0, 1, 2], 'körönként pontosan egy életjel, a kör indexével')
  })

  await check('prompt cache: a loop statikus prefixe a változó kontextus és előzmény elé kerül', async () => {
    const gwCalls: GatewayCallArgs[] = []
    await runAgentToolLoop({
      gateway: fakeGateway([{ content: 'Kész.' }], gwCalls),
      toolBroker: fakeToolBroker([]),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-cache' },
      mode: 'chat',
      promptSegments: {
        stablePreamble: [{ role: 'system', content: 'agent + roster' }],
        stablePostamble: [{ role: 'system', content: 'memory + KB policy' }],
        variableContext: [{ role: 'system', content: 'Project memory context: változó' }],
        history: [{ role: 'user', content: 'kérdés' }],
      },
      preloadedSkillPrompts: ['slash skill: változó'],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['web_search', 'file_read'],
    })

    const content = gwCalls[0].messages.map((message) =>
      ('content' in message ? message.content : message.role) ?? '',
    )
    const toolInstruction = content.findIndex((value) => value.includes('natív tool-hívással'))
    const policy = content.indexOf('memory + KB policy')
    const memory = content.indexOf('Project memory context: változó')
    const slashSkill = content.indexOf('slash skill: változó')
    const history = content.indexOf('kérdés')
    assert.ok(toolInstruction > 0 && toolInstruction < policy)
    assert.ok(policy < memory && memory < slashSkill && slashSkill < history)
    assert.deepEqual(gwCalls[0].tools?.map((tool) => tool.name), ['file_read', 'web_search'])
    assert.ok(content.some((value) => value === 'A számodra engedélyezett eszközök: file_read, web_search'))
  })

  await check('chat mód: conversationId + actingUserId propagál', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway([{ content: 'Szia, miben segíthetek?' }], gwCalls),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-1' },
      mode: 'chat',
      actingUserId: 'user-1',
      messages: [{ role: 'user', content: 'szia' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: [],
    })

    assert.equal(result.content, 'Szia, miben segíthetek?')
    assert.equal(result.toolCallCount, 0)
    assert.equal(brokerCalls.length, 0)
    assert.equal(gwCalls[0].conversationId, 'conv-1')
    assert.equal(gwCalls[0].ticketId, undefined)
  })

  await check('chat mód: az actingUserId átmegy a tool invoke-ba', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    await runAgentToolLoop({
      gateway: fakeGateway(
        [
          { toolCalls: [{ id: 'c1', name: 'gmail_search', input: { query: 'is:unread' } }] },
          { content: 'Megvan.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-1' },
      mode: 'chat',
      actingUserId: 'user-1',
      messages: [{ role: 'user', content: 'leveleim' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['gmail_search'],
    })

    assert.equal(brokerCalls.length, 1)
    assert.equal(brokerCalls[0].conversationId, 'conv-1')
    assert.equal(brokerCalls[0].actingUserId, 'user-1')
  })

  await check('chat mód: web_search engedélyezett capability esetén hívható', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const caps = {
      findCapabilitiesForAgent: async () => [
        { toolName: 'web_search', allowed: true },
        { toolName: 'kb_search', allowed: true },
      ],
      findConnectorsForAgent: async () => [],
    } as unknown as ToolBrokerRepository
    const allowed = await listAllowedChatTools(caps, 'agent-1')

    // kb_search mostantól hívható platform-tool is (a pre-fetch mellett célzott
    // újrakereséshez), ezért az engedélyezett listában megjelenik.
    assert.deepEqual(allowed, ['web_search', 'kb_search'])

    await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [
              {
                id: 'web-1',
                name: 'web_search',
                input: {
                  query: 'telex.hu vezető hír',
                  domains: ['telex.hu'],
                  maxResults: 3,
                  purpose: 'current_news_check',
                },
              },
            ],
          },
          { content: 'A webes találat alapján összefoglaltam.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBrokerResult(brokerCalls, {
        results: [],
        queryMeta: { provider: 'stub', resultCount: 0, domainsEffective: ['telex.hu'] },
        warnings: [],
      }),
      toolCaps: caps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-web' },
      mode: 'chat',
      actingUserId: 'user-1',
      messages: [{ role: 'user', content: 'nézz utána a neten' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: allowed,
    })

    assert.equal(brokerCalls.length, 1)
    assert.equal(brokerCalls[0].tool, 'web_search')
    assert.equal(brokerCalls[0].conversationId, 'conv-web')
    assert.equal(brokerCalls[0].actingUserId, 'user-1')
    if (brokerCalls[0].tool === 'web_search') {
      assert.deepEqual(brokerCalls[0].args, {
        query: 'telex.hu vezető hír',
        domains: ['telex.hu'],
        recencyDays: undefined,
        locale: undefined,
        maxResults: 3,
        purpose: 'current_news_check',
      })
    }
  })

  await check('vékony fallback: beágyazott {"tool":...} JSON tool_calls nélkül is hív', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          // natív toolCalls NINCS — csak szövegbe ágyazott JSON
          { content: '{"tool":"file_read","args":{"path":"b.txt"}}' },
          { content: 'Kész.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { ticketId: 'ticket-2' },
      mode: 'task',
      messages: [{ role: 'user', content: 'olvasd be b.txt' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['file_read'],
    })

    assert.equal(result.content, 'Kész.')
    assert.equal(result.toolCallCount, 1)
    assert.equal(brokerCalls.length, 1)
    assert.equal(brokerCalls[0].tool, 'file_read')
  })

  await check('KB doc: azonosító nem mehet workspace docx_read/file_read eszköznek', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [
              {
                id: 'bad-doc-read',
                name: 'docx_read',
                input: { path: 'doc:ec96eff7-1234-4a5f-9000-111111111111' },
              },
            ],
          },
          { content: 'A kb_search találatok alapján dolgozom tovább.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { ticketId: 'ticket-kb-docref' },
      mode: 'task',
      messages: [{ role: 'user', content: 'Készíts riportot a KB policy alapján.' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['docx_read', 'kb_search'],
    })

    assert.equal(result.content, 'A kb_search találatok alapján dolgozom tovább.')
    assert.equal(result.toolCallCount, 0)
    assert.equal(brokerCalls.length, 0, 'a hibás workspace-read nem juthat el a brokerig')
    const correction = gwCalls[1].messages.find(
      (m) => m.role === 'tool' && m.toolCallId === 'bad-doc-read',
    )
    assert.ok(correction)
    assert.match(correction.content ?? '', /tudásbázis-azonosítónak tűnik/)
    assert.match(correction.content ?? '', /kb_search/)
  })

  await check('nagy tool eredmény: teljes tartalom archiválva, kontextusban csak előnézet', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const largeRows = Array.from({ length: 400 }, (_, i) => ({
      id: i + 1,
      name: `Ügyfél ${i + 1}`,
      revenue: (i + 1) * 1000,
      note: 'hosszú crm sor '.repeat(8),
    }))
    const archived: Array<{ path: string; content: string }> = []
    const workspaceWrites = new Map<string, string>()

    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          { toolCalls: [{ id: 'crm-call', name: 'http_api_get', input: { path: '/customers' } }] },
          { content: 'A teljes CRM eredményt feldolgoztam.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBrokerResult(brokerCalls, { customers: largeRows }),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-1' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'milyen ügyfelek vannak?' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['http_api_get'],
      archiveLargeToolResult: async ({ content }) => {
        archived.push({ path: '.tool-results/01-http_api_get-crm-call.json', content })
        return { path: '.tool-results/01-http_api_get-crm-call.json', bytes: Buffer.byteLength(content) }
      },
      writeWorkspaceFile: async (path, content) => {
        workspaceWrites.set(path, content)
        return { bytes: Buffer.byteLength(content) }
      },
    })

    assert.equal(result.content, 'A teljes CRM eredményt feldolgoztam.')
    assert.equal(archived.length, 1)
    assert.match(archived[0].content, /Ügyfél 400/)
    assert.ok(workspaceWrites.has('tool-outputs/01-http_api_get-crm-call.json'))
    assert.match(workspaceWrites.get('tool-outputs/01-http_api_get-crm-call.json')!, /Ügyfél 400/)
    const toolMessage = gwCalls[1].messages.find((m) => m.role === 'tool')
    assert.ok(toolMessage)
    assert.match(toolMessage.content, /A teljes eredmény elmentve/)
    assert.match(toolMessage.content, /tool_result_extract/)
    assert.match(toolMessage.content, /tool-outputs\//)
    assert.doesNotMatch(toolMessage.content, /olvasd tovább a tool_result_read/)
    assert.ok(!toolMessage.content.includes('Ügyfél 400'))
  })

  await check('tool_result_extract: 300 sor × 3 mező egy hívásban, válasz < 2000 kar', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: i + 1,
      nev: `Tulajdonos ${i + 1}`,
      szuletesiEv: 1950 + (i % 50),
      anyjaNeve: `Anyja ${i + 1}`,
      zaj: 'x'.repeat(200),
    }))
    const archivePath = '.tool-results/01-http_api_get-page.json'
    const archiveContent = JSON.stringify(rows)
    const written = new Map<string, string>()

    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [
              {
                id: 'extract-1',
                name: 'tool_result_extract',
                input: {
                  path: archivePath,
                  fields: ['nev', 'szuletesiEv', 'anyjaNeve'],
                  outputPath: 'nyilvantartas-kivonat.json',
                },
              },
            ],
          },
          { content: 'Kivonat kész.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBrokerResult([], {}),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-extract' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'nyerd ki a neveket' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['http_api_get'],
      archiveLargeToolResult: async () => ({ path: archivePath, bytes: archiveContent.length }),
      listWorkspaceFiles: async () => [archivePath],
      readWorkspaceFile: async (path) => (path === archivePath ? archiveContent : null),
      writeWorkspaceFile: async (path, content) => {
        written.set(path, content)
        return { bytes: Buffer.byteLength(content) }
      },
    })

    assert.equal(result.content, 'Kivonat kész.')
    assert.equal(written.size, 1)
    const out = JSON.parse(written.get('nyilvantartas-kivonat.json')!)
    assert.equal(out.length, 300)
    assert.deepEqual(Object.keys(out[0]).sort(), ['anyjaNeve', 'nev', 'szuletesiEv'])
    const toolMessage = gwCalls[1].messages.find((m) => m.role === 'tool')
    assert.ok(toolMessage)
    assert.ok(toolMessage.content.length < 2000, `összefoglaló túl hosszú: ${toolMessage.content.length}`)
    assert.match(toolMessage.content, /300/)
    assert.doesNotMatch(toolMessage.content, /Tulajdonos 50/)
  })

  await check('WP-3: folytatás-fordulóban a korábbi .tool-results archívum olvasható', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const archivePath = '.tool-results/01-http_api_get-prev.json'
    const archiveContent = JSON.stringify({ hello: 'from-previous-turn', pad: 'x'.repeat(100) })
    let brokerHits = 0

    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [
              {
                id: 'read-prev',
                name: 'tool_result_read',
                input: { path: archivePath, offset: 0, limit: 500 },
              },
            ],
          },
          { content: 'Megvan a korábbi eredmény.' },
        ],
        gwCalls,
      ),
      toolBroker: {
        async invoke() {
          brokerHits += 1
          return { denied: false, trust: 'trusted', result: {} }
        },
      } as never,
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-hydrate' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'folytasd' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['http_api_get'],
      archiveLargeToolResult: async () => ({ path: archivePath, bytes: archiveContent.length }),
      listWorkspaceFiles: async () => [archivePath],
      readWorkspaceFile: async (path) => (path === archivePath ? archiveContent : null),
    })

    assert.equal(result.content, 'Megvan a korábbi eredmény.')
    assert.equal(brokerHits, 0, 'nem szabad újra letölteni a brokeren át')
    const toolMessage = gwCalls[1].messages.find((m) => m.role === 'tool')
    assert.ok(toolMessage)
    assert.match(toolMessage.content, /from-previous-turn/)
    assert.doesNotMatch(toolMessage.content, /nincs ilyen elmentett tool-eredmény/)
  })

  await check('task mód: max turn kimerülés explicit exhausted státuszt ad', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          { toolCalls: [{ id: 'search-1', name: 'kb_search', input: { query: 'policy', k: 5 } }] },
          { content: '' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBrokerResult(brokerCalls, { hits: [] }),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { ticketId: 'ticket-exhausted' },
      mode: 'task',
      messages: [{ role: 'user', content: 'készíts javaslatot policy hivatkozásokkal' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['kb_search'],
      maxTurns: 1,
    })

    assert.equal(result.status, 'exhausted')
    assert.equal(result.reason, 'max_turns_exhausted')
    assert.equal(result.toolCallCount, 1)
    assert.match(result.content, /nem sikerült|körök elfogytak/i)
  })

  await check('routing: hiányzó / üres / wiki source → wiki', () => {
    assert.equal(resolveTicketProcessRoute(undefined), 'wiki')
    assert.equal(resolveTicketProcessRoute(null), 'wiki')
    assert.equal(resolveTicketProcessRoute({}), 'wiki')
    assert.equal(resolveTicketProcessRoute({ source: 'wiki' }), 'wiki')
    assert.equal(resolveTicketProcessRoute({ source: '' }), 'wiki')
    assert.equal(resolveTicketProcessRoute([{ source: 'agent_chat' }]), 'wiki')
  })

  await check('routing: agent_chat / agent_tool / agent_ask → general', () => {
    assert.equal(resolveTicketProcessRoute({ source: 'agent_chat' }), 'general')
    assert.equal(resolveTicketProcessRoute({ source: 'agent_tool' }), 'general')
    assert.equal(resolveTicketProcessRoute({ source: 'agent_ask' }), 'general')
    assert.equal(resolveTicketProcessRoute({ source: 'delegation' }), 'general')
  })

  await check('OpenAI delta-leak kimentése: töredékelt arguments összeáll', () => {
    // A valós qwen3/OpenRouter leak (conversation 1a6c23ac) pontos alakja.
    const leak =
      '[{"id":"call_8ac786bc2aff4cceb0ab88","type":"function","function":{"name":"http_api_get"},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"{\\""},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"path\\": \\"/banks/6"},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"742eee"},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"8b89"},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"ccc2f8"},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"deae2f1"},"index":0}]' +
      '[{"id":"","type":"function","function":{"arguments":"/crm\\"}"},"index":0}]'
    const calls = recoverOpenAiToolCallsFromText(leak)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].tool, 'http_api_get')
    assert.deepEqual(calls[0].args, { path: '/banks/6742eee8b89ccc2f8deae2f1/crm' })
  })

  await check('OpenAI delta-leak: több párhuzamos tool index külön hívás', () => {
    const leak =
      '[{"id":"a","type":"function","function":{"name":"xlsx_create","arguments":"{\\"path\\":\\"r.xlsx\\"}"},"index":0}]' +
      '[{"id":"b","type":"function","function":{"name":"http_api_get","arguments":"{\\"path\\":\\"/banks\\"}"},"index":1}]'
    const calls = recoverOpenAiToolCallsFromText(leak)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].tool, 'xlsx_create')
    assert.deepEqual(calls[1].args, { path: '/banks' })
  })

  await check('Sima szöveg nem ad hamis kimentést', () => {
    assert.equal(recoverOpenAiToolCallsFromText('Kész az Excel fájl, itt a tartalma.').length, 0)
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
