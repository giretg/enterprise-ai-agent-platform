/**
 * issue #237 — utólagos hatékonysági tanácsadó.
 *
 * ÜZLETI PROBLÉMA: a platform megméri, mibe kerül egy futás, de nem magyarázza
 * meg. A folyamatgazda annyit lát, hogy az agent sokba került; azt nem, hogy
 * miért, és mit tehetne ellene. A drágaság nagy része négy ismert, ismétlődő
 * mintából jön (újraolvasás, kontextus-hízás, túlméretezett eszköz-kimenet,
 * cache-prefix törés) — a jelek megvannak a `ModelCall`/`ToolCall` sorokban,
 * csak nyersek.
 *
 * A modul EGYETLEN dolga: egy futás-halmaz normalizált alakjából hatékonysági
 * kártyát számolni. Szándékosan tiszta függvény (nincs Prisma, nincs óra; env
 * csak a küszöb-feloldáson), hogy a küszöbök és a minták DB nélkül tesztelhetők
 * legyenek — ugyanaz a minta, mint a `turn-cost-signals.ts`.
 *
 * A tanácsadó semmit nem állít le és semmit nem dob el. Nem fut a futás közben.
 */

import { toolCallSourceKey } from '@/domain/agent/loop-stop-decision'

/** ~4 karakter/token — ugyanaz a becslés, amit a `turn-cost-signals.ts` használ. */
export const CHARS_PER_TOKEN = 4

/** A tool-loop `TOOL_RESULT_INLINE_LIMIT` értéke — fölötte archívumba megy a kimenet. */
export const OVERSIZED_TOOL_RESULT_CHARS = 12_000

export type EfficiencyRunKind = 'turn' | 'ticket' | 'conversation'

export type EfficiencyRunModelCall = {
  createdAt: Date | string | number
  promptTokens: number
  completionTokens: number
  cachedPromptTokens: number | null
  costEstimate: number
  model?: string
}

export type EfficiencyRunToolCall = {
  toolName: string
  argsMeta?: Record<string, unknown> | null
  resultMeta?: Record<string, unknown> | null
}

export type EfficiencyRun = {
  id: string
  kind: EfficiencyRunKind
  modelCalls: EfficiencyRunModelCall[]
  toolCalls: EfficiencyRunToolCall[]
}

export type EfficiencyAdvisorThresholds = {
  /** E fölött mintának számít az újraolvasási arány. */
  rereadRatio: number
  /** Ennél kevesebb olvasó hívásból az arány nem jelent semmit. */
  minReadCallsForReread: number
  /** E fölött mintának számít az ismételt kontextus hányada. */
  repeatedContextShare: number
  /** Ennél kevesebb modellhívásból a hízás nem mintázat. */
  minModelCallsForBloat: number
  /** Ennyi ismételt túlméretezett kimenet kell egy futásban. */
  oversizedRepeatCount: number
  /** E alatt mintának számít a cache-találati arány. */
  cacheHitRatio: number
  /** Ennél kevesebb nem-`null` cache-adatú hívásból az arány nem jelent semmit. */
  minCacheCalls: number
}

export const EFFICIENCY_ADVISOR_THRESHOLDS: EfficiencyAdvisorThresholds = {
  rereadRatio: 0.3,
  minReadCallsForReread: 6,
  repeatedContextShare: 0.6,
  minModelCallsForBloat: 4,
  oversizedRepeatCount: 3,
  cacheHitRatio: 0.2,
  minCacheCalls: 10,
}

/** Egy kattintásos alkalmazáskor ezeket írjuk a `modelConfig`-ba (szigorítás). */
export const EFFICIENCY_ADVISOR_APPLIED_LIMITS = {
  maxToolResultChars: 30_000,
  keepRecentToolResults: 2,
  sourceIngestFactor: 1,
  sourceIngestMinChars: 6_000,
  maxToolCalls: 30,
} as const

const MIN_ANALYZABLE_RUNS = 3
const MIN_RUNS_FOR_PATTERN = 2

export type EfficiencyCardStatus = 'ok' | 'findings' | 'insufficient_data'

export type EfficiencyPatternKind =
  | 'repeated_reread'
  | 'context_bloat'
  | 'oversized_tool_result'
  | 'cache_prefix_break'

