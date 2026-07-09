import { estimateTextTokens } from '@/domain/conversation/context-assembly'
import { toKbTsQuery } from '@/repositories/postgres/knowledge-repository'
import type { MemoryChunk } from '@prisma/client'
import type { MemoryChunkRepository, MemoryChunkSearchHit } from '@/repositories/interfaces'
import { detectConflictsInPool } from './conflict-detection'
import {
  DEFAULT_CHUNK_TOKEN_BUDGET,
  DEFAULT_PROJECT_STATE_TOKEN_BUDGET,
  PROJECT_STATE_LIST_TYPES,
  type MemoryRetrievalRequest,
  type MemoryRetrievalResult,
  type ProjectStateView,
  type RetrievedChunk,
} from './memory-types'

export {
  DEFAULT_CHUNK_TOKEN_BUDGET,
  DEFAULT_PROJECT_STATE_TOKEN_BUDGET,
} from './memory-types'

// §5.1.1 no-query normalizálás — trim/lowercase/stopword- és nyugtázó-token-szűrés
// ("oké", "folytassuk", "köszi", "menjünk tovább" stb.). Nem kimerítő lista, csak
// a leggyakoribb magyar nyugtázó/töltelék-szavak.
const ACKNOWLEDGEMENT_STOPWORDS = new Set([
  'ok', 'oke', 'okes', 'okay', 'köszi', 'koszi', 'köszönöm', 'koszonom', 'kösz', 'kosz',
  'folytassuk', 'folytasd', 'menjünk', 'menjunk', 'tovább', 'tovabb', 'szia', 'sziasztok',
  'jó', 'jo', 'rendben', 'értem', 'ertem', 'igen', 'nem', 'kérlek', 'kerlek', 'akkor', 'na',
  'szuper', 'klassz', 'csá', 'csa', 'helló', 'hello', 'hi', 'thanks', 'thank', 'you', 'szeretnék',
  'szeretnek', 'kérem', 'kerem', 'jól', 'jol', 'van', 'nincs', 'ez', 'az', 'egy',
])

const NORMAL_WEIGHTS = { fts: 0.4, salience: 0.2, recency: 0.2, scope: 0.1, state: 0.1 }
// no_query módban a w_fts tag kiesik — a maradék súlyok újranormalizálva (§5.1.1).
const NO_QUERY_RENORM = 1 / (1 - NORMAL_WEIGHTS.fts)
const NO_QUERY_WEIGHTS = {
  fts: 0,
  salience: NORMAL_WEIGHTS.salience * NO_QUERY_RENORM,
  recency: NORMAL_WEIGHTS.recency * NO_QUERY_RENORM,
  scope: NORMAL_WEIGHTS.scope * NO_QUERY_RENORM,
  state: NORMAL_WEIGHTS.state * NO_QUERY_RENORM,
}

const CANDIDATE_POOL_SIZE = 30
const RECENCY_HALF_LIFE_DAYS = 30
const PROJECT_STATE_LIST_PER_TYPE_CAP = 8

function tokenizeMeaningful(query: string): string[] {
  return query
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !ACKNOWLEDGEMENT_STOPWORDS.has(t))
}

function recencyDecay(updatedAt: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24))
  return Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS)
}

/**
 * §16 S6 — védelem-mélységi tenant fail-closed szűrő. A `memoryId` már per-agent
 * (tehát per-tenant) izolál; ez egy belövési biztosíték téves memory-feloldás
 * ellen. NULL-biztos: soha nem ejt rendszer-szintű (null-tenant) chunkot, csak a
 * bizonyítottan más-tenant sorokat (mindkét oldal nem-null ÉS eltér).
 */
function isCrossTenantLeak(chunkTenantId: string | null, requestTenantId: string | null | undefined): boolean {
  return (
    chunkTenantId != null &&
    requestTenantId != null &&
    chunkTenantId !== requestTenantId
  )
}

function toRetrievedChunk(chunk: MemoryChunk, score: number): RetrievedChunk {
  return {
    id: chunk.id,
    type: chunk.type,
    path: chunk.path,
    title: chunk.title,
    summary: chunk.summary,
    text: chunk.text,
    tags: chunk.tags,
    salience: chunk.salience,
    confidence: chunk.confidence,
    score,
  }
}

