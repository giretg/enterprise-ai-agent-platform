/**
 * EFF-12 — „Alkalmazom" gomb: per-agent felülbírálás, audit, visszavonás.
 * Futtatás: npm run test:efficiency-advisor-apply
 *
 * DoD: nem-admin nem tudja alkalmazni; az audit-sor a két értéket tartalmazza;
 * a visszavonás ugyanazon a felületen elérhető és szintén auditált.
 * Ahol nincs kapcsoló, nincs gomb — magyarázat + link.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EFFICIENCY_ADVISOR_APPLIED_LIMITS,
  EFFICIENCY_HINT_KINDS,
  applyEfficiencyHintToModelConfig,
  describeEfficiencyHint,
  efficiencyHintPatch,
  evaluateEfficiencyAdvisor,
  hintsForPattern,
  type EfficiencyRun,
} from '../src/domain/agent/efficiency-advisor'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

console.log('=== EFF-12 alkalmazható javaslat (apply / audit / revert) ===')

check('három alkalmazható kapcsoló: tömörítés / forrás-keret / eszköz-büdzsé', () => {
  assert.deepEqual([...EFFICIENCY_HINT_KINDS], [
    'stricter_compaction',
    'narrower_source_frame',
    'narrower_tool_budget',
  ])
  assert.deepEqual(efficiencyHintPatch('stricter_compaction'), {
    maxToolResultChars: EFFICIENCY_ADVISOR_APPLIED_LIMITS.maxToolResultChars,
    keepRecentToolResults: EFFICIENCY_ADVISOR_APPLIED_LIMITS.keepRecentToolResults,
  })
  assert.deepEqual(efficiencyHintPatch('narrower_source_frame'), {
    sourceIngestFactor: EFFICIENCY_ADVISOR_APPLIED_LIMITS.sourceIngestFactor,
    sourceIngestMinChars: EFFICIENCY_ADVISOR_APPLIED_LIMITS.sourceIngestMinChars,
  })
  assert.deepEqual(efficiencyHintPatch('narrower_tool_budget'), {
    maxToolCalls: EFFICIENCY_ADVISOR_APPLIED_LIMITS.maxToolCalls,
  })
  assert.ok(describeEfficiencyHint('stricter_compaction').length > 5)
})

check('minták → kapcsolók: hízás=tömörítés, újraolvasás=forrás+büdzsé, többinél semmi', () => {
  assert.deepEqual(hintsForPattern('context_bloat'), ['stricter_compaction'])
  assert.deepEqual(hintsForPattern('repeated_reread'), [
    'narrower_source_frame',
    'narrower_tool_budget',
  ])
  assert.deepEqual(hintsForPattern('oversized_tool_result'), [])
  assert.deepEqual(hintsForPattern('cache_prefix_break'), [])
})

check('apply: modelConfig-ba írja a patch-et, previous/next a régi és új érték', () => {
  const result = applyEfficiencyHintToModelConfig({
    modelConfig: { model: 'gpt', maxToolCalls: 60 },
    kind: 'narrower_tool_budget',
  })
  assert.equal(result.reverted, false)
  assert.equal(result.modelConfig.maxToolCalls, 30)
  assert.equal(result.modelConfig.model, 'gpt')
  assert.deepEqual(result.previous, { maxToolCalls: 60 })
  assert.deepEqual(result.next, { maxToolCalls: 30 })
  const undo = result.modelConfig.efficiencyAdvisorUndo as Record<string, unknown>
  assert.deepEqual(undo.narrower_tool_budget, { maxToolCalls: 60 })
})

check('apply: hiányzó kulcs previous=null, többszöri apply megőrzi az eredeti snapshotot', () => {
  const first = applyEfficiencyHintToModelConfig({
    modelConfig: { provider: 'x' },
    kind: 'stricter_compaction',
  })
  assert.deepEqual(first.previous, {
    maxToolResultChars: null,
    keepRecentToolResults: null,
  })
  assert.equal(first.modelConfig.maxToolResultChars, 30_000)

  const second = applyEfficiencyHintToModelConfig({
    modelConfig: first.modelConfig,
    kind: 'stricter_compaction',
  })
  // Második apply nem írja felül a snapshotot az első alkalmazott értékkel.
  const undo = second.modelConfig.efficiencyAdvisorUndo as Record<string, Record<string, number | null>>
  assert.deepEqual(undo.stricter_compaction, {
    maxToolResultChars: null,
    keepRecentToolResults: null,
  })
})

check('revert: visszaállítja a régi értéket, previous/next mindkét oldal kitöltve', () => {
  const applied = applyEfficiencyHintToModelConfig({
    modelConfig: { sourceIngestFactor: 2, sourceIngestMinChars: 12_000 },
    kind: 'narrower_source_frame',
  })
  const reverted = applyEfficiencyHintToModelConfig({
    modelConfig: applied.modelConfig,
    kind: 'narrower_source_frame',
    revert: true,
  })
  assert.equal(reverted.reverted, true)
  assert.equal(reverted.modelConfig.sourceIngestFactor, 2)
  assert.equal(reverted.modelConfig.sourceIngestMinChars, 12_000)
  assert.equal(reverted.modelConfig.efficiencyAdvisorUndo, undefined)
  assert.deepEqual(reverted.previous, {
    sourceIngestFactor: EFFICIENCY_ADVISOR_APPLIED_LIMITS.sourceIngestFactor,
    sourceIngestMinChars: EFFICIENCY_ADVISOR_APPLIED_LIMITS.sourceIngestMinChars,
  })
  assert.deepEqual(reverted.next, {
    sourceIngestFactor: 2,
    sourceIngestMinChars: 12_000,
  })
})

check('revert: ha előtte nem volt kulcs, törli a felülbírálást', () => {
  const applied = applyEfficiencyHintToModelConfig({
    modelConfig: {},
    kind: 'narrower_tool_budget',
  })
  assert.equal(applied.modelConfig.maxToolCalls, 30)
  const reverted = applyEfficiencyHintToModelConfig({
    modelConfig: applied.modelConfig,
    kind: 'narrower_tool_budget',
    revert: true,
  })
  assert.equal('maxToolCalls' in reverted.modelConfig, false)
  assert.deepEqual(reverted.next, { maxToolCalls: null })
})

check('cache / túlméretezett: nincs kapcsoló, van link', () => {
  const fat = (id: string): EfficiencyRun => ({
    id,
    kind: 'ticket',
    modelCalls: [
      {
        createdAt: 1,
        promptTokens: 800,
        completionTokens: 40,
        cachedPromptTokens: 0,
        costEstimate: 0.01,
      },
    ],
    toolCalls: Array.from({ length: 4 }, () => ({
      toolName: 'http_api_get',
      argsMeta: { path: '/rows' },
      resultMeta: { result_chars: 250_000 },
    })),
  })
  const cacheBreak = (id: string): EfficiencyRun => ({
    id,
    kind: 'turn',
    modelCalls: Array.from({ length: 12 }, (_, i) => ({
      createdAt: i + 1,
      promptTokens: 2_000,
      completionTokens: 50,
      cachedPromptTokens: 0,
      costEstimate: 0.02,
      model: 'gpt-test',
    })),
    toolCalls: [],
  })

  const oversizedCard = evaluateEfficiencyAdvisor([fat('a'), fat('b'), fat('c')])
  const oversized = oversizedCard.patterns.find((p) => p.kind === 'oversized_tool_result')
  assert.ok(oversized)
  assert.equal(oversized?.suggestion.applicable, false)
  assert.equal(oversized?.suggestion.href, '?section=kapcsolatok')
  assert.deepEqual(oversized?.suggestion.hintKinds ?? [], [])

  const cacheCard = evaluateEfficiencyAdvisor([
    cacheBreak('a'),
    cacheBreak('b'),
    cacheBreak('c'),
  ])
  const cache = cacheCard.patterns.find((p) => p.kind === 'cache_prefix_break')
  assert.ok(cache)
  assert.equal(cache?.suggestion.applicable, false)
  assert.equal(cache?.suggestion.href, '?section=motor')
})

check('applicable minták hintKinds-szel jönnek (három gomb lefedhető)', () => {
  const bloat = (id: string): EfficiencyRun => ({
    id,
    kind: 'turn',
    modelCalls: [
      { createdAt: 1, promptTokens: 21_000, completionTokens: 100, cachedPromptTokens: 0, costEstimate: 1 },
      { createdAt: 2, promptTokens: 50_000, completionTokens: 100, cachedPromptTokens: 0, costEstimate: 1 },
      { createdAt: 3, promptTokens: 90_000, completionTokens: 100, cachedPromptTokens: 0, costEstimate: 1 },
      { createdAt: 4, promptTokens: 154_000, completionTokens: 100, cachedPromptTokens: 0, costEstimate: 1 },
    ],
    toolCalls: [],
  })
  const card = evaluateEfficiencyAdvisor([bloat('a'), bloat('b'), bloat('c')])
  const context = card.patterns.find((p) => p.kind === 'context_bloat')
  assert.ok(context)
  assert.equal(context?.suggestion.applicable, true)
  assert.deepEqual(context?.suggestion.hintKinds, ['stricter_compaction'])
})

check('server action: tenant admin + audit previous/next + reverted action', () => {
  const action = readFileSync(join(root, 'src/app/actions/efficiency-advisor.ts'), 'utf8')
  assert.match(action, /requireTenantRole\('admin'\)/)
  assert.match(action, /agent\.efficiency_hint_applied/)
  assert.match(action, /agent\.efficiency_hint_reverted/)
  assert.match(action, /previous: result\.previous/)
  assert.match(action, /next: result\.next/)
  assert.match(action, /applyEfficiencyHintToModelConfig/)
})

check('validator: csak a három hint-kind fogadott', () => {
  const validators = readFileSync(join(root, 'src/lib/validators/actions.ts'), 'utf8')
  const slice = validators.slice(
    validators.indexOf('export const applyEfficiencyHintSchema'),
    validators.indexOf('export const updateAgentPersonaSchema'),
  )
  assert.match(slice, /stricter_compaction/)
  assert.match(slice, /narrower_source_frame/)
  assert.match(slice, /narrower_tool_budget/)
  assert.doesNotMatch(slice, /repeated_reread/)
})

check('UI: Alkalmazom/Visszavonás + link ahol nincs kapcsoló; canApply kapu', () => {
  const panel = readFileSync(
    join(root, 'src/components/agents/efficiency-advisor-panel.tsx'),
    'utf8',
  )
  assert.match(panel, /Alkalmazom:/)
  assert.match(panel, /Visszavonás:/)
  assert.match(panel, /canApply/)
  assert.match(panel, /pattern\.suggestion\.href/)
  assert.match(panel, /tenant admin/)
  const domain = readFileSync(join(root, 'src/domain/agent/efficiency-advisor.ts'), 'utf8')
  assert.match(domain, /\?section=kapcsolatok/)
  assert.match(domain, /\?section=motor/)
  const page = readFileSync(
    join(root, 'src/app/control-plane/agents/[agentId]/page.tsx'),
    'utf8',
  )
  assert.match(page, /initialId=\{query\.section\}/)
})

check('audit katalógus tartalmazza mindkét actiont', () => {
  const catalog = readFileSync(join(root, 'src/lib/audit/event-catalog.ts'), 'utf8')
  assert.match(catalog, /'agent\.efficiency_hint_applied'/)
  assert.match(catalog, /'agent\.efficiency_hint_reverted'/)
})

if (failures > 0) {
  console.log(`\n${failures} teszt elbukott.`)
  process.exit(1)
}
console.log('\nMinden teszt zöld.')