export type EfficiencySuggestion = {
  applicable: boolean
  modelConfigPatch?: Record<string, number>
  link?: 'prompt_cache' | 'tool_narrowing'
}

export type EfficiencySavingsBand = {
  /** Alsó becslés (a pazarolt token fele). */
  low: number
  /** Felső becslés (a pazarolt token teljes megszűnése), az ablak költségére vágva. */
  high: number
}

export type EfficiencyPattern = {
  kind: EfficiencyPatternKind
  explanationKey: EfficiencyPatternKind
  metric: Record<string, number | string>
  savingsTokens: EfficiencySavingsBand | null
  suggestion: EfficiencySuggestion
}

export type EfficiencyTokenBreakdown = {
  entryContext: number
  repeatedContext: number
  completion: number
  /** Annotáció: a prompt-tokenekből cache-ből kiszolgált rész, NEM szelet. */
  cached: number
  /** Annotáció: újraolvasásra becsült token, NEM szelet. */
  rereadTokensAnnotation: number
  total: number
  costEstimate: number
}

export type EfficiencyCacheDataStatus = 'available' | 'missing' | 'mixed'

export type EfficiencyCard = {
  status: EfficiencyCardStatus
  analyzableRuns: number
  /** True, ha legalább egy futás csak beszélgetés-szinten csoportosítható (nincs turn-kötés). */
  coarseOnly: boolean
  breakdown: EfficiencyTokenBreakdown
  patterns: EfficiencyPattern[]
  cacheDataStatus: EfficiencyCacheDataStatus
}

export type EfficiencyAdvisorView = {
  card: EfficiencyCard
  applied: Partial<Record<EfficiencyPatternKind, boolean>>
}

export function resolveEfficiencyAdvisorThresholds(
  env: NodeJS.ProcessEnv = process.env,
  fallback: EfficiencyAdvisorThresholds = EFFICIENCY_ADVISOR_THRESHOLDS,
): EfficiencyAdvisorThresholds {
  const ratio = (raw: string | undefined, min: number, max: number, fb: number): number => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > min && parsed < max ? parsed : fb
  }
  const int = (raw: string | undefined, min: number, max: number, fb: number): number => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? Math.round(parsed) : fb
  }
  return {
    rereadRatio: ratio(env.EFFICIENCY_ADVISOR_REREAD_RATIO, 0, 1, fallback.rereadRatio),
    minReadCallsForReread: int(
      env.EFFICIENCY_ADVISOR_MIN_READ_CALLS,
      2,
      50,
      fallback.minReadCallsForReread,
    ),
    repeatedContextShare: ratio(
      env.EFFICIENCY_ADVISOR_REPEATED_CONTEXT_SHARE,
      0,
      1,
      fallback.repeatedContextShare,
    ),
    minModelCallsForBloat: int(
      env.EFFICIENCY_ADVISOR_MIN_MODEL_CALLS,
      2,
      40,
      fallback.minModelCallsForBloat,
    ),
    oversizedRepeatCount: int(
      env.EFFICIENCY_ADVISOR_OVERSIZED_REPEAT,
      2,
      20,
      fallback.oversizedRepeatCount,
    ),
    cacheHitRatio: ratio(env.EFFICIENCY_ADVISOR_CACHE_HIT_RATIO, 0, 1, fallback.cacheHitRatio),
    minCacheCalls: int(env.EFFICIENCY_ADVISOR_MIN_CACHE_CALLS, 4, 100, fallback.minCacheCalls),
  }
}