function estimateChunkTokens(chunk: Pick<MemoryChunk, 'title' | 'summary' | 'text'>): number {
  return estimateTextTokens(`${chunk.title}\n${chunk.summary ?? ''}\n${chunk.text}`) + 8
}

/**
 * agent-memory-persistent-cross-conversation-spec.md §5/§10.2 —
 * `MemoryRetrievalService`. PURE: nem ismeri a chat/task runtime prompt-formátumát
 * (a hívó — agent-chat-runtime.ts / general-task-runtime.ts — építi a végső
 * `Project memory context` promptblokkot ebből az eredményből), és nem auditál
 * (a `memory.retrieve` audit-append a runtime-rétegben történik, §10.3).
 */
export class MemoryRetrievalService {
  constructor(private readonly chunks: MemoryChunkRepository) {}

  async retrieveForRun(req: MemoryRetrievalRequest): Promise<MemoryRetrievalResult> {
    const now = new Date()
    const projectStateBudget = req.tokenBudget.projectState ?? DEFAULT_PROJECT_STATE_TOKEN_BUDGET
    const chunkBudget = req.tokenBudget.chunks ?? DEFAULT_CHUNK_TOKEN_BUDGET

    const projectState = await this.buildProjectState(req, now, projectStateBudget)

    const meaningfulTokens = tokenizeMeaningful(req.query)
    const tsQuery = meaningfulTokens.length >= 3 ? toKbTsQuery(meaningfulTokens.join(' ')) : ''
    const queryMode: 'normal' | 'no_query' = tsQuery ? 'normal' : 'no_query'

    let pool: Array<{ chunk: MemoryChunk; textRelevance: number }>
    if (queryMode === 'normal') {
      const hits: MemoryChunkSearchHit[] = await this.chunks.searchActive({
        memoryId: req.memoryId,
        projectKey: req.projectKey,
        workstreamKey: req.workstreamKey,
        query: meaningfulTokens.join(' '),
        limit: CANDIDATE_POOL_SIZE,
      })
      pool = hits.map((h) => ({ chunk: h.chunk, textRelevance: h.textRelevance }))
    } else {
      const recent = await this.chunks.listRecentActive({
        memoryId: req.memoryId,
        projectKey: req.projectKey,
        workstreamKey: req.workstreamKey,
        limit: CANDIDATE_POOL_SIZE,
      })
      pool = recent.map((chunk) => ({ chunk, textRelevance: 0 }))
    }

    // §16 S6 — védelem-mélységi tenant fail-closed szűrő a jelölt-poolon.
    pool = pool.filter(({ chunk }) => !isCrossTenantLeak(chunk.tenantId, req.tenantId))

    const weights = queryMode === 'normal' ? NORMAL_WEIGHTS : NO_QUERY_WEIGHTS
    const referenced = new Set(projectState.referencedChunkIds)
    const scored = pool.map(({ chunk, textRelevance }) => {
      const score =
        weights.fts * textRelevance +
        weights.salience * chunk.salience +
        weights.recency * recencyDecay(chunk.updatedAt, now) +
        weights.scope * 1 +
        weights.state * (referenced.has(chunk.id) ? 1 : 0)
      return { chunk, score }
    })
    scored.sort((a, b) => b.score - a.score)

    const selected: RetrievedChunk[] = []
    let usedTokens = 0
    for (const { chunk, score } of scored) {
      const tokens = estimateChunkTokens(chunk)
      if (usedTokens + tokens <= chunkBudget || selected.length === 0) {
        selected.push(toRetrievedChunk(chunk, score))
        usedTokens += tokens
        continue
      }
      break
    }

    const scores: Record<string, number> = {}
    for (const { chunk, score } of scored) scores[chunk.id] = score

    const supersedeCandidates = [
      ...new Set([...projectState.referencedChunkIds, ...selected.map((c) => c.id)]),
    ]
    const retrievedIds = [...new Set([...projectState.referencedChunkIds, ...selected.map((c) => c.id)])]
    if (retrievedIds.length > 0) {
      await this.chunks.markRetrieved(retrievedIds)
    }

    // §7.1 — a visszaadott pool (top-K + project_state kivetített listái) önmagában
    // vizsgálva; a `focus` narratíva kimarad (scope-onként legfeljebb 1 aktív, nem
    // ütközhet önmagával).
    const conflictPool = [
      ...selected,
      ...projectState.decisions,
      ...projectState.openTasks,
      ...projectState.constraints,
      ...projectState.artifacts,
    ]
    const dedupedPool = [...new Map(conflictPool.map((c) => [c.id, c])).values()]
    const conflictSets = detectConflictsInPool(
      dedupedPool.map((c) => ({
        id: c.id,
        type: c.type,
        path: c.path,
        tags: c.tags,
        status: 'active',
        supersedes: null,
      })),
    )

    return {
      projectState,
      activeFocusChunkId: projectState.focusChunkId ?? undefined,
      chunks: selected,
      supersedeCandidates,
      conflictSets,
      scores,
      memoryVersionId: null, // nincs élő manifest addig, amíg a WP-8 rollback/versioning nem fut
      queryMode,
    }
  }

