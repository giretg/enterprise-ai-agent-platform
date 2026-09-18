/**
 * Privacy-eval — APG-23 metrika-keret (spec §20, R22).
 *
 * A meglévő `Eval` / `EvalRun` modellekre és a `prompt-eval-red-lines` mintára
 * építve méri a hét elfogadási metrikát. A harness DB és élő modell nélkül fut:
 * determinisztikus fixture-ökön és stub-olt futásokon számol.
 *
 * | Metrika | Cél v1-ben |
 * |---|---|
 * | Strukturált, jelölt mező recall | 100% |
 * | Szabad szöveges recall (magyar minta) | ≥ 80% |
 * | False positive ráta | ≤ 5% |
 * | Latency overhead (p95, teljes forduló) | ≤ 80 ms |
 * | Workflow failure rate változása OBSERVE → ENFORCE | ≤ +1% |
 * | Válaszminőség-romlás pszeudonimizált prompton | ≤ 5% |
 * | Ismeretlen/érvénytelen álnév aránya a modell outputjában | ≤ 1% |
 */
import type { GoldenSetAssertion } from '@/domain/eval/eval-service'

export const PRIVACY_METRIC_IDS = [
  'structured_recall',
  'free_text_recall',
  'false_positive_rate',
  'latency_p95_ms',
  'workflow_failure_delta',
  'quality_degradation',
  'invalid_surrogate_rate',
] as const

export type PrivacyMetricId = (typeof PRIVACY_METRIC_IDS)[number]

/** v1 célértékek (spec §20). */
export const PRIVACY_EVAL_TARGETS: Record<
  PrivacyMetricId,
  { direction: 'min' | 'max'; threshold: number; label: string }
> = {
  structured_recall: {
    direction: 'min',
    threshold: 1,
    label: 'Strukturált, jelölt mező recall',
  },
  free_text_recall: {
    direction: 'min',
    threshold: 0.8,
    label: 'Szabad szöveges recall (magyar minta)',
  },
  false_positive_rate: {
    direction: 'max',
    threshold: 0.05,
    label: 'False positive ráta',
  },
  latency_p95_ms: {
    direction: 'max',
    threshold: 80,
    label: 'Latency overhead (p95, teljes forduló)',
  },
  workflow_failure_delta: {
    direction: 'max',
    threshold: 0.01,
    label: 'Workflow failure rate változása OBSERVE → ENFORCE',
  },
  quality_degradation: {
    direction: 'max',
    threshold: 0.05,
    label: 'Válaszminőség-romlás pszeudonimizált prompton',
  },
  invalid_surrogate_rate: {
    direction: 'max',
    threshold: 0.01,
    label: 'Ismeretlen/érvénytelen álnév aránya a modell outputjában',
  },
}

export type PrivacyMetricResult = {
  id: PrivacyMetricId
  value: number
  passed: boolean
  detail: string
  evidence?: string[]
}

export type PrivacyEvalReport = {
  metrics: PrivacyMetricResult[]
  blocking: boolean
  passed: number
  failed: number
}

export function metricPasses(id: PrivacyMetricId, value: number): boolean {
  const target = PRIVACY_EVAL_TARGETS[id]
  return target.direction === 'min' ? value >= target.threshold : value <= target.threshold
}

export function buildPrivacyEvalReport(metrics: PrivacyMetricResult[]): PrivacyEvalReport {
  const passed = metrics.filter((m) => m.passed).length
  const failed = metrics.filter((m) => !m.passed).length
  return {
    metrics,
    blocking: failed > 0,
    passed,
    failed,
  }
}

/** Recall: hány címkézett találat lett helyesen lefedve. */
export function computeRecall(covered: number, total: number): number {
  if (total === 0) return 1
  return covered / total
}

/** False positive ráta: hány nem-védendő elemet tokenizáltunk tévesen. */
export function computeFalsePositiveRate(falsePositives: number, negatives: number): number {
  if (negatives === 0) return 0
  return falsePositives / negatives
}

/** Válaszminőség-romlás: nyers ág pass-arány − pszeudo ág pass-arány (≥0). */
export function computeQualityDegradation(rawPassRate: number, pseudoPassRate: number): number {
  return Math.max(0, rawPassRate - pseudoPassRate)
}

/** Workflow failure delta: ENFORCE − OBSERVE (≥0). */
export function computeWorkflowFailureDelta(observeRate: number, enforceRate: number): number {
  return Math.max(0, enforceRate - observeRate)
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, rank)] ?? 0
}

/** Golden-set assertion kiértékelés (EvalService mintájára, független forrás). */
export function runGoldenAssertions(
  assertions: readonly GoldenSetAssertion[],
  content: string,
): { passed: number; total: number; passRate: number } {
  if (assertions.length === 0) return { passed: 0, total: 0, passRate: 1 }
  let passed = 0
  for (const a of assertions) {
    switch (a.type) {
      case 'contains':
        if (content.toLowerCase().includes(String(a.value).toLowerCase())) passed += 1
        break
      case 'not_contains':
        if (!content.toLowerCase().includes(String(a.value).toLowerCase())) passed += 1
        break
      case 'min_length':
        if (content.length >= Number(a.value)) passed += 1
        break
    }
  }
  return { passed, total: assertions.length, passRate: passed / assertions.length }
}

/**
 * EvalRun.details kompatibilis kimenet — a Control Plane eval-riportba illeszthető.
 */
export function toEvalRunDetails(report: PrivacyEvalReport): {
  passed: boolean
  score: number
  details: { privacyMetrics: PrivacyMetricResult[]; blocking: boolean }
} {
  const score =
    report.metrics.length > 0 ? report.metrics.filter((m) => m.passed).length / report.metrics.length : 1
  return {
    passed: !report.blocking,
    score,
    details: { privacyMetrics: report.metrics, blocking: report.blocking },
  }
}

export function formatPrivacyEvalReport(report: PrivacyEvalReport): string {
  const lines: string[] = [
    `Privacy-eval (APG-23) — ${report.metrics.length} metrika`,
    `  átment: ${report.passed} · elbukott: ${report.failed}`,
    '',
  ]
  for (const m of report.metrics) {
    const target = PRIVACY_EVAL_TARGETS[m.id]
    const bound =
      target.direction === 'min'
        ? `≥ ${formatThreshold(target.threshold)}`
        : `≤ ${formatThreshold(target.threshold)}`
    const status = m.passed ? '✅' : '❌'
    lines.push(`  ${status} ${target.label}: ${formatMetricValue(m.id, m.value)} (cél: ${bound})`)
    lines.push(`     ${m.detail}`)
    if (m.evidence && m.evidence.length > 0) {
      for (const e of m.evidence.slice(0, 5)) lines.push(`       · ${e}`)
      if (m.evidence.length > 5) lines.push(`       · … és még ${m.evidence.length - 5}`)
    }
  }
  if (report.blocking) {
    lines.push('', '⛔ BLOKKOLÓ: legalább egy metrika nem érte el a v1 célértéket.')
  }
  return lines.join('\n')
}

function formatThreshold(n: number): string {
  if (n >= 0 && n <= 1 && n !== 1) return `${Math.round(n * 100)}%`
  if (Number.isInteger(n)) return `${n}`
  return n.toFixed(2)
}

function formatMetricValue(id: PrivacyMetricId, value: number): string {
  if (id === 'latency_p95_ms') return `${value.toFixed(1)} ms`
  if (id.endsWith('_rate') || id.endsWith('_recall') || id.includes('degradation') || id.includes('delta')) {
    return `${(value * 100).toFixed(1)}%`
  }
  return String(value)
}