type RunFinding = {
  kind: EfficiencyPatternKind
  wastedTokens: number
  metric: Record<string, number | string>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function numField(record: Record<string, unknown>, key: string): number | null {
  const raw = record[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

function boolField(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true
}

function modelCallTime(call: EfficiencyRunModelCall): number {
  if (call.createdAt instanceof Date) return call.createdAt.getTime()
  const parsed = new Date(call.createdAt).getTime()
  return Number.isFinite(parsed) ? parsed : Number(call.createdAt) || 0
}

function resultChars(tool: EfficiencyRunToolCall): number {
  const result = asRecord(tool.resultMeta)
  const args = asRecord(tool.argsMeta)
  return (
    numField(result, 'result_chars') ??
    numField(args, 'returned_chars') ??
    numField(args, 'total_chars') ??
    0
  )
}

function sourceKeyOf(tool: EfficiencyRunToolCall): string | null {
  const args = asRecord(tool.argsMeta)
  const tagged = args.source_key
  if (typeof tagged === 'string' && tagged.trim()) return tagged.trim()
  return toolCallSourceKey(tool.toolName, args)
}

function isReaderCall(tool: EfficiencyRunToolCall): boolean {
  if (tool.toolName === 'tool_result_read') return true
  return sourceKeyOf(tool) !== null
}

/**
 * Újraolvasás: (a) `tool_result_read` `redundant`/`blocked` metaadatával, vagy
 * (b) ugyanaz a `toolCallSourceKey` már szerepelt a futásban. A forrás-kulcsot
 * mindig nyilvántartjuk — a fékbe futott sorok sem „veszítik el" a kulcsot a
 * későbbi (b) egyezés elől.
 */
function isRereadCall(tool: EfficiencyRunToolCall, seen: Map<string, number>): boolean {
  const result = asRecord(tool.resultMeta)
  const flagged =
    tool.toolName === 'tool_result_read' &&
    (boolField(result, 'redundant') || boolField(result, 'blocked'))

  const key = sourceKeyOf(tool)
  let duplicate = false
  if (key) {
    const prior = seen.get(key) ?? 0
    seen.set(key, prior + 1)
    duplicate = prior >= 1
  }

  return flagged || duplicate
}

/**
 * EFF-05: a promptTokens sorozat monoton nem-csökkenő (createdAt szerint rendezve).
 * A hízás mintája a „minden körben újraküldjük + nő" alakot keresi; egy visszaesés
 * más dinamikát jelez (pl. tömörítés már dolgozott, vagy más feladat-szakasz).
 */
function isMonotonicPromptGrowth(promptTokensSeries: number[]): boolean {
  for (let i = 1; i < promptTokensSeries.length; i++) {
    if (promptTokensSeries[i]! < promptTokensSeries[i - 1]!) return false
  }
  return promptTokensSeries.length > 0
}

/**
 * EFF-05 mérőszám: ismételt (növekedett) kontextus =
 * `sum(promptTokens) − n × promptTokens(első hívás)`.
 * Ez a baseline első prompt n-szeri újraküldése fölötti többlet — arányban mérünk,
 * nem abszolút hívásszámban.
 */
function repeatedContextGrowth(promptSum: number, callCount: number, firstPrompt: number): number {
  if (callCount <= 0) return 0
  return Math.max(promptSum - callCount * firstPrompt, 0)
}

/**
 * EFF-07: cache-prefix törés egy futáson belül.
 * Csak nem-`null` `cachedPromptTokens` sorok; arány modellcsoportonként.
 * Ha egyetlen modellcsoport sem éri el a `minCacheCalls` küszöböt, nincs minta.
 */
function detectCachePrefixBreak(
  cacheRows: EfficiencyRunModelCall[],
  thresholds: EfficiencyAdvisorThresholds,
): RunFinding | null {
  const byModel = new Map<string, EfficiencyRunModelCall[]>()
  for (const call of cacheRows) {
    const model = typeof call.model === 'string' && call.model.trim() ? call.model.trim() : ''
    const list = byModel.get(model) ?? []
    list.push(call)
    byModel.set(model, list)
  }

  let best: RunFinding | null = null
  for (const [model, rows] of byModel) {
    if (rows.length < thresholds.minCacheCalls) continue
    const cachePrompt = rows.reduce((sum, call) => sum + Math.max(call.promptTokens, 0), 0)
    const cacheHit = rows.reduce((sum, call) => sum + Math.max(call.cachedPromptTokens ?? 0, 0), 0)
    const hitRatio = cachePrompt > 0 ? cacheHit / cachePrompt : 0
    if (hitRatio >= thresholds.cacheHitRatio) continue
    const wastedTokens = Math.max(cachePrompt - cacheHit, 0)
    const candidate: RunFinding = {
      kind: 'cache_prefix_break',
      wastedTokens,
      metric: {
        hitRatio: Number(hitRatio.toFixed(4)),
        cacheCalls: rows.length,
        cachedTokens: cacheHit,
        promptTokens: cachePrompt,
        model,
      },
    }
    if (!best || candidate.wastedTokens > best.wastedTokens) best = candidate
  }
  return best
}

function detectRun(
  run: EfficiencyRun,
  thresholds: EfficiencyAdvisorThresholds,
): { findings: RunFinding[]; breakdown: EfficiencyTokenBreakdown; cacheRows: 'none' | 'all_null' | 'has_values' } {
  const modelCalls = [...run.modelCalls].sort((a, b) => modelCallTime(a) - modelCallTime(b))
  const promptSeries = modelCalls.map((call) => Math.max(call.promptTokens, 0))
  const promptTokens = promptSeries.reduce((sum, tokens) => sum + tokens, 0)
  const completion = modelCalls.reduce((sum, call) => sum + Math.max(call.completionTokens, 0), 0)
  const entryContext = promptSeries.length > 0 ? promptSeries[0]! : 0
  // Token-bontás (EFF-08): a többi hívás teljes prompt-tömege = sum − első.
  const repeatedContext = Math.max(promptTokens - entryContext, 0)
  // Detektor-mérőszám (EFF-05): a baseline fölötti növekedés = sum − n×első.
  const contextGrowth = repeatedContextGrowth(promptTokens, modelCalls.length, entryContext)
  const cached = modelCalls.reduce(
    (sum, call) => sum + (call.cachedPromptTokens == null ? 0 : Math.max(call.cachedPromptTokens, 0)),
    0,
  )
  const costEstimate = modelCalls.reduce((sum, call) => sum + Math.max(call.costEstimate, 0), 0)

  const seenSources = new Map<string, number>()
  let readCalls = 0
  let rereadCalls = 0
  let rereadChars = 0
  for (const tool of run.toolCalls) {
    const reread = isRereadCall(tool, seenSources)
    if (isReaderCall(tool)) readCalls += 1
    if (reread) {
      rereadCalls += 1
      rereadChars += Math.max(resultChars(tool), 0)
    }
  }
  const rereadTokensAnnotation = Math.round(rereadChars / CHARS_PER_TOKEN)

  const findings: RunFinding[] = []
  const rereadRatio = readCalls > 0 ? Math.min(rereadCalls / readCalls, 1) : 0
  if (readCalls >= thresholds.minReadCallsForReread && rereadRatio > thresholds.rereadRatio) {
    findings.push({
      kind: 'repeated_reread',
      wastedTokens: rereadTokensAnnotation,
      metric: {
        rereadRatio: Number(rereadRatio.toFixed(4)),
        rereadCalls,
        readCalls,
        rereadChars,
        rereadTokens: rereadTokensAnnotation,
      },
    })
  }

  const repeatedShare = promptTokens > 0 ? contextGrowth / promptTokens : 0
  const monotonic = isMonotonicPromptGrowth(promptSeries)
  if (
    modelCalls.length >= thresholds.minModelCallsForBloat &&
    monotonic &&
    repeatedShare > thresholds.repeatedContextShare
  ) {
    findings.push({
      kind: 'context_bloat',
      wastedTokens: contextGrowth,
      metric: {
        repeatedShare: Number(repeatedShare.toFixed(4)),
        modelCalls: modelCalls.length,
        repeatedContext: contextGrowth,
        firstPrompt: entryContext,
        lastPrompt: promptSeries[promptSeries.length - 1] ?? 0,
      },
    })
  }

  // EFF-06: ugyanaz az eszköz (opcionálisan ugyanaz a forrás-kulcs) többször
  // ad a TOOL_RESULT_INLINE_LIMIT (12 000 kar) fölötti eredményt. Az egyszeri
  // nagy kimenet nem minta — a küszöb (≥ oversizedRepeatCount) a döntő.
  const oversizedByTool = new Map<
    string,
    { count: number; chars: number; sourceCounts: Map<string, number> }
  >()
  for (const tool of run.toolCalls) {
    const chars = resultChars(tool)
    if (chars <= OVERSIZED_TOOL_RESULT_CHARS) continue
    const prev = oversizedByTool.get(tool.toolName) ?? {
      count: 0,
      chars: 0,
      sourceCounts: new Map<string, number>(),
    }
    prev.count += 1
    prev.chars += chars
    const source = sourceKeyOf(tool)
    if (source) {
      prev.sourceCounts.set(source, (prev.sourceCounts.get(source) ?? 0) + 1)
    }
    oversizedByTool.set(tool.toolName, prev)
  }
  let oversizedHits = 0
  let oversizedChars = 0
  let oversizedTool = ''
  let oversizedSourceKey = ''
  for (const [toolName, row] of oversizedByTool) {
    if (row.count < thresholds.oversizedRepeatCount) continue
    if (row.chars > oversizedChars) {
      oversizedHits = row.count
      oversizedChars = row.chars
      oversizedTool = toolName
      // Opcionális forrás-kulcs: ha egyetlen kulcs eléri a küszöböt, a javaslat
      // ezt is megnevezheti (spec: „opcionálisan ugyanaz a forrás-kulcs").
      let bestSource = ''
      let bestSourceCount = 0
      for (const [source, count] of row.sourceCounts) {
        if (count >= thresholds.oversizedRepeatCount && count > bestSourceCount) {
          bestSource = source
          bestSourceCount = count
        }
      }
      oversizedSourceKey = bestSource
    }
  }
  if (oversizedHits >= thresholds.oversizedRepeatCount) {
    const metric: Record<string, number | string> = {
      toolName: oversizedTool,
      repeats: oversizedHits,
      resultChars: oversizedChars,
    }
    if (oversizedSourceKey) metric.sourceKey = oversizedSourceKey
    findings.push({
      kind: 'oversized_tool_result',
      wastedTokens: Math.round(oversizedChars / CHARS_PER_TOKEN),
      metric,
    })
  }

  // EFF-07: null ≠ 0. A cache-találati arány csak a nem-`null` sorokon:
  // sum(cachedPromptTokens) / sum(promptTokens). Csupa null → „nincs adat"
  // (nem megállapítás). A 0 viszont valódi „nincs találat". Az arányt azonos
  // modell felé menő hívásokon mérjük — a cache modell-specifikus.
  const cacheRows = modelCalls.filter((call) => call.cachedPromptTokens !== null)
  let cacheStatus: 'none' | 'all_null' | 'has_values' = 'none'
  if (modelCalls.length === 0) cacheStatus = 'none'
  else if (cacheRows.length === 0) cacheStatus = 'all_null'
  else cacheStatus = 'has_values'

  const cacheFinding = detectCachePrefixBreak(cacheRows, thresholds)
  if (cacheFinding) findings.push(cacheFinding)

  return {
    findings,
    breakdown: {
      entryContext,
      repeatedContext,
      completion,
      cached,
      rereadTokensAnnotation,
      total: entryContext + repeatedContext + completion,
      costEstimate,
    },
    cacheRows: cacheStatus,
  }
}

function savingsBand(wastedTokens: number, capTokens: number): EfficiencySavingsBand | null {
  if (wastedTokens <= 0 || capTokens <= 0) return null
  const high = Math.min(wastedTokens, capTokens)
  return { low: Math.floor(high / 2), high }
}

function suggestionFor(kind: EfficiencyPatternKind): EfficiencySuggestion {
  const patch = efficiencyHintPatch(kind)
  if (patch) return { applicable: true, modelConfigPatch: patch }
  if (kind === 'oversized_tool_result') return { applicable: false, link: 'tool_narrowing' }
  return { applicable: false, link: 'prompt_cache' }
}

export function efficiencyHintPatch(kind: EfficiencyPatternKind): Record<string, number> | null {
  switch (kind) {
    case 'repeated_reread':
      return {
        sourceIngestFactor: EFFICIENCY_ADVISOR_APPLIED_LIMITS.sourceIngestFactor,
        sourceIngestMinChars: EFFICIENCY_ADVISOR_APPLIED_LIMITS.sourceIngestMinChars,
        maxToolCalls: EFFICIENCY_ADVISOR_APPLIED_LIMITS.maxToolCalls,
      }
    case 'context_bloat':
      return {
        maxToolResultChars: EFFICIENCY_ADVISOR_APPLIED_LIMITS.maxToolResultChars,
        keepRecentToolResults: EFFICIENCY_ADVISOR_APPLIED_LIMITS.keepRecentToolResults,
      }
    default:
      return null
  }
}

function mergeMetrics(
  rows: Array<Record<string, number | string>>,
): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  const numericKeys = new Set<string>()
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'number') numericKeys.add(key)
    }
  }
  const averageKey = (key: string): boolean =>
    key.endsWith('Ratio') ||
    key.endsWith('Share') ||
    key === 'firstPrompt' ||
    key === 'lastPrompt'
  for (const key of numericKeys) {
    const values = rows.map((row) => row[key]).filter((value): value is number => typeof value === 'number')
    if (values.length === 0) continue
    const sum = values.reduce((acc, value) => acc + value, 0)
    if (!averageKey(key)) {
      out[key] = sum
      continue
    }
    const avg = sum / values.length
    out[key] =
      key === 'firstPrompt' || key === 'lastPrompt'
        ? Math.round(avg)
        : Number(avg.toFixed(4))
  }
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string' && value && out[key] === undefined) out[key] = value
    }
  }
  return out
}

