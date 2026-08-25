/** RA-06 — `run_stats` tool bemenet/kimenet típusai. */

import type { RunIndexArgs, RunIndexScopeSummary } from './run-index-types'

export type RunStatsArgs = RunIndexArgs

export type RunStatsOutcomeLabel = 'ok' | 'empty' | 'partial' | 'failed' | 'denied' | 'unknown'

export type RunStatsOutcomeCell = {
  outcome: RunStatsOutcomeLabel
  count: number
  /** Az adott eszköz hívásain belüli arány (0..1). */
  ratio: number
}

export type RunStatsToolOutcomeRow = {
  toolName: string
  totalCalls: number
  outcomes: RunStatsOutcomeCell[]
}

export type RunStatsLatencyRow = {
  toolName: string
  count: number
  minMs: number
  maxMs: number
  avgMs: number
  p50Ms: number
  p90Ms: number
}

export type RunStatsPromptCache = {
  /** Nem-`null` `cachedPromptTokens` sorok — csak ezekre számít arány. */
  measuredCalls: number
  /** `null` cache-adat — „nincs adat", nem „nincs találat". */
  unmeasuredCalls: number
  promptTokens: number
  cachedPromptTokens: number
  /** Találati arány a mért sorokon; null, ha nincs mért sor. */
  hitRatio: number | null
}

export type RunStatsRepeatedSourceKey = {
  sourceKey: string
  toolName: string
  /** Összes olvasás a szkóp futásain belül. */
  readCount: number
  /** Újraolvasások száma (readCount − 1 futásonkénti első olvasás). */
  rereadCount: number
  /** Hány futásban jelent meg ez a kulcs. */
  runCount: number
}

export type RunStatsDenialReason = {
  policyDecision: string
  count: number
}

export type RunStatsSkillLoad = {
  action: 'skill.loaded' | 'skill.attachment_loaded' | 'skill.run_snapshot'
  skillId: string | null
  skillVersionId: string | null
  count: number
}

export type RunStatsResult = {
  scope: RunIndexScopeSummary
  runCount: number
  limit: number
  truncated: boolean
  toolOutcomeMatrix: RunStatsToolOutcomeRow[]
  latencyByTool: RunStatsLatencyRow[]
  /** True, ha a latency minta a felső korlát miatt nem a teljes tool-hívás-halmaz. */
  latencyByToolTruncated: boolean
  promptCache: RunStatsPromptCache
  repeatedSourceKeys: RunStatsRepeatedSourceKey[]
  repeatedSourceKeysTruncated: boolean
  denialReasons: RunStatsDenialReason[]
  skillLoads: RunStatsSkillLoad[]
  totals: {
    toolCallCount: number
    modelCallCount: number
  }
}
