/**
 * RA-06 — `run_stats` tool (aggregátumok, eszköz × kimenetel mátrix).
 * Futtatás: npm run test:run-stats
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildLatencyByTool,
  buildPromptCacheStats,
  buildToolOutcomeMatrixFromGroups,
  computeRepeatedSourceKeys,
  matrixOutcomeLabel,
  percentile,
} from '../src/domain/run-analysis/run-stats-service'
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

async function main() {
  console.log('=== RA-06 run_stats ===')

  await test('matrixOutcomeLabel: denied státusz külön kategória', () => {
    assert.equal(matrixOutcomeLabel('denied', 'failed'), 'denied')
    assert.equal(matrixOutcomeLabel('ok', 'empty'), 'empty')
    assert.equal(matrixOutcomeLabel('ok', null), 'unknown')
  })

  await test('buildToolOutcomeMatrixFromGroups: arány eszközönként', () => {
    const matrix = buildToolOutcomeMatrixFromGroups([
      { toolName: 'file_read', status: 'ok', outcome: 'ok', count: 2 },
      { toolName: 'file_read', status: 'ok', outcome: 'empty', count: 1 },
      { toolName: 'file_read', status: 'denied', outcome: 'failed', count: 1 },
    ])
    assert.equal(matrix.length, 1)
    assert.equal(matrix[0]!.totalCalls, 4)
    const ok = matrix[0]!.outcomes.find((o) => o.outcome === 'ok')
    assert.equal(ok?.count, 2)
    assert.equal(ok?.ratio, 0.5)
    const denied = matrix[0]!.outcomes.find((o) => o.outcome === 'denied')
    assert.equal(denied?.count, 1)
  })

  await test('buildPromptCacheStats: null cache ≠ nincs találat', () => {
    const stats = buildPromptCacheStats({
      measuredCalls: 1,
      unmeasuredCalls: 1,
      promptTokens: 1000,
      cachedPromptTokens: 400,
    })
    assert.equal(stats.measuredCalls, 1)
    assert.equal(stats.unmeasuredCalls, 1)
    assert.equal(stats.hitRatio, 0.4)
  })

  await test('buildPromptCacheStats: nincs mért sor → hitRatio null', () => {
    const stats = buildPromptCacheStats({
      measuredCalls: 0,
      unmeasuredCalls: 1,
      promptTokens: 0,
      cachedPromptTokens: 0,
    })
    assert.equal(stats.hitRatio, null)
  })

  await test('buildLatencyByTool: p50/p90 eloszlás', () => {
    const rows = buildLatencyByTool([
      { toolName: 'kb_search', latencyMs: 10 },
      { toolName: 'kb_search', latencyMs: 20 },
      { toolName: 'kb_search', latencyMs: 100 },
      { toolName: 'kb_search', latencyMs: 200 },
    ])
    assert.equal(rows[0]!.toolName, 'kb_search')
    assert.equal(rows[0]!.p50Ms, percentile([10, 20, 100, 200], 0.5))
    assert.equal(rows[0]!.p90Ms, percentile([10, 20, 100, 200], 0.9))
  })

  await test('computeRepeatedSourceKeys: toolCallSourceKey ismétlés futásonként', () => {
    const base = Date.parse('2026-07-29T10:00:00Z')
    const path = 'feldolgozott-tulajdoni-lap.json'
    const rows = Array.from({ length: 133 }, (_, i) => ({
      agentTurnId: 'turn-incident',
      ticketId: null,
      toolName: 'file_read',
      argsMeta: { path, offset: i * 1000, limit: 1000 },
      resultMeta: {},
      createdAt: new Date(base + i * 1000),
    }))
    const { keys } = computeRepeatedSourceKeys(rows)
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.readCount, 133)
    assert.equal(keys[0]!.rereadCount, 132)
    assert.match(keys[0]!.sourceKey, /file_read:path:/)
  })

  await test('computeRepeatedSourceKeys: külön futások nem keverednek', () => {
    const base = Date.parse('2026-08-01T00:00:00Z')
    const { keys } = computeRepeatedSourceKeys([
      {
        agentTurnId: 'turn-a',
        ticketId: null,
        toolName: 'file_read',
        argsMeta: { path: 'a.json' },
        resultMeta: {},
        createdAt: new Date(base),
      },
      {
        agentTurnId: 'turn-a',
        ticketId: null,
        toolName: 'file_read',
        argsMeta: { path: 'a.json' },
        resultMeta: {},
        createdAt: new Date(base + 1000),
      },
      {
        agentTurnId: 'turn-b',
        ticketId: null,
        toolName: 'file_read',
        argsMeta: { path: 'a.json' },
        resultMeta: {},
        createdAt: new Date(base + 2000),
      },
    ])
    assert.equal(keys[0]!.readCount, 3)
    assert.equal(keys[0]!.rereadCount, 1)
    assert.equal(keys[0]!.runCount, 2)
  })

  await test('registry: run_stats chat-only, external_untrusted, Futás-elemzés csoport', () => {
    const d = TOOL_REGISTRY.run_stats
    assert.deepEqual(d.surfaces, ['chat'])
    assert.equal(d.sideEffecting, false)
    assert.equal(d.trust, 'external_untrusted')
    assert.equal(d.capabilityGroup, TOOL_GROUP_ANALYSIS)
    assert.equal(d.handlerId, 'run_stats')
    assert.equal(TOOL_TRUST_REGISTRY.run_stats, 'external_untrusted')
    assert.equal(SIDE_EFFECTING_TOOLS.run_stats, false)
  })

  await test('forrásszerződés: RA-03 szkóp + run_analyst kizárás + audit', () => {
    const src = readFileSync(
      join(root, 'src/domain/run-analysis/run-stats-service.ts'),
      'utf8',
    )
    assert.match(src, /runIndexService\.resolveScope/)
    assert.match(src, /MAX_STATS_SOURCE_KEY_SAMPLE/)
    assert.match(src, /analysis\.run_stats/)
    assert.match(src, /toolCallSourceKey/)
    // A latency / process-ticket plafon nem lehet néma — a modellnek látnia kell.
    assert.match(src, /latencyByToolTruncated/)
    assert.match(src, /processTicketIndexTruncated/)
  })

  await test('forrásszerződés: run_index resolveScope kiszervezve', () => {
    const src = readFileSync(
      join(root, 'src/domain/run-analysis/run-index-service.ts'),
      'utf8',
    )
    assert.match(src, /async resolveScope/)
  })

  if (failures > 0) {
    console.error(`\n${failures} hiba`)
    process.exit(1)
  }
  console.log('\nMinden run_stats teszt OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
