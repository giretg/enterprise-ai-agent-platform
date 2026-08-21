/**
 * issue #237 / EFF-07 — a hatékonysági tanácsadó detektor tesztje.
 * Futtatás: npm run test:efficiency-advisor
 *
 * A mérce a MÉRT eset (2026-07-29): 149 eszközhívásból 132 újraolvasás, 40 kör,
 * monoton növő prompt. Az elfogadási feltétel kétirányú: ez az alak kiváltja
 * az újraolvasás és a kontextus-hízás mintát; egy normál, 3–5 eszközhívásos,
 * 2 modellhívásos futás viszont NEM.
 *
 * EFF-07 DoD: csupa null cachedPromptTokens → nincs minta és nincs sáv
 * (`cacheDataStatus: missing`); 0-ás értékek mellett viszont van minta + sáv
 * (`available`). A két eset a kimenetben megkülönböztethető. Az arány csak
 * nem-null sorokon, azonos modell felé menő hívásokon számít.
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_CONTEXT_COMPACTION_LIMITS,
  resolveContextCompactionLimits,
} from '../src/domain/agent/context-compactor'
import {
  EFFICIENCY_ADVISOR_THRESHOLDS,
  describeEfficiencyCacheDataStatus,
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
    // EFF-07 DoD: null ≠ 0. Csupa null → missing, nincs minta, nincs sáv.
    // 0-ás cachedPromptTokens → available, van cache_prefix_break + savingsTokens.
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
    assert.equal(
      missing.patterns.every((p) => p.kind !== 'cache_prefix_break' || p.savingsTokens === null),
      true,
      'csupa nullnál a cache-mintához nem szabad sávot adni',
    )
    assert.ok(
      describeEfficiencyCacheDataStatus(missing.cacheDataStatus).includes('nem ad cache-adatot'),
    )

    const broken = evaluateEfficiencyAdvisor([zeroRun('a'), zeroRun('b'), zeroRun('c')])
    assert.equal(broken.cacheDataStatus, 'available')
    assert.notEqual(broken.cacheDataStatus, missing.cacheDataStatus, 'null és 0 megkülönböztethető')
    assert.ok(broken.patterns.some((p) => p.kind === 'cache_prefix_break'))
    const cache = broken.patterns.find((p) => p.kind === 'cache_prefix_break')
    assert.ok(cache?.savingsTokens, '0-ás cache-nél kell megtakarítás-sáv')
    assert.equal(cache?.metric.hitRatio, 0)
    assert.equal(cache?.metric.model, 'gpt-5.4')
    assert.equal(cache?.suggestion.applicable, false)
    assert.equal(cache?.suggestion.link, 'prompt_cache')
    assert.ok(describeEfficiencyPattern('cache_prefix_break', cache?.metric).includes('gpt-5.4'))
  })

  await check('cache: vegyes modellek külön csoport — a 10-es küszöb modellcsoportonként', () => {
    // 6+6 hívás két modellre, mind 0 cache → összességében 12, de azonos modellből csak 6.
    const mixed = (id: string): EfficiencyRun => ({
      id,
      kind: 'turn',
      modelCalls: [
        ...Array.from({ length: 6 }, (_, i) =>
          modelCall({
            createdAt: i,
            promptTokens: 4_000,
            cachedPromptTokens: 0,
            model: 'gpt-5.4',
          }),
        ),
        ...Array.from({ length: 6 }, (_, i) =>
          modelCall({
            createdAt: 100 + i,
            promptTokens: 4_000,
            cachedPromptTokens: 0,
            model: 'claude-sonnet',
          }),
        ),
      ],
      toolCalls: [],
    })
    const card = evaluateEfficiencyAdvisor([mixed('a'), mixed('b'), mixed('c')])
    assert.equal(card.cacheDataStatus, 'available')
    assert.equal(
      card.patterns.some((p) => p.kind === 'cache_prefix_break'),
      false,
      'különböző modellek nem adhatók össze a minCacheCalls küszöbhöz',
    )
  })

  await check('cache: magas találati arány nem mintázat', () => {
    const warm = (id: string): EfficiencyRun => ({
      id,
      kind: 'turn',
      modelCalls: Array.from({ length: 12 }, (_, i) =>
        modelCall({
          createdAt: i,
          promptTokens: 4_000,
          cachedPromptTokens: 3_200,
          model: 'gpt-5.4',
        }),
      ),
      toolCalls: [],
    })
    const card = evaluateEfficiencyAdvisor([warm('a'), warm('b'), warm('c')])
    assert.equal(card.cacheDataStatus, 'available')
    assert.equal(card.patterns.some((p) => p.kind === 'cache_prefix_break'), false)
  })

  await check('cache: null sorok kimaradnak az arányból, a 0-ások benne maradnak', () => {
    // 10 db 0-ás + 5 db null ugyanarra a modellre → a 10 nem-null 0% arány → minta.
    const partial = (id: string): EfficiencyRun => ({
      id,
      kind: 'turn',
      modelCalls: [
        ...Array.from({ length: 10 }, (_, i) =>
          modelCall({
            createdAt: i,
            promptTokens: 5_000,
            cachedPromptTokens: 0,
            model: 'gpt-5.4',
          }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          modelCall({
            createdAt: 50 + i,
            promptTokens: 5_000,
            cachedPromptTokens: null,
            model: 'gpt-5.4',
          }),
        ),
      ],
      toolCalls: [],
    })
    const card = evaluateEfficiencyAdvisor([partial('a'), partial('b'), partial('c')])
    assert.equal(card.cacheDataStatus, 'available')
    const cache = card.patterns.find((p) => p.kind === 'cache_prefix_break')
    assert.ok(cache, 'a nem-null 0-ásoknak mintát kell adniuk')
    assert.equal(cache?.metric.cacheCalls, 10 * 3)
    assert.equal(cache?.metric.hitRatio, 0)
    assert.ok(cache?.savingsTokens, 'mérhető cache-adat mellett kell sáv')
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
