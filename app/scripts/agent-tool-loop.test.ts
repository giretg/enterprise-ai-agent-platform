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
  TOOL_LOOP_CHECKPOINT_PATH,
} from '../src/domain/agent/chat-tool-loop'
import { assembleContext } from '../src/domain/conversation/context-assembly'
import { resolveTicketProcessRoute } from '../src/lib/ticket-process-route'
import type { ModelGateway, ModelConfig, GatewayMessage, GatewayToolCall, ToolDefinition } from '../src/domain/gateway/model-gateway'
import type {
  ToolBrokerService,
  ToolBrokerInvokeInput,
  ToolBrokerInvokeResult,
} from '../src/domain/tool-broker/tool-broker-service'
import {
  buildToolModelText,
  validateToolOutput,
} from '../src/domain/tool-broker/tool-output-contract'
import { resolveToolOutputContract } from '../src/domain/tool-broker/tool-output-contracts'
import { isSideEffectingTool } from '../src/domain/tool-broker/tool-trust-registry'
import { createWorkspaceToolResultArchiver } from '../src/domain/agent/tool-result-archive'
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

type FakeResponse = {
  content?: string
  toolCalls?: GatewayToolCall[]
  usage?: { promptTokens: number; completionTokens: number }
  fallbackRoute?: { provider: string; model: string }
}

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
        ...(r.fallbackRoute ? { fallbackRoute: r.fallbackRoute } : {}),
        usage: r.usage ?? { promptTokens: 1, completionTokens: 1 },
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

/**
 * Stub Tool Broker. issue #195 óta a broker KÉT csatornát ad (`modelText` +
 * `machineData`), és a kimenetel kötelező mező — a stub ugyanazokkal a
 * tiszta függvényekkel állítja elő, mint az éles keret, hogy a tool-loop a
 * valódi alakot lássa.
 */
