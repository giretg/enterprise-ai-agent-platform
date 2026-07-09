/**
 * agent-memory-persistent-cross-conversation-spec.md — megosztott típusok a
 * WP-2 (retrieval) és WP-4 (capture) rétegek között.
 */

// §3.1 — engedélyezett T2 chunk-típusok.
export const MEMORY_CHUNK_TYPES = [
  'focus',
  'decision',
  'open_task',
  'assumption',
  'finding',
  'constraint',
  'artifact',
  'failed_attempt',
  'handoff_summary',
] as const
export type MemoryChunkType = (typeof MEMORY_CHUNK_TYPES)[number]

// §4.1 — a T3 `project_state` kivetített listáihoz használt típusok (a `focus`
// a narratívát adja, ezek a mechanikusan kivetített listák).
export const PROJECT_STATE_LIST_TYPES: readonly MemoryChunkType[] = [
  'decision',
  'open_task',
  'constraint',
  'artifact',
]

export type MemoryConfidence = 'low' | 'normal' | 'high'
export type MemorySalienceHint = 'normal' | 'high'

export type RetrievedChunk = {
  id: string
  type: string
  path: string
  title: string
  summary: string | null
  text: string
  tags: string[]
  salience: number
  confidence: string
  score: number
}

export type ProjectStateView = {
  focusNarrative: string | null
  focusChunkId: string | null
  decisions: RetrievedChunk[]
  openTasks: RetrievedChunk[]
  constraints: RetrievedChunk[]
  artifacts: RetrievedChunk[]
  referencedChunkIds: string[]
}

// §7.2/§7.3 — a `risk` a determinisztikus rangsorolásból származik (path-egyezés
// = high, típus+tag-átfedés = medium); a runtime ezt adja át a modellnek a
// `conflict_set`-tel együtt, hogy a döntési szintet (§7.3) tudja alkalmazni.
export type ConflictRisk = 'low' | 'medium' | 'high'

export type ConflictSet = {
  chunkIds: string[]
  reason: string
  risk: ConflictRisk
}

// §5.1.1 — a `MemoryRetrievalService` szerződése.
export type MemoryRetrievalRequest = {
  agentId: string
  memoryId: string
  // §16 S6 — a hívó (agent) szervezeti tenantja; a retrieval védelem-mélységi,
  // fail-closed szűréshez használja (a `memoryId` mellett belövési biztosíték egy
  // téves memory-feloldás ellen). `null` = rendszer-szintű beépített agent.
  tenantId?: string | null
  projectKey: string
  workstreamKey?: string | null
  query: string
  queryKind: 'chat' | 'task'
  tokenBudget: { projectState: number; chunks: number }
  runRef: { runId?: string; threadId?: string; ticketId?: string }
}

export type MemoryRetrievalResult = {
  projectState?: ProjectStateView
  activeFocusChunkId?: string
  chunks: RetrievedChunk[]
  supersedeCandidates: string[]
  conflictSets: ConflictSet[]
  scores: Record<string, number>
  memoryVersionId: string | null
  queryMode: 'normal' | 'no_query'
}

// §12.2 — token-budget defaultok (self_evolution_profile.memory a WP-6-ban
// köti be per-agent; addig ez a platform-default).
export const DEFAULT_PROJECT_STATE_TOKEN_BUDGET = 1200
export const DEFAULT_CHUNK_TOKEN_BUDGET = 2500