  private async buildProjectState(
    req: MemoryRetrievalRequest,
    now: Date,
    budget: number,
  ): Promise<ProjectStateView> {
    const focusRow = await this.chunks.findActiveFocus({
      memoryId: req.memoryId,
      projectKey: req.projectKey,
      workstreamKey: req.workstreamKey,
    })
    // §16 S6 — védelem-mélységi tenant fail-closed szűrő.
    const focus = focusRow && !isCrossTenantLeak(focusRow.tenantId, req.tenantId) ? focusRow : null

    const focusTokens = focus ? estimateChunkTokens(focus) : 0
    const remainingBudget = Math.max(0, budget - focusTokens)

    const listsByType = await Promise.all(
      PROJECT_STATE_LIST_TYPES.map(async (type) => ({
        type,
        chunks: await this.chunks.listActiveByType({
          memoryId: req.memoryId,
          projectKey: req.projectKey,
          workstreamKey: req.workstreamKey,
          type,
          limit: PROJECT_STATE_LIST_PER_TYPE_CAP,
        }),
      })),
    )

    // §4.1 — a listák salience+recency szerint csonkolódnak, ha túllépnék a
    // budgetet; a focus narratíva mindig bent marad (a fenti reserve miatt).
    const rankedCandidates = listsByType
      .flatMap(({ type, chunks }) => chunks.map((chunk) => ({ type, chunk })))
      // §16 S6 — védelem-mélységi tenant fail-closed szűrő a kivetített listákon.
      .filter(({ chunk }) => !isCrossTenantLeak(chunk.tenantId, req.tenantId))
      .map((entry) => ({
        ...entry,
        rank: entry.chunk.salience * 0.6 + recencyDecay(entry.chunk.updatedAt, now) * 0.4,
      }))
      .sort((a, b) => b.rank - a.rank)

    const includedByType: Record<string, MemoryChunk[]> = {
      decision: [],
      open_task: [],
      constraint: [],
      artifact: [],
    }
    let usedTokens = 0
    for (const { type, chunk } of rankedCandidates) {
      const tokens = estimateChunkTokens(chunk)
      if (usedTokens + tokens > remainingBudget) continue
      includedByType[type].push(chunk)
      usedTokens += tokens
    }

    const referencedChunkIds = [
      ...(focus ? [focus.id] : []),
      ...Object.values(includedByType).flatMap((chunks) => chunks.map((c) => c.id)),
    ]

    return {
      focusNarrative: focus?.text ?? null,
      focusChunkId: focus?.id ?? null,
      decisions: includedByType.decision.map((c) => toRetrievedChunk(c, 0)),
      openTasks: includedByType.open_task.map((c) => toRetrievedChunk(c, 0)),
      constraints: includedByType.constraint.map((c) => toRetrievedChunk(c, 0)),
      artifacts: includedByType.artifact.map((c) => toRetrievedChunk(c, 0)),
      referencedChunkIds,
    }
  }
}