function fakeToolBrokerResult(
  record: ToolBrokerInvokeInput[],
  result: Record<string, unknown>,
  trust: 'trusted' | 'internal' | 'external_untrusted' = 'trusted',
): ToolBrokerService {
  return {
    invoke: async (input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> => {
      record.push(input)
      const verdict = validateToolOutput({
        tool: input.tool,
        output: result,
        contract: resolveToolOutputContract(input.tool),
        sideEffecting: isSideEffectingTool(input.tool),
      })
      const modelChannel = buildToolModelText({
        tool: input.tool,
        trust,
        outcome: verdict.outcome,
        reason: verdict.reason,
        effect: verdict.effect,
        machineData: result,
      })
      return {
        denied: false,
        trust,
        outcome: verdict.outcome,
        outcomeReason: verdict.reason,
        effect: verdict.effect,
        modelText: modelChannel.modelText,
        machineData: result,
        result,
        resultMeta: {},
        latencyMs: 1,
      } as unknown as ToolBrokerInvokeResult
    },
  } as unknown as ToolBrokerService
}

/**
 * issue #180 WP-3 — a loop saját (nem brokeren átmenő) eszközhívásai is
 * `tool_calls` sort írnak, ezért a fake caps-nak ismernie kell a `createToolCall`
 * metódust. A rögzített sorokat a hívó a `recordedToolCalls` tömbben nézi meg.
 */
type RecordedToolCall = {
  toolName: string
  status: string
  policyDecision: string | null
  argsMeta: Record<string, unknown>
  resultMeta: Record<string, unknown> | null
  conversationId: string | null
  ticketId: string | null
  /** issue #237 / EFF-01 — chat-forduló kötés; ticket-ágon null. */
  agentTurnId: string | null
}

function fakeToolCapsRecording(record: RecordedToolCall[]): ToolBrokerRepository {
  return {
    findConnectorsForAgent: async () => [],
    createToolCall: async (data: Record<string, unknown>) => {
      record.push(data as unknown as RecordedToolCall)
      return data as never
    },
  } as unknown as ToolBrokerRepository
}

const fakeToolCaps = fakeToolCapsRecording([])

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
    // EFF-01: ticket/task-ágon nincs forduló-rekord — agentTurnId üresen marad.
    assert.equal(brokerCalls[0].agentTurnId, undefined)
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

  await check('életjel: lassú modellhívás alatt a futó állapot újra kiadódik (téves „megállt" ellen)', async () => {
    const activities: Array<{ id: string; status: string }> = []
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const slowGateway = {
      call: async () => {
        await sleep(120)
        return { content: 'Kész.', usage: { promptTokens: 1, completionTokens: 1 } }
      },
    } as unknown as ModelGateway
    const result = await runAgentToolLoop({
      gateway: slowGateway,
      toolBroker: fakeToolBroker([]),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 3,
      context: { conversationId: 'conv-hb' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'szia' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: [],
      modelWaitHeartbeatMs: 30,
      onActivity: (event) => {
        activities.push({ id: event.id, status: event.status })
      },
    })

    assert.equal(result.content, 'Kész.')
    const running = activities.filter((a) => a.id === 'reasoning-0' && a.status === 'running')
    assert.ok(running.length >= 2, `ismételt életjel várható, kapott: ${running.length}`)
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
    // #468: mag-toolok sémája + tool_describe; az index-blokk a stabil prefixben.
    assert.deepEqual(gwCalls[0].tools?.map((tool) => tool.name), ['file_read', 'web_search', 'tool_describe'])
    assert.ok(content.some((value) => value.startsWith('Eszközeid.') && value.includes('- file_read [betöltött]')))
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

  await check('run_analyst: driftelt egress nem kerül a modell tool-listájára', async () => {
    const caps = {
      findCapabilitiesForAgent: async () => [
        { toolName: 'run_index', allowed: true },
        { toolName: 'ticket_create', allowed: true },
        { toolName: 'web_search', allowed: true },
        { toolName: 'gmail_send', allowed: true },
        { toolName: 'http_api_request', allowed: true },
      ],
      findConnectorsForAgent: async () => [],
    } as unknown as ToolBrokerRepository
    const allowed = await listAllowedChatTools(caps, 'agent-ra', { systemRole: 'run_analyst' })
    assert.deepEqual(allowed, ['run_index', 'ticket_create'])
    const unlocked = await listAllowedChatTools(caps, 'agent-1')
    assert.ok(unlocked.includes('web_search'))
    assert.ok(unlocked.includes('gmail_send'))
    assert.ok(!unlocked.includes('run_index'))
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
      // issue #195 — a http_api_get kimeneti szerződése a valódi alakot kéri
      // (ok + status + body); a stub ezért a tényleges connector-válasszal felel.
      toolBroker: fakeToolBrokerResult(
        brokerCalls,
        { ok: true, status: 200, body: { customers: largeRows } },
        'external_untrusted',
      ),
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
    // Gépi fogyasztóknak (egyeztetés) nyers JSON kell — NEM EXTERNAL_UNTRUSTED burkolat.
    assert.doesNotMatch(archived[0].content, /EXTERNAL_UNTRUSTED_DATA/)
    assert.equal(archived[0].content.trim().startsWith('{'), true)
    assert.ok(workspaceWrites.has('tool-outputs/01-http_api_get-crm-call.json'))
    const workspaceCopy = workspaceWrites.get('tool-outputs/01-http_api_get-crm-call.json')!
    assert.match(workspaceCopy, /Ügyfél 400/)
    assert.doesNotMatch(workspaceCopy, /EXTERNAL_UNTRUSTED_DATA/)
    assert.ok(JSON.parse(workspaceCopy).body.customers.length === 400)
    const toolMessage = gwCalls[1].messages.find((m) => m.role === 'tool')
    assert.ok(toolMessage)
    assert.match(toolMessage.content, /A teljes eredmény elmentve/)
    assert.match(toolMessage.content, /tool_result_extract/)
    assert.match(toolMessage.content, /tool-outputs\//)
    assert.doesNotMatch(toolMessage.content, /olvasd tovább a tool_result_read/)
    assert.match(toolMessage.content, /Ügyfél 400/)
    assert.match(toolMessage.content, /<<<EXTERNAL_UNTRUSTED_DATA>>>/)
    assert.match(toolMessage.content, /<<<END_EXTERNAL_UNTRUSTED_DATA>>>/)
    assert.ok(toolMessage.content.length < 4000, `előnézet túl hosszú: ${toolMessage.content.length}`)
  })

  await check('nagy tool eredmény: sikertelen archiválás nem nyeli el a teljes eredményt', async () => {
    const archive = createWorkspaceToolResultArchiver(
      { write: async () => { throw new Error('workspace unavailable') } } as never,
      'tenant-1',
      'conv-1',
    )
    await assert.rejects(
      archive({ toolName: 'http_api_get', callId: 'crm-call', turn: 0, content: 'teljes eredmény' }),
      /workspace unavailable/,
    )

    // Loop-szinten: a dobó archiváló NE fordítsa HIBA-ra a már sikeres
    // tool-hívást — partial/csonkolt modelText marad, a gépi adat megmarad.
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const largeRows = Array.from({ length: 400 }, (_, i) => ({
      id: i + 1,
      name: `Ügyfél ${i + 1}`,
      revenue: (i + 1) * 1000,
      note: 'hosszú crm sor '.repeat(8),
    }))
    const activities: Array<{ id: string; status: string; detail?: string }> = []

    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          { toolCalls: [{ id: 'crm-fail-arch', name: 'http_api_get', input: { path: '/customers' } }] },
          { content: 'A CRM listát a csonkolt előnézetből összefoglaltam.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBrokerResult(
        brokerCalls,
        { ok: true, status: 200, body: { customers: largeRows } },
        'external_untrusted',
      ),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-archive-fail' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'milyen ügyfelek vannak?' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['http_api_get'],
      archiveLargeToolResult: async () => {
        throw new Error('workspace unavailable')
      },
      onActivity: (event) => {
        activities.push({ id: event.id, status: event.status, detail: event.detail })
      },
    })

    assert.equal(result.content, 'A CRM listát a csonkolt előnézetből összefoglaltam.')
    assert.equal(brokerCalls.length, 1)
    const toolMessage = gwCalls[1].messages.find((m) => m.role === 'tool')
    assert.ok(toolMessage)
    assert.doesNotMatch(toolMessage.content, /^HIBA:/)
    assert.doesNotMatch(toolMessage.content, /workspace unavailable/)
    assert.match(toolMessage.content, /Ügyfél/)
    const toolActivity = activities.filter((a) => a.id === 'tool-crm-fail-arch')
    assert.ok(toolActivity.some((a) => a.status === 'done'))
    assert.equal(toolActivity.some((a) => a.status === 'error'), false)
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
    assert.ok(written.has(TOOL_LOOP_CHECKPOINT_PATH))
    assert.equal([...written.keys()].filter((path) => path !== TOOL_LOOP_CHECKPOINT_PATH).length, 1)
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
    assert.match(toolMessage.content, /EXTERNAL_UNTRUSTED_DATA/)
    assert.doesNotMatch(toolMessage.content, /nincs ilyen elmentett tool-eredmény/)
  })

  await check('rekord-szelet: a 150. rekord kérhető ki trust-envelope-pal', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const archivePath = '.tool-results/01-http_api_get-rows.json'
    const archiveContent = JSON.stringify({ data: Array.from({ length: 200 }, (_, i) => ({ id: i + 1 })) })
    await runAgentToolLoop({
      gateway: fakeGateway([
        { toolCalls: [{ id: 'read-row', name: 'tool_result_read', input: { path: archivePath, arrayPath: 'data', rowOffset: 149, rowLimit: 1 } }] },
        { content: 'Megvan.' },
      ], gwCalls),
      toolBroker: fakeToolBrokerResult([], {}), toolCaps: fakeToolCaps,
      agentId: 'agent-1', agentVersion: 1, context: { conversationId: 'conv-row-read' }, mode: 'chat',
      messages: [{ role: 'user', content: 'kérem a 150. rekordot' }], modelConfig: MODEL_CONFIG,
      allowedTools: ['http_api_get'],
      archiveLargeToolResult: async () => ({ path: archivePath, bytes: archiveContent.length }),
      listWorkspaceFiles: async () => [archivePath], readWorkspaceFile: async () => archiveContent,
    })
    const toolMessage = gwCalls[1].messages.find((m) => m.role === 'tool')
    assert.ok(toolMessage)
    const result = JSON.parse(toolMessage.content)
    assert.equal(result.rowOffset, 149); assert.equal(result.totalRows, 200); assert.equal(result.returnedRows, 1)
    assert.match(result.rows, /\{"id":150\}/); assert.match(result.rows, /EXTERNAL_UNTRUSTED_DATA/)
  })

  await check('file_read archívum-path esetén tool_result_read/extract felé irányít', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    // Az archívum néhány óriási sorból áll — pont ezért nem korlátoz a file_read
    // soralapú `limit`-je: 20 sor kérése is a teljes tartalmat visszaadná.
    const archivePath = 'tool-outputs/06-http_api_get-order-lines.json'
    const archiveContent = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ i })) })

    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [
              { id: 'read-archive', name: 'file_read', input: { path: archivePath, limit: 20 } },
            ],
          },
          { content: 'Rendben, kivonatot készítek.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-archive-file-read' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'folytasd' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['file_read'],
      archiveLargeToolResult: async () => ({ path: archivePath, bytes: archiveContent.length }),
      listWorkspaceFiles: async () => [archivePath],
      readWorkspaceFile: async (path) => (path === archivePath ? archiveContent : null),
    })

    assert.equal(result.content, 'Rendben, kivonatot készítek.')
    assert.equal(brokerCalls.length, 0, 'az archívumot nem szabad file_read-del beolvasni')
    const toolMessage = gwCalls[1].messages.find((m) => m.role === 'tool')
    assert.ok(toolMessage)
    assert.match(toolMessage.content, /LOOP-GUARD/)
    assert.match(toolMessage.content, /tool_result_read/)
    assert.match(toolMessage.content, /tool_result_extract/)
    // A tartalom NEM kerülhet a kontextusba — ez a fék egyetlen üzleti célja.
    assert.doesNotMatch(toolMessage.content, /"i":399/)
  })

  await check('file_read sima munkaterületi fájlon változatlanul átmegy', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const archivePath = 'tool-outputs/06-http_api_get-order-lines.json'

    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [
              { id: 'read-plain', name: 'file_read', input: { path: 'extract_2026h1.json' } },
            ],
          },
          { content: 'Megvan.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-plain-file-read' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'olvasd be a kivonatot' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['file_read'],
      archiveLargeToolResult: async () => ({ path: archivePath, bytes: 10 }),
      listWorkspaceFiles: async () => [archivePath],
      readWorkspaceFile: async () => null,
    })

    assert.equal(result.content, 'Megvan.')
    assert.equal(brokerCalls.length, 1, 'a nem-archívum fájlt továbbra is a broker olvassa')
    assert.equal(brokerCalls[0].tool, 'file_read')
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

  await check('fallback-attribúció: tartalék modellnél a loop visszaadja a ténylegesen dolgozó modellt', async () => {
    // Mért eset (2026-09-15, SPAR tárgyalási felkészítő): az üzeneten gpt-5.5
    // állt, miközben 52 hívást a deepseek fallback vitt.
    const gwCalls: GatewayCallArgs[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [{ content: 'Kész a feladat.' , fallbackRoute: { provider: 'openrouter', model: 'deepseek/deepseek-x' } }],
        gwCalls,
      ),
      toolBroker: fakeToolBroker([]),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { ticketId: 'ticket-fallback' },
      mode: 'task',
      messages: [{ role: 'user', content: 'adj választ' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: [],
    })

    assert.deepEqual(result.executedModel, { provider: 'openrouter', model: 'deepseek/deepseek-x' })
  })

  await check('fallback-attribúció: fallback nélkül nincs executedModel (a konfigurált modell az igazság)', async () => {
    const result = await runAgentToolLoop({
      gateway: fakeGateway([{ content: 'Kész.' }], []),
      toolBroker: fakeToolBroker([]),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { ticketId: 'ticket-primary' },
      mode: 'task',
      messages: [{ role: 'user', content: 'adj választ' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: [],
    })

    assert.equal(result.executedModel, undefined)
  })

  await check('csonkolt válasz: maxTokens elérésekor a loop rövid folytatásra kér a következő körben', async () => {
    // Mért eset (2026-09-15): 3× pontosan 16 384 completion tokennél vágott a
    // kimenet, észrevétlenül. Az első kör tool-hívást is ad (így lesz második
    // kör), és a usage a korláton áll.
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [{ id: 'c1', name: 'file_read', input: { path: 'a.txt' } }],
            usage: { promptTokens: 10, completionTokens: 100 },
          },
          { content: 'Kész röviden.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { ticketId: 'ticket-truncated' },
      mode: 'task',
      messages: [{ role: 'user', content: 'olvasd be a.txt' }],
      modelConfig: { ...MODEL_CONFIG, maxTokens: 100 },
      allowedTools: ['file_read'],
    })

    assert.equal(result.status, 'completed')
    assert.equal(gwCalls.length, 2)
    const secondMessages = gwCalls[1]!.messages as Array<{ role: string; content?: string }>
    const nudgeIdx = secondMessages.findIndex(
      (m) => m.role === 'system' && (m.content ?? '').includes('CSONKOLT VÁLASZ'),
    )
    const assistantIdx = secondMessages.findIndex((m) => m.role === 'assistant')
    assert.ok(nudgeIdx >= 0, 'a második körben ott a csonkolás-nudge')
    assert.ok(nudgeIdx > assistantIdx, 'a nudge a csonkolt asszisztens-üzenet UTÁN áll')
  })

  await check('csonkolt válasz: tool-hívás nélküli végső válasznál a felhasználó jelzést kap', async () => {
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [{ content: 'Hosszú válasz eleje', usage: { promptTokens: 10, completionTokens: 100 } }],
        [],
      ),
      toolBroker: fakeToolBroker([]),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { ticketId: 'ticket-truncated-final' },
      mode: 'task',
      messages: [{ role: 'user', content: 'írj sokat' }],
      modelConfig: { ...MODEL_CONFIG, maxTokens: 100 },
      allowedTools: [],
    })
    assert.equal(result.status, 'completed')
    assert.match(result.content, /Hosszú válasz eleje/)
    assert.match(result.content, /hosszkorlátjánál \(100 token\) megszakadt/)
  })

  await check('csonkolt válasz: korlát alatti completionnél nincs nudge', async () => {
    const gwCalls: GatewayCallArgs[] = []
    await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [{ id: 'c1', name: 'file_read', input: { path: 'a.txt' } }],
            usage: { promptTokens: 10, completionTokens: 50 },
          },
          { content: 'Kész.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker([]),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { ticketId: 'ticket-not-truncated' },
      mode: 'task',
      messages: [{ role: 'user', content: 'olvasd be a.txt' }],
      modelConfig: { ...MODEL_CONFIG, maxTokens: 100 },
      allowedTools: ['file_read'],
    })

    assert.equal(gwCalls.length, 2)
    const secondMessages = gwCalls[1]!.messages as Array<{ role: string; content?: string }>
    assert.ok(
      secondMessages.every((m) => !(m.content ?? '').includes('CSONKOLT VÁLASZ')),
      'korlát alatt nincs nudge',
    )
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

  // ── issue #180 ─────────────────────────────────────────────────────────────

  await check('WP-3: a tool_result_read a tool_calls táblába is bekerül (internal jelöléssel)', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const recorded: RecordedToolCall[] = []
    const archivePath = '.tool-results/01-http_api_get-prev.json'
    const archiveContent = JSON.stringify({ hello: 'archived', pad: 'x'.repeat(200) })

    await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [
              {
                id: 'read-1',
                name: 'tool_result_read',
                input: { path: archivePath, offset: 0, limit: 500 },
              },
            ],
          },
          { content: 'Megvan.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker([]),
      toolCaps: fakeToolCapsRecording(recorded),
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-180', agentTurnId: 'turn-180' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'olvasd vissza' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['http_api_get'],
      archiveLargeToolResult: async () => ({ path: archivePath, bytes: archiveContent.length }),
      listWorkspaceFiles: async () => [archivePath],
      readWorkspaceFile: async (path) => (path === archivePath ? archiveContent : null),
    })

    // Mért eset: a visszaolvasások nem a brokeren mentek át, ezért egyetlen
    // `tool_calls` sor sem keletkezett róluk — pont a kárt okozó hívásokról nem.
    const reads = recorded.filter((call) => call.toolName === 'tool_result_read')
    assert.equal(reads.length, 1, 'a visszaolvasásról kell tool_calls sor')
    assert.equal(reads[0].status, 'ok')
    assert.equal(reads[0].policyDecision, 'internal')
    assert.equal(reads[0].conversationId, 'conv-180')
    // EFF-01 / issue #237 — belső hívás is a saját fordulóhoz köt.
    assert.equal(reads[0].agentTurnId, 'turn-180')
    assert.equal(reads[0].argsMeta.path, archivePath)
    assert.equal(reads[0].argsMeta.returned_chars, archiveContent.length)
    assert.equal(reads[0].argsMeta.total_chars, archiveContent.length)
  })

  await check('EFF-01: broker-út tool-hívása megkapja az agentTurnId-t', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const result = await runAgentToolLoop({
      gateway: fakeGateway(
        [
          { toolCalls: [{ id: 'c1', name: 'file_read', input: { path: 'a.txt' } }] },
          { content: 'Kész.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker(brokerCalls),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-eff-01', agentTurnId: 'turn-eff-01' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'olvasd' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['file_read'],
    })

    assert.equal(result.content, 'Kész.')
    assert.equal(brokerCalls.length, 1)
    assert.equal(brokerCalls[0].tool, 'file_read')
    assert.equal(brokerCalls[0].conversationId, 'conv-eff-01')
    assert.equal(brokerCalls[0].agentTurnId, 'turn-eff-01')
    assert.equal(brokerCalls[0].ticketId, undefined)
  })

  await check('WP-3: hiányzó archívum és a fékbe futott visszaolvasás is naplózódik', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const recorded: RecordedToolCall[] = []

    await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [
              {
                id: 'read-missing',
                name: 'tool_result_read',
                input: { path: '.tool-results/nincs-ilyen.json', offset: 0, limit: 100 },
              },
            ],
          },
          { content: 'Nem találtam.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker([]),
      toolCaps: fakeToolCapsRecording(recorded),
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-180-missing' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'olvasd vissza' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['http_api_get'],
      listWorkspaceFiles: async () => [],
      readWorkspaceFile: async () => null,
    })

    const reads = recorded.filter((call) => call.toolName === 'tool_result_read')
    assert.equal(reads.length, 1)
    assert.equal(reads[0].status, 'error')
    assert.equal(reads[0].policyDecision, 'internal')
    assert.equal(reads[0].resultMeta?.archive_missing, true)
  })

  await check('WP-3: a load_skill hívás is tool_calls sort ír (skill-verzió + karakterszám)', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const recorded: RecordedToolCall[] = []
    const instructions = 'A skill teljes instrukciója.'

    await runAgentToolLoop({
      gateway: fakeGateway(
        [
          {
            toolCalls: [
              { id: 'skill-1', name: 'load_skill', input: { skillVersionId: 'skill-v-1' } },
            ],
          },
          { content: 'Betöltve.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker([]),
      toolCaps: fakeToolCapsRecording(recorded),
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-180-skill' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'töltsd be a skillt' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: [],
      skillIndexPrompt: 'skill-index',
      loadSkill: async () => ({ ok: true, instructions }),
    })

    const loads = recorded.filter((call) => call.toolName === 'load_skill')
    assert.equal(loads.length, 1)
    assert.equal(loads[0].status, 'ok')
    assert.equal(loads[0].policyDecision, 'internal')
    assert.equal(loads[0].argsMeta.skill_version_id, 'skill-v-1')
    assert.equal(loads[0].argsMeta.returned_chars, instructions.length)
  })

  /**
   * A grant-kapu nem egy providerhez szól: ugyanaz a leállás + kártya jár egy
   * regisztrált (Gmail) és egy regiszterben NEM szereplő delegált connectornak
   * (generikus OAuth-os http_api) is.
   */
  for (const scenario of [
    {
      title: 'regisztrált provider (Gmail)',
      tool: 'gmail_search' as const,
      // Eszközönként ÉRVÉNYES args kell: a séma különben a broker ELŐTT dob, és a
      // grant-kártya-ág sosem fut le (gmail_search: query=string; http_api_get: path).
      input: { query: 'x' } as Record<string, unknown>,
      reason: 'connector_grant_missing',
      prompt: 'hány olvasatlan levelem van?',
      expectedConnectorType: 'gmail',
    },
    {
      title: 'generikus OAuth-connector (http_api)',
      tool: 'http_api_get' as const,
      input: { path: '/me' } as Record<string, unknown>,
      reason: 'connector_scope_not_granted',
      prompt: 'kérdezd le a saját fiókom adatait',
      expectedConnectorType: undefined,
    },
  ]) {
    await check(
      `grant-hiány (${scenario.title}): a loop megáll, kártyát ad, nem hívja újra az eszközt`,
      async () => {
        const gwCalls: GatewayCallArgs[] = []
        const brokerCalls: ToolBrokerInvokeInput[] = []
        const grants: Array<{ connectorId: string; toolName: string; reason: string }> = []
        const connectorId = '11111111-1111-4111-8111-111111111111'
        const broker: ToolBrokerService = {
          invoke: async (input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> => {
            brokerCalls.push(input)
            return {
              denied: true,
              reason: scenario.reason,
              connectorId,
              latencyMs: 1,
              outcome: 'failed',
            }
          },
        } as unknown as ToolBrokerService

        const result = await runAgentToolLoop({
          gateway: fakeGateway(
            [
              { toolCalls: [{ id: 'c1', name: scenario.tool, input: scenario.input }] },
              { content: 'Hozzáférés kell — a gomb a chatben jelenik meg.' },
            ],
            gwCalls,
          ),
          toolBroker: broker,
          toolCaps: fakeToolCaps,
          agentId: 'agent-1',
          agentVersion: 1,
          context: { conversationId: 'conv-grant' },
          mode: 'chat',
          messages: [{ role: 'user', content: scenario.prompt }],
          modelConfig: MODEL_CONFIG,
          allowedTools: [scenario.tool],
          onConnectorGrantNeeded: (event) => {
            grants.push(event)
          },
        })

        assert.equal(brokerCalls.length, 1, 'az eszközt csak egyszer hívja')
        assert.equal(result.awaitingConnectorGrant, true)
        assert.equal(result.connectorGrantNeeds?.length, 1)
        assert.equal(result.connectorGrantNeeds?.[0]?.connectorId, connectorId)
        assert.equal(result.connectorGrantNeeds?.[0]?.reason, scenario.reason)
        assert.equal(result.connectorGrantNeeds?.[0]?.connectorType, scenario.expectedConnectorType)
        assert.equal(grants.length, 1)
        assert.ok(
          gwCalls.some((call) =>
            call.messages.some(
              (m) =>
                m.role === 'system' &&
                typeof m.content === 'string' &&
                m.content.includes('Hozzáférés megadása'),
            ),
          ),
          'a záró prompt a gombra utal',
        )
      },
    )
  }

  await check('WP-1: az onTurnStart a kör eleji számlálókat is átadja', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const seen: Array<{ turn: number; toolCallCount: number; deniedCount: number }> = []

    await runAgentToolLoop({
      gateway: fakeGateway(
        [
          { toolCalls: [{ id: 'c1', name: 'file_read', input: { path: 'a.txt' } }] },
          { toolCalls: [{ id: 'c2', name: 'file_read', input: { path: 'b.txt' } }] },
          { content: 'Kész.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBroker([]),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-180-counters' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'olvasd be' }],
      modelConfig: MODEL_CONFIG,
      allowedTools: ['file_read'],
      onTurnStart: (turn, counters) => {
        seen.push({ turn, ...counters })
      },
    })

    // A kör eleji állás a MEGELŐZŐ körök összesítése — enélkül a futó forduló
    // rekordja nullát mutatna, amíg a futás el nem száll.
    assert.deepEqual(
      seen.map((s) => s.toolCallCount),
      [0, 1, 2],
    )
    assert.ok(seen.every((s) => s.deniedCount === 0))
  })

  // #468 — halasztott tool-betöltés (deferred-tool-loading-spec §6).
  await check('deferred tools: index + tool_describe → aktiválás; D5 közvetlen hívás; nem grantolt séma nem szivárog; D4/D8 determinizmus', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    const run = (responses: FakeResponse[], priorToolNames?: string[]) =>
      runAgentToolLoop({
        gateway: fakeGateway(responses, gwCalls),
        toolBroker: fakeToolBrokerResult(brokerCalls, { ok: true, path: 'x.xlsx' }),
        toolCaps: fakeToolCaps,
        agentId: 'agent-1',
        agentVersion: 1,
        context: { conversationId: 'conv-1' },
        mode: 'chat',
        messages: [{ role: 'user', content: 'Excel' }],
        modelConfig: MODEL_CONFIG,
        allowedTools: ['file_read', 'xlsx_append_rows', 'xlsx_create', 'xlsx_write_cells'],
        ...(priorToolNames ? { priorToolNames } : {}),
      })
    const toolNames = (i: number) => gwCalls[i].tools?.map((t) => t.name) ?? []
    const indexOf = (i: number) =>
      gwCalls[i].messages.find((m) => 'content' in m && m.content?.startsWith('Eszközeid.'))?.content ?? ''

    await run([
      { toolCalls: [{ id: 'd1', name: 'tool_describe', input: { names: ['xlsx_create', 'gmail_send', 'nincs_ilyen'] } }] },
      { toolCalls: [{ id: 'c1', name: 'xlsx_create', input: { path: 'x.xlsx', sheets: [{ name: 'A' }] } }] },
      { toolCalls: [{ id: 'c2', name: 'xlsx_write_cells', input: { path: 'x.xlsx', sheet: 'A', changes: [{ cell: 'A1', value: 1 }] } }] },
      { toolCalls: [{ id: 'c3', name: 'xlsx_append_rows', input: { path: 'x.xlsx' } }] },
      { content: 'Kész.' },
    ])
    // 1. kör: csak a mag-tool sémája + tool_describe; az index mindent felsorol.
    assert.deepEqual(toolNames(0), ['file_read', 'tool_describe'])
    assert.ok(indexOf(0).includes('- file_read [betöltött]') && indexOf(0).includes('- xlsx_create — '))
    // describe-válasz: grantolt → séma; nem grantolt / ismeretlen → „nem elérhető", séma nélkül.
    const describeMsg = gwCalls[1].messages.find((m) => m.role === 'tool' && m.toolCallId === 'd1')
    assert.ok(describeMsg && 'content' in describeMsg)
    const described = JSON.parse(describeMsg.content as string) as Array<Record<string, unknown>>
    assert.equal(described[0].name, 'xlsx_create')
    assert.ok(described[0].parameters)
    assert.deepEqual(described[1], { name: 'gmail_send', error: 'nem elérhető' })
    assert.deepEqual(described[2], { name: 'nincs_ilyen', error: 'nem elérhető' })
    // 2. kör: xlsx_create aktiválva; xlsx_write_cells még nem.
    assert.deepEqual(toolNames(1), ['file_read', 'xlsx_create', 'tool_describe'])
    // D5: le nem írt xlsx_write_cells közvetlen hívása lefut a brokeren és aktivál.
    assert.deepEqual(brokerCalls.map((c) => c.tool), ['xlsx_create', 'xlsx_write_cells'])
    assert.deepEqual(toolNames(3), ['file_read', 'xlsx_create', 'xlsx_write_cells', 'tool_describe'])
    // D5 tipp-sor: CSAK le nem írt tool hibás args-ánál (nem grantolt hívás → változatlan ELUTASÍTVA).
    const c3 = gwCalls[4].messages.find((m) => m.role === 'tool' && m.toolCallId === 'c3')
    assert.ok(c3 && 'content' in c3 && (c3.content as string).startsWith('HIBA: Tipp: a pontos sémáért hívd a tool_describe'))
    assert.ok(!(gwCalls[4].messages.find((m) => m.role === 'tool' && m.toolCallId === 'c2') as { content: string }).content.includes('Tipp:'))
    const firstRun = gwCalls.length
    // D4: priorToolNames → discovery nélkül aktív; D8: az index-blokk mégis azonos.
    await run([{ content: 'Kész.' }], ['xlsx_write_cells'])
    assert.deepEqual(toolNames(firstRun), ['file_read', 'xlsx_write_cells', 'tool_describe'])
    assert.equal(indexOf(firstRun), indexOf(0))
  })

  await check('tool_describe: skill-hatókörön kívüli grantolt tool sémája NEM adódik ki (describe = hívhatóság)', async () => {
    const gwCalls: GatewayCallArgs[] = []
    const brokerCalls: ToolBrokerInvokeInput[] = []
    await runAgentToolLoop({
      gateway: fakeGateway(
        [
          { toolCalls: [{ id: 'd1', name: 'tool_describe', input: { names: ['xlsx_create', 'xlsx_write_cells'] } }] },
          { content: 'Kész.' },
        ],
        gwCalls,
      ),
      toolBroker: fakeToolBrokerResult(brokerCalls, { ok: true, path: 'x.xlsx' }),
      toolCaps: fakeToolCaps,
      agentId: 'agent-1',
      agentVersion: 1,
      context: { conversationId: 'conv-1' },
      mode: 'chat',
      messages: [{ role: 'user', content: 'Excel' }],
      modelConfig: MODEL_CONFIG,
      // Grant: mindkettő; a betöltött skill hatóköre viszont CSAK xlsx_create.
      allowedTools: ['file_read', 'xlsx_create', 'xlsx_write_cells'],
      initialSkillToolScope: ['xlsx_create'],
    })
    const describeMsg = gwCalls[1].messages.find((m) => m.role === 'tool' && m.toolCallId === 'd1')
    assert.ok(describeMsg && 'content' in describeMsg)
    const described = JSON.parse(describeMsg.content as string) as Array<Record<string, unknown>>
    // Hatókörön belüli → séma; hatókörön kívüli (bár grantolt) → „nem elérhető", séma nélkül.
    assert.equal(described[0].name, 'xlsx_create')
    assert.ok(described[0].parameters)
    assert.deepEqual(described[1], { name: 'xlsx_write_cells', error: 'nem elérhető' })
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
