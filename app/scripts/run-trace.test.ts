/**
 * RA-04 — `run_trace` tool (lapozott idővonal, chat/ticket ág).
 * Futtatás: npm run test:run-trace
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  RUN_TRACE_MAX_OUTPUT_CHARS,
  RUN_TRACE_NOT_FOUND,
  RunTraceNotFoundError,
  aggregateToolCallsByToolAndOutcome,
  applyTraceFilters,
  buildTimeline,
  buildTokenCurve,
  buildTraceSummary,
  estimateTraceOutputChars,
} from '../src/domain/run-analysis/run-trace-service'
import {
  TOOL_GROUP_ANALYSIS,
  TOOL_REGISTRY,
} from '../src/domain/tool-broker/tool-registry'
import { SIDE_EFFECTING_TOOLS, TOOL_TRUST_REGISTRY } from '../src/domain/tool-broker/tool-trust-registry'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function syntheticTurnRun(toolCallCount: number) {
  const base = Date.parse('2026-08-01T10:00:00Z')
  const toolCalls = Array.from({ length: toolCallCount }, (_, i) => ({
    id: `tc-${i}`,
    agentTurnId: 'turn-1',
    toolName: i % 3 === 0 ? 'file_read' : i % 3 === 1 ? 'kb_search' : 'http_api_get',
    status: i % 17 === 0 ? 'error' : 'ok',
    outcome: i % 17 === 0 ? 'failed' : i % 11 === 0 ? 'empty' : 'ok',
    policyDecision: 'allowed',
    trustClass: 'external_untrusted',
    argsMeta: { path: `file-${i}.json` },
    resultMeta: { result_chars: 120 },
    effectSummary: null,
    latencyMs: 40 + (i % 5),
    createdAt: new Date(base + i * 1_000),
  }))
  const modelCalls = Array.from({ length: 40 }, (_, i) => ({
    id: `mc-${i}`,
    agentTurnId: 'turn-1',
    provider: 'openai',
    model: 'gpt-4.1',
    promptTokens: 1000 + i * 50,
    completionTokens: 100 + i * 3,
    cachedPromptTokens: i % 4 === 0 ? 800 : null,
    latencyMs: 500,
    status: 'ok',
    createdAt: new Date(base + i * 3_700),
  }))
  return {
    grain: 'turn' as const,
    runId: 'turn-1',
    agentId: 'agent-1',
    agentName: 'Réka Agent',
    conversationId: 'conv-1',
    ticketId: null,
    startedAt: new Date(base),
    finishedAt: new Date(base + toolCallCount * 1_000 + 60_000),
    status: 'completed',
    turnCount: 40,
    deniedCount: 2,
    modelCalls,
    toolCalls,
    messages: [
      {
        id: 'msg-u',
        role: 'user',
        seq: 1,
        content: 'Elemezd a futást',
        createdAt: new Date(base),
      },
      {
        id: 'msg-a',
        role: 'assistant',
        seq: 2,
        content: 'Rendben, megnézem.',
        createdAt: new Date(base + 120_000),
      },
    ],
    activities: [
      { turnId: 'turn-1', stepIndex: 0, activity: { kind: 'reasoning', title: 'Terv' }, at: new Date(base) },
    ],
    audit: [
      {
        action: 'tool.invoke',
        targetType: 'tool',
        targetId: 'file_read',
        policyDecision: 'allowed',
        createdAt: new Date(base + 5_000),
      },
    ],
  }
}

async function main() {
  console.log('=== RA-04 run_trace ===')

  await test('RunTraceNotFoundError: run_not_found üzenet', () => {
    const err = new RunTraceNotFoundError()
    assert.equal(err.message, RUN_TRACE_NOT_FOUND)
  })

  await test('registry: run_trace chat-only, external_untrusted, Futás-elemzés csoport', () => {
    const d = TOOL_REGISTRY.run_trace
    assert.deepEqual(d.surfaces, ['chat'])
    assert.equal(d.sideEffecting, false)
    assert.equal(d.trust, 'external_untrusted')
    assert.equal(d.capabilityGroup, TOOL_GROUP_ANALYSIS)
    assert.equal(d.handlerId, 'run_trace')
    assert.equal(TOOL_TRUST_REGISTRY.run_trace, 'external_untrusted')
    assert.equal(SIDE_EFFECTING_TOOLS.run_trace, false)
  })

  await test('150 eszközhívás: summary belefér a méret-korlátba', () => {
    const run = syntheticTurnRun(150)
    const summary = buildTraceSummary(run)
    assert.equal(summary.toolCallCount, 150)
    assert.equal(summary.turnCount, 40)
    const result = { view: 'summary' as const, runId: run.runId, grain: run.grain, summary }
    const chars = estimateTraceOutputChars(result)
    assert.ok(chars <= RUN_TRACE_MAX_OUTPUT_CHARS, `summary túl nagy: ${chars} > ${RUN_TRACE_MAX_OUTPUT_CHARS}`)
    assert.ok(summary.toolCallsByToolAndOutcome.length > 0)
    assert.ok(summary.nonOkToolCalls.length > 0)
  })

  await test('timeline: 150 hívás lapozással végigjárható', () => {
    const run = syntheticTurnRun(150)
    const timeline = buildTimeline(run)
    assert.ok(timeline.length >= 150)

    const pageSize = 50
    let offset = 0
    let seenToolCalls = 0
    while (offset < timeline.length) {
      const slice = timeline.slice(offset, offset + pageSize)
      assert.ok(slice.length <= pageSize)
      seenToolCalls += slice.filter((e) => e.kind === 'tool_call').length
      offset += pageSize
    }
    assert.equal(seenToolCalls, 150)
  })

  await test('aggregateToolCallsByToolAndOutcome: eszköznév × kimenetel', () => {
    const agg = aggregateToolCallsByToolAndOutcome([
      { toolName: 'file_read', outcome: 'ok' },
      { toolName: 'file_read', outcome: 'ok' },
      { toolName: 'file_read', outcome: 'empty' },
      { toolName: 'kb_search', outcome: 'ok' },
    ])
    assert.equal(agg.find((r) => r.toolName === 'file_read' && r.outcome === 'ok')?.count, 2)
    assert.equal(agg.find((r) => r.toolName === 'file_read' && r.outcome === 'empty')?.count, 1)
  })

  await test('applyTraceFilters: eszköznév és outcome szűrés', () => {
    const run = syntheticTurnRun(20)
    const timeline = buildTimeline(run)
    const filtered = applyTraceFilters(timeline, { grain: 'turn', runId: 'x', toolName: 'file_read' })
    assert.ok(filtered.every((e) => e.kind !== 'tool_call' || e.toolName === 'file_read'))
    const nonOk = applyTraceFilters(timeline, { grain: 'turn', runId: 'x', outcome: 'failed' })
    assert.ok(nonOk.every((e) => e.kind !== 'tool_call' || e.outcome === 'failed'))
  })

  await test('buildTokenCurve: modellhívások időrendben', () => {
    const curve = buildTokenCurve([
      {
        createdAt: new Date('2026-08-01T10:00:01Z'),
        promptTokens: 100,
        completionTokens: 10,
        cachedPromptTokens: null,
      },
      {
        createdAt: new Date('2026-08-01T10:00:00Z'),
        promptTokens: 50,
        completionTokens: 5,
        cachedPromptTokens: 20,
      },
    ])
    assert.equal(curve[0]!.at, '2026-08-01T10:00:00.000Z')
    assert.equal(curve[1]!.promptTokens, 100)
  })

  await test('forrásszerződés: run_analyst kizárás + audit analysis.run_trace', () => {
    const src = readFileSync(
      join(root, 'src/domain/run-analysis/run-trace-service.ts'),
      'utf8',
    )
    assert.match(src, /RUN_ANALYST_SYSTEM_ROLE/)
    assert.match(src, /analysis\.run_trace/)
    assert.match(src, /RunIndexNotFoundError/)
  })

  if (failures > 0) {
    console.error(`\n${failures} hiba`)
    process.exit(1)
  }
  console.log('\nMinden run_trace teszt OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
