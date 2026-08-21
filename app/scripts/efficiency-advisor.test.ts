/**
 * issue #237 / EFF-04 — a hatékonysági tanácsadó detektor tesztje.
 * Futtatás: npm run test:efficiency-advisor
 *
 * A mérce a MÉRT eset (2026-07-29): 149 eszközhívásból 132 újraolvasás, 40 kör,
 * monoton növő prompt. Az elfogadási feltétel kétirányú: ez az alak kiváltja
 * az újraolvasás és a kontextus-hízás mintát; egy normál, 3–5 eszközhívásos,
 * 2 modellhívásos futás viszont NEM. A fékbe futott (blocked) sorok és a
 * toolCallSourceKey-ismétlések is beleszámítanak az újraolvasási arányba.
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_CONTEXT_COMPACTION_LIMITS,
  resolveContextCompactionLimits,
} from '../src/domain/agent/context-compactor'
import {
  EFFICIENCY_ADVISOR_THRESHOLDS,
  describeEfficiencyPattern,
  describeEfficiencyStatus,
  evaluateEfficiencyAdvisor,
  resolveEfficiencyAdvisorThresholds,
  type EfficiencyRun,
  type EfficiencyRunModelCall,
  type EfficiencyRunToolCall,
} from '../src/domain/agent/efficiency-advisor'
import {
  SOURCE_INGEST_DEFAULTS,
  resolveSourceIngestLimits,
} from '../src/domain/agent/loop-stop-decision'

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

function modelCall(partial: Partial<EfficiencyRunModelCall> & { promptTokens: number }): EfficiencyRunModelCall {
  return {
    createdAt: partial.createdAt ?? 0,
    promptTokens: partial.promptTokens,
    completionTokens: partial.completionTokens ?? 200,
    cachedPromptTokens: partial.cachedPromptTokens === undefined ? 0 : partial.cachedPromptTokens,
    costEstimate: partial.costEstimate ?? 0.02,
    model: partial.model ?? 'gpt-5.4',
  }
}

function incidentRun(id: string): EfficiencyRun {
  const modelCalls: EfficiencyRunModelCall[] = Array.from({ length: 40 }, (_, i) =>
    modelCall({
      createdAt: i,
      promptTokens: 21_000 + i * 3_400,
      completionTokens: 400,
      cachedPromptTokens: 0,
      costEstimate: 0.08,
    }),
  )
  const toolCalls: EfficiencyRunToolCall[] = [
    ...Array.from({ length: 17 }, (_, i) => ({
      toolName: 'file_read',
      argsMeta: { path: `forras-${i}.json` },
      resultMeta: { result_chars: 8_000 },
    })),
    ...Array.from({ length: 100 }, () => ({
      toolName: 'tool_result_read',
      argsMeta: { path: '.tool-results/a.json', returned_chars: 40_000 },
      resultMeta: { redundant: true, result_chars: 40_000 },
    })),
    ...Array.from({ length: 32 }, () => ({
      toolName: 'tool_result_read',
      argsMeta: { path: '.tool-results/a.json', returned_chars: 0 },
      resultMeta: { blocked: true, result_chars: 0 },
    })),
  ]
  return { id, kind: 'turn', modelCalls, toolCalls }
}

function normalRun(id: string): EfficiencyRun {
  return {
    id,
    kind: 'turn',
    modelCalls: [
      modelCall({ createdAt: 1, promptTokens: 2_000, completionTokens: 300, cachedPromptTokens: 800 }),
      modelCall({ createdAt: 2, promptTokens: 2_400, completionTokens: 350, cachedPromptTokens: 900 }),
    ],
    toolCalls: [
      { toolName: 'file_read', argsMeta: { path: 'a.json' }, resultMeta: { result_chars: 1_200 } },
      { toolName: 'kb_search', argsMeta: { query: 'novaj' }, resultMeta: { result_chars: 800 } },
      { toolName: 'file_write', argsMeta: { path: 'out.md' }, resultMeta: { result_chars: 400 } },
      { toolName: 'xlsx_append_rows', argsMeta: { path: 'lap.xlsx' }, resultMeta: { result_chars: 200 } },
    ],
  }
}

async function main() {
  console.log('=== hatékonysági tanácsadó (issue #237) ===')

  await check('a mért incidens (132/149 újraolvasás, 40 kör) kiváltja a két mintát', () => {
    const card = evaluateEfficiencyAdvisor([incidentRun('a'), incidentRun('b'), incidentRun('c')])
    assert.equal(card.status, 'findings')
    const kinds = card.patterns.map((p) => p.kind)
    assert.ok(kinds.includes('repeated_reread'), `hiányzik az újraolvasás: ${kinds.join(',')}`)
    assert.ok(kinds.includes('context_bloat'), `hiányzik a hízás: ${kinds.join(',')}`)
    const reread = card.patterns.find((p) => p.kind === 'repeated_reread')
    assert.ok(reread)
    // 3 futás × 132 újraolvasás / 149 olvasó — a merge összeadja a darabszámokat,
    // az arányt átlagolja.
    assert.equal(reread?.metric.rereadCalls, 132 * 3)
    assert.equal(reread?.metric.readCalls, 149 * 3)
    assert.equal(Number(reread?.metric.rereadRatio), Number((132 / 149).toFixed(4)))
    assert.ok(typeof reread?.metric.rereadChars === 'number' && (reread.metric.rereadChars as number) > 0)
    assert.ok(typeof reread?.metric.rereadTokens === 'number' && (reread.metric.rereadTokens as number) > 0)
    // ~4 karakter/token — ugyanaz a becslés, mint a turn-cost-signals.ts
    assert.equal(
      reread?.metric.rereadTokens,
      Math.round((reread?.metric.rereadChars as number) / 4),
    )
    for (const pattern of card.patterns) {
      if (!pattern.savingsTokens) continue
      assert.ok(
        pattern.savingsTokens.high <= card.breakdown.total,
        `${pattern.kind} sávja (${pattern.savingsTokens.high}) nagyobb a költségnél (${card.breakdown.total})`,
      )
    }
  })

  await check('normál, 3–5 eszközhívásos, 2 modellhívásos futás nem vált ki mintát', () => {
    const card = evaluateEfficiencyAdvisor([normalRun('a'), normalRun('b'), normalRun('c')])
    assert.equal(card.status, 'ok')
    assert.deepEqual(card.patterns, [])
    assert.equal(describeEfficiencyStatus(card.status).length > 20, true)
  })

  await check('minta-méret kapu: 2 futásból nincs megállapítás, csak „nincs elég adat"', () => {
    const card = evaluateEfficiencyAdvisor([incidentRun('a'), incidentRun('b')])
    assert.equal(card.status, 'insufficient_data')
    assert.deepEqual(card.patterns, [])
    assert.equal(card.analyzableRuns, 2)
  })

  await check('egyetlen futásból sincs megállapítás', () => {
    const card = evaluateEfficiencyAdvisor([incidentRun('a')])
    assert.equal(card.status, 'insufficient_data')
    assert.deepEqual(card.patterns, [])
  })

  await check('cache: csupa null nem mintázat, 0-ás értékek mellett viszont az', () => {
    const nullRun = (id: string): EfficiencyRun => ({
      id,
      kind: 'turn',
      modelCalls: Array.from({ length: 12 }, (_, i) =>
        modelCall({ createdAt: i, promptTokens: 4_000, cachedPromptTokens: null }),
      ),
      toolCalls: [],
    })
    const zeroRun = (id: string): EfficiencyRun => ({
      id,
      kind: 'turn',
      modelCalls: Array.from({ length: 12 }, (_, i) =>
        modelCall({ createdAt: i, promptTokens: 4_000, cachedPromptTokens: 0 }),
      ),
      toolCalls: [],
    })
    const missing = evaluateEfficiencyAdvisor([nullRun('a'), nullRun('b'), nullRun('c')])
    assert.equal(missing.cacheDataStatus, 'missing')
    assert.equal(missing.patterns.some((p) => p.kind === 'cache_prefix_break'), false)
    assert.equal(missing.patterns.every((p) => p.savingsTokens !== null || p.kind !== 'cache_prefix_break'), true)

    const broken = evaluateEfficiencyAdvisor([zeroRun('a'), zeroRun('b'), zeroRun('c')])
    assert.equal(broken.cacheDataStatus, 'available')
    assert.ok(broken.patterns.some((p) => p.kind === 'cache_prefix_break'))
    const cache = broken.patterns.find((p) => p.kind === 'cache_prefix_break')
    assert.ok(cache?.savingsTokens, '0-ás cache-nél kell megtakarítás-sáv')
  })

  await check('nincs kettős könyvelés: a szeletek összege a ModelCall token-összeg', () => {
    const card = evaluateEfficiencyAdvisor([normalRun('a'), normalRun('b'), normalRun('c')])
    const expected = [normalRun('a'), normalRun('b'), normalRun('c')].reduce((sum, run) => {
      return (
        sum +
        run.modelCalls.reduce((inner, call) => inner + call.promptTokens + call.completionTokens, 0)
      )
    }, 0)
    assert.equal(card.breakdown.entryContext + card.breakdown.repeatedContext + card.breakdown.completion, expected)
    assert.equal(card.breakdown.total, expected)
    assert.ok(card.breakdown.rereadTokensAnnotation >= 0)
    assert.ok(card.breakdown.cached >= 0)
  })

  await check('fékbe futott (blocked) visszaolvasás beleszámít az arányba', () => {
    const blockedRun = (id: string): EfficiencyRun => ({
      id,
      kind: 'turn',
      modelCalls: [modelCall({ createdAt: 1, promptTokens: 1_000 })],
      toolCalls: [
        ...Array.from({ length: 2 }, (_, i) => ({
          toolName: 'file_read',
          argsMeta: { path: `x-${i}.json` },
          resultMeta: { result_chars: 100 },
        })),
        ...Array.from({ length: 6 }, () => ({
          toolName: 'tool_result_read',
          argsMeta: { path: '.tool-results/x.json' },
          resultMeta: { blocked: true, result_chars: 0 },
        })),
      ],
    })
    const card = evaluateEfficiencyAdvisor([blockedRun('a'), blockedRun('b'), blockedRun('c')])
    const reread = card.patterns.find((p) => p.kind === 'repeated_reread')
    assert.ok(reread, 'a blocked soroknak mintát kell kiváltaniuk')
    assert.equal(reread?.metric.rereadCalls, 18)
  })

  await check('forrás-kulcs ismétlés (toolCallSourceKey) újraolvasásnak számít flagek nélkül is', () => {
    // EFF-04 (b): ugyanaz a path a futáson belül többször → 2..n újraolvasás.
    // A kulcs a loop-stop-decision toolCallSourceKey szabálya (path / documentId / …).
    const dupRun = (id: string): EfficiencyRun => ({
      id,
      kind: 'turn',
      modelCalls: [modelCall({ createdAt: 1, promptTokens: 1_200 })],
      toolCalls: Array.from({ length: 8 }, () => ({
        toolName: 'file_read',
        argsMeta: { path: 'ugyanaz.json' },
        resultMeta: { result_chars: 4_000 },
      })),
    })
    const card = evaluateEfficiencyAdvisor([dupRun('a'), dupRun('b'), dupRun('c')])
    const reread = card.patterns.find((p) => p.kind === 'repeated_reread')
    assert.ok(reread, 'az ismételt forrás-kulcsnak mintát kell kiváltania')
    // futásonként: 1 első olvasás + 7 újraolvasás → 7/8 = 0.875
    assert.equal(reread?.metric.rereadCalls, 7 * 3)
    assert.equal(reread?.metric.readCalls, 8 * 3)
    assert.equal(Number(reread?.metric.rereadRatio), 0.875)
    assert.equal(reread?.metric.rereadChars, 7 * 4_000 * 3)
    assert.equal(reread?.metric.rereadTokens, Math.round((7 * 4_000 * 3) / 4))
  })

  await check('documentId / url / pageId / id forrás-kulcsok ismétlése is számít', () => {
    const keyed = (
      id: string,
      toolName: string,
      field: 'documentId' | 'url' | 'pageId' | 'id',
      value: string,
    ): EfficiencyRun => ({
      id,
      kind: 'ticket',
      modelCalls: [modelCall({ createdAt: 1, promptTokens: 900 })],
      toolCalls: Array.from({ length: 6 }, () => ({
        toolName,
        argsMeta: { [field]: value },
        resultMeta: { result_chars: 2_000 },
      })),
    })
    const runs = [
      keyed('a', 'kb_get', 'documentId', 'doc-1'),
      keyed('b', 'web_fetch', 'url', 'https://example.com/a'),
      keyed('c', 'notion_get', 'pageId', 'page-9'),
      keyed('d', 'crm_get', 'id', 'rec-42'),
    ]
    // Négy futás, mindegyikben 5/6 újraolvasás — a minta-méret kapu (≥2) teljesül.
    const card = evaluateEfficiencyAdvisor(runs)
    const reread = card.patterns.find((p) => p.kind === 'repeated_reread')
    assert.ok(reread, 'a toolCallSourceKey mezők ismétlésének mintát kell adnia')
    assert.equal(reread?.metric.rereadCalls, 5 * 4)
    assert.equal(reread?.metric.readCalls, 6 * 4)
  })

  await check('fékbe futott sor után ugyanaz a forrás-kulcs továbbra is (b) szerint számít', () => {
    // Korábban a blocked/redundant early-return nem írta a seen mapet — a következő
    // azonos kulcsú olvasás elveszett volna a (b) ágon.
    const mixed = (id: string): EfficiencyRun => ({
      id,
      kind: 'turn',
      modelCalls: [modelCall({ createdAt: 1, promptTokens: 800 })],
      toolCalls: [
        {
          toolName: 'tool_result_read',
          argsMeta: { path: '.tool-results/shared.json' },
          resultMeta: { blocked: true, result_chars: 0 },
        },
        {
          toolName: 'tool_result_read',
          argsMeta: { path: '.tool-results/shared.json', returned_chars: 3_000 },
          resultMeta: { result_chars: 3_000 },
        },
        ...Array.from({ length: 5 }, () => ({
          toolName: 'tool_result_read',
          argsMeta: { path: '.tool-results/shared.json', returned_chars: 3_000 },
          resultMeta: { result_chars: 3_000 },
        })),
      ],
    })
    const card = evaluateEfficiencyAdvisor([mixed('a'), mixed('b'), mixed('c')])
    const reread = card.patterns.find((p) => p.kind === 'repeated_reread')
    assert.ok(reread)
    // futásonként: 1 blocked (a) + 6 ismétlés (b, prior≥1) = 7 újraolvasás / 7 olvasó
    assert.equal(reread?.metric.rereadCalls, 7 * 3)
    assert.equal(reread?.metric.readCalls, 7 * 3)
  })

  await check('küszöb-feloldás: érvénytelen vagy elnémító env az alapértékre esik vissza', () => {
    const tuned = resolveEfficiencyAdvisorThresholds({
      EFFICIENCY_ADVISOR_REREAD_RATIO: '0.4',
      EFFICIENCY_ADVISOR_MIN_READ_CALLS: '8',
      EFFICIENCY_ADVISOR_CACHE_HIT_RATIO: '0.15',
    } as unknown as NodeJS.ProcessEnv)
    assert.equal(tuned.rereadRatio, 0.4)
    assert.equal(tuned.minReadCallsForReread, 8)
    assert.equal(tuned.cacheHitRatio, 0.15)

    const junk = resolveEfficiencyAdvisorThresholds({
      EFFICIENCY_ADVISOR_REREAD_RATIO: '1',
      EFFICIENCY_ADVISOR_CACHE_HIT_RATIO: '0',
      EFFICIENCY_ADVISOR_MIN_READ_CALLS: 'nem-szám',
      EFFICIENCY_ADVISOR_REPEATED_CONTEXT_SHARE: '5',
      EFFICIENCY_ADVISOR_OVERSIZED_REPEAT: '0',
    } as unknown as NodeJS.ProcessEnv)
    assert.deepEqual(junk, EFFICIENCY_ADVISOR_THRESHOLDS)
  })

  await check('determinizmus: azonos bemenetből azonos kártya, minták megtakarítás szerint rendezve', () => {
    const runs = [incidentRun('c'), incidentRun('a'), incidentRun('b')]
    const first = evaluateEfficiencyAdvisor(runs)
    const second = evaluateEfficiencyAdvisor(runs)
    assert.deepEqual(first, second)
    const highs = first.patterns.map((p) => p.savingsTokens?.high ?? 0)
    const sorted = [...highs].sort((a, b) => b - a)
    assert.deepEqual(highs, sorted)
    for (const pattern of first.patterns) {
      assert.ok(describeEfficiencyPattern(pattern.kind).length > 40)
    }
  })

  await check('sáv-korlát: a felső vég soha nem haladja meg az ablak token-összegét', () => {
    const card = evaluateEfficiencyAdvisor([incidentRun('a'), incidentRun('b'), incidentRun('c')])
    for (const pattern of card.patterns) {
      if (!pattern.savingsTokens) continue
      assert.ok(pattern.savingsTokens.high <= card.breakdown.total)
      assert.ok(pattern.savingsTokens.low <= pattern.savingsTokens.high)
    }
  })

  await check('túlméretezett eszköz-kimenet ismétlődése eszköznévvel jelenik meg', () => {
    const fat = (id: string): EfficiencyRun => ({
      id,
      kind: 'ticket',
      modelCalls: [modelCall({ createdAt: 1, promptTokens: 800, cachedPromptTokens: 400 })],
      toolCalls: Array.from({ length: 4 }, () => ({
        toolName: 'http_api_get',
        argsMeta: { path: '/rows' },
        resultMeta: { result_chars: 250_000 },
      })),
    })
    const card = evaluateEfficiencyAdvisor([fat('a'), fat('b'), fat('c')])
    const oversized = card.patterns.find((p) => p.kind === 'oversized_tool_result')
    assert.ok(oversized)
    assert.equal(oversized?.metric.toolName, 'http_api_get')
    assert.equal(oversized?.suggestion.applicable, false)
    assert.equal(oversized?.suggestion.link, 'tool_narrowing')
  })

  await check('modelConfig overlay szigoríthat, kikapcsolni nem tud', () => {
    const tighter = resolveContextCompactionLimits(process.env, DEFAULT_CONTEXT_COMPACTION_LIMITS, {
      maxToolResultChars: 20_000,
      keepRecentToolResults: 2,
    })
    assert.equal(tighter.maxToolResultChars, 20_000)
    assert.equal(tighter.keepRecentToolResults, 2)

    const looser = resolveContextCompactionLimits(process.env, DEFAULT_CONTEXT_COMPACTION_LIMITS, {
      maxToolResultChars: 5_000_000,
      keepRecentToolResults: 0,
    })
    assert.equal(looser.maxToolResultChars, DEFAULT_CONTEXT_COMPACTION_LIMITS.maxToolResultChars)
    assert.equal(looser.keepRecentToolResults, DEFAULT_CONTEXT_COMPACTION_LIMITS.keepRecentToolResults)

    const ingest = resolveSourceIngestLimits(process.env, SOURCE_INGEST_DEFAULTS, {
      sourceIngestFactor: 1,
      sourceIngestMinChars: 6_000,
    })
    assert.equal(ingest.factor, 1)
    assert.equal(ingest.minChars, 6_000)

    const ingestOff = resolveSourceIngestLimits(process.env, SOURCE_INGEST_DEFAULTS, {
      sourceIngestFactor: 0,
      sourceIngestMinChars: 0,
    })
    assert.equal(ingestOff.factor, SOURCE_INGEST_DEFAULTS.factor)
    assert.equal(ingestOff.minChars, SOURCE_INGEST_DEFAULTS.minChars)
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