const PATTERN_ORDER: EfficiencyPatternKind[] = [
  'repeated_reread',
  'context_bloat',
  'oversized_tool_result',
  'cache_prefix_break',
]

/**
 * Futás-halmaz → hatékonysági kártya. A minták csak akkor jelennek meg, ha
 * legalább 3 elemezhető futás van, és a minta legalább kettőben előfordul.
 */
export function evaluateEfficiencyAdvisor(
  runs: EfficiencyRun[],
  thresholds: EfficiencyAdvisorThresholds = EFFICIENCY_ADVISOR_THRESHOLDS,
): EfficiencyCard {
  const analyzable = runs.filter((run) => run.modelCalls.length > 0 || run.toolCalls.length > 0)
  const emptyBreakdown: EfficiencyTokenBreakdown = {
    entryContext: 0,
    repeatedContext: 0,
    completion: 0,
    cached: 0,
    rereadTokensAnnotation: 0,
    total: 0,
    costEstimate: 0,
  }
  if (analyzable.length < MIN_ANALYZABLE_RUNS) {
    const partial = analyzable.reduce((acc, run) => {
      const { breakdown } = detectRun(run, thresholds)
      return {
        entryContext: acc.entryContext + breakdown.entryContext,
        repeatedContext: acc.repeatedContext + breakdown.repeatedContext,
        completion: acc.completion + breakdown.completion,
        cached: acc.cached + breakdown.cached,
        rereadTokensAnnotation: acc.rereadTokensAnnotation + breakdown.rereadTokensAnnotation,
        total: acc.total + breakdown.total,
        costEstimate: acc.costEstimate + breakdown.costEstimate,
      }
    }, emptyBreakdown)
    return {
      status: 'insufficient_data',
      analyzableRuns: analyzable.length,
      coarseOnly: analyzable.some((run) => run.kind === 'conversation'),
      breakdown: partial,
      patterns: [],
      cacheDataStatus: 'missing',
    }
  }

  const perRun = analyzable.map((run) => ({ run, ...detectRun(run, thresholds) }))
  const breakdown = perRun.reduce((acc, row) => {
    return {
      entryContext: acc.entryContext + row.breakdown.entryContext,
      repeatedContext: acc.repeatedContext + row.breakdown.repeatedContext,
      completion: acc.completion + row.breakdown.completion,
      cached: acc.cached + row.breakdown.cached,
      rereadTokensAnnotation: acc.rereadTokensAnnotation + row.breakdown.rereadTokensAnnotation,
      total: acc.total + row.breakdown.total,
      costEstimate: acc.costEstimate + row.breakdown.costEstimate,
    }
  }, emptyBreakdown)

  const cacheStatuses = perRun.map((row) => row.cacheRows)
  const hasValues = cacheStatuses.some((status) => status === 'has_values')
  const allNull = cacheStatuses.every((status) => status === 'all_null' || status === 'none')
  const cacheDataStatus: EfficiencyCacheDataStatus = hasValues
    ? cacheStatuses.some((status) => status === 'all_null')
      ? 'mixed'
      : 'available'
    : allNull
      ? 'missing'
      : 'missing'

  const byKind = new Map<EfficiencyPatternKind, RunFinding[]>()
  for (const row of perRun) {
    for (const finding of row.findings) {
      const list = byKind.get(finding.kind) ?? []
      list.push(finding)
      byKind.set(finding.kind, list)
    }
  }

  const patterns: EfficiencyPattern[] = []
  for (const kind of PATTERN_ORDER) {
    const hits = byKind.get(kind) ?? []
    if (hits.length < MIN_RUNS_FOR_PATTERN) continue
    if (kind === 'cache_prefix_break' && cacheDataStatus === 'missing') continue
    const wasted = hits.reduce((sum, hit) => sum + hit.wastedTokens, 0)
    patterns.push({
      kind,
      explanationKey: kind,
      metric: mergeMetrics(hits.map((hit) => hit.metric)),
      savingsTokens: savingsBand(wasted, breakdown.total),
      suggestion: suggestionFor(kind),
    })
  }

  patterns.sort((a, b) => {
    const aHigh = a.savingsTokens?.high ?? 0
    const bHigh = b.savingsTokens?.high ?? 0
    if (bHigh !== aHigh) return bHigh - aHigh
    return PATTERN_ORDER.indexOf(a.kind) - PATTERN_ORDER.indexOf(b.kind)
  })

  return {
    status: patterns.length > 0 ? 'findings' : 'ok',
    analyzableRuns: analyzable.length,
    coarseOnly: analyzable.some((run) => run.kind === 'conversation'),
    breakdown,
    patterns,
    cacheDataStatus,
  }
}

/**
 * Közérthető magyarázat a kártyára (magyarázat-kulcs → szöveg).
 * A túlméretezett kimenetnél a `metric.toolName` bekerül a szövegbe, hogy a
 * javaslat konkrét legyen — kapcsolót ehhez a mintához nem ajánlunk.
 */
export function describeEfficiencyPattern(
  kind: EfficiencyPatternKind,
  metric?: Record<string, number | string>,
): string {
  switch (kind) {
    case 'repeated_reread':
      return 'Ez az agent a tokenjei nagy részét ugyanannak a forrásnak az újraolvasására költi. Kapcsold szűkebbre a forrás-keretet ennél az agentnél, hogy egyszer végigolvassa, és utána a kivonatból dolgozzon.'
    case 'context_bloat':
      return 'Minden körben újraküldi a teljes eddigi előzményt, ezért a prompt körönként nő. Kapcsold szigorúbbra a kontextus-tömörítést ennél az agentnél.'
    case 'oversized_tool_result': {
      const tool =
        typeof metric?.toolName === 'string' && metric.toolName.trim()
          ? metric.toolName.trim()
          : null
      const subject = tool ? `A(z) „${tool}" eszköz` : 'Ugyanaz az eszköz'
      return `${subject} ismételten túl nagy választ hoz be (a ${OVERSIZED_TOOL_RESULT_CHARS.toLocaleString('hu-HU')} karakteres limit fölött). Szűkítsd a hívást (aggregált végpont, szűkebb mezőlista, tool_result_extract) — ehhez a mintához nincs kapcsoló.`
    }
    case 'cache_prefix_break': {
      const model =
        typeof metric?.model === 'string' && metric.model.trim() ? metric.model.trim() : null
      const modelPart = model ? ` A(z) „${model}" modell felé menő hívásokon` : ''
      return `A prompt-cache alig fog ennél az agentnél.${modelPart} a stabil előtag sorrendje vagy a modell váltakozása miatt a gyorsítótár nem használódik. Ez nem kapcsoló — a prompt-cache beállításait kell ellenőrizni.`
    }
  }
}

/**
 * EFF-07: a „nincs cache-adat" és a „van adat, de 0 találat" megkülönböztetése.
 * A hiány nem megállapítás, és nem számít bele a megtakarítás-becslésbe.
 */
export function describeEfficiencyCacheDataStatus(status: EfficiencyCacheDataStatus): string {
  switch (status) {
    case 'missing':
      return 'A provider nem ad cache-adatot ezekhez a hívásokhoz — ez nem megállapítás, és nem számít bele a megtakarítás-becslésbe.'
    case 'available':
      return 'A provider cache-adatot adott; a találati arány a nem-null sorokból számolódik.'
    case 'mixed':
      return 'Egyes hívásoknál van cache-adat, másoknál nincs — az arányt csak a nem-null sorokból számoljuk.'
  }
}

export function describeEfficiencyStatus(status: EfficiencyCardStatus): string {
  switch (status) {
    case 'ok':
      return 'Ez az agent a vizsgált futások alapján rendben van: nincs ismétlődő pazarló minta.'
    case 'findings':
      return 'A vizsgált futásokban ismétlődő pazarló mintát találtunk.'
    case 'insufficient_data':
      return 'Nincs elég adat a megbízható elemzéshez — legalább három elemezhető futás kell.'
  }
}
