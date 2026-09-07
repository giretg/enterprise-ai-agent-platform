import type { AuditRepository } from '@/repositories/interfaces'
import {
  MEMORY_CAPTURE_POLICY_PROMPT,
  estimateMemoryContextTokens,
  estimateTrainedRulesTokens,
  formatProjectMemoryContextBlock,
  formatTrainedRulesBlock,
} from '@/lib/memory-prompt'
import {
  memoryConflictsTotal,
  memoryRetrievalLatencyMs,
  memoryRetrieveTokens,
} from '@/lib/observability/metrics'
import type { WorkProjectBrief } from '@/domain/work-project/work-project-service'
import type { MemoryRetrievalService } from './memory-retrieval-service'
import {
  DEFAULT_CHUNK_TOKEN_BUDGET,
  DEFAULT_PROJECT_STATE_TOKEN_BUDGET,
  type MemoryRetrievalRequest,
} from './memory-types'

/**
 * §5.1.1/§12.2 — a `MemoryRetrievalRequest` egységes összeállítása a platform-
 * default token-budgettel. A három runtime (chat/task/bookkeeper) korábban
 * mezőnként ismételte ezt; egy budget-default váltás így egy helyen történik.
 */
export function buildMemoryRetrievalRequest(params: {
  agentId: string
  memoryId: string
  tenantId?: string | null
  projectKey: string
  workstreamKey?: string | null
  query: string
  queryKind: 'chat' | 'task'
  runRef: MemoryRetrievalRequest['runRef']
}): MemoryRetrievalRequest {
  return {
    agentId: params.agentId,
    memoryId: params.memoryId,
    tenantId: params.tenantId ?? null,
    projectKey: params.projectKey,
    workstreamKey: params.workstreamKey,
    query: params.query,
    queryKind: params.queryKind,
    tokenBudget: { projectState: DEFAULT_PROJECT_STATE_TOKEN_BUDGET, chunks: DEFAULT_CHUNK_TOKEN_BUDGET },
    runRef: params.runRef,
  }
}

/**
 * §10.3/§16 S4 — a retrieval-blokk két rendszer-üzenete (capture-policy prompt +
 * az adat-blokk), ha van mit injektálni. Üres blokknál üres tömb (nincs push).
 */
export function memoryContextSystemMessages(
  block: string | null | undefined,
): Array<{ role: 'system'; content: string }> {
  if (!block) return []
  return [
    { role: 'system', content: MEMORY_CAPTURE_POLICY_PROMPT },
    { role: 'system', content: block },
  ]
}

/**
 * A Tanítás felületen betanított szabályok stabil rendszer-üzenete, ha van
 * betanított tartalom (különben üres tömb — nincs push).
 *
 * A `MemoryVersion.content` a chat- és task-runtime promptjából korábban
 * teljesen kimaradt: a §10.3 "retrieval-only" váltás a legacy teljes-inject
 * blokkot elhagyta, de a Tanítás írási útja soha nem hozott létre
 * `MemoryChunk`-ot, így a retrieval sem találhatta meg. A betanított szabály
 * ezért sosem ért el a modellhez — ezt a hidat pótolja ez a blokk.
 *
 * A `tokens` a hívónak kell: a kontextus-budget fix részébe be kell számítani,
 * különben a beszélgetés-történet túlcsordul.
 */
export function trainedRulesSystemMessages(params: {
  content: string | null | undefined
  version?: number | null
}): { messages: Array<{ role: 'system'; content: string }>; tokens: number } {
  const block = formatTrainedRulesBlock(params)
  if (!block) return { messages: [], tokens: 0 }
  return {
    messages: [{ role: 'system', content: block }],
    tokens: estimateTrainedRulesTokens(block),
  }
}

export type ProjectMemoryContext = {
  block: string | null
  tokens: number
  memoryMode: 'retrieval' | 'degraded'
}

/**
 * agent-memory-persistent-cross-conversation-spec.md §10.3 — a runtime-oldali
 * "retrieveForRun → Project memory context blokk + `memory.retrieve` audit"
 * lépéssorozat, közösen az agent-chat-runtime.ts / general-task-runtime.ts /
 * bookkeeper-runtime.ts között (NF4 degradált mód: retrieval-hiba esetén a
 * futás NEM áll le, üres blokk + `memoryMode: degraded` audit-jelölés).
 */
export async function loadProjectMemoryContext(params: {
  memoryRetrieval?: MemoryRetrievalService
  audit: AuditRepository
  request: MemoryRetrievalRequest
  actorId: string
  agentVersion?: number | null
  tenantId?: string | null
  ticketId?: string | null
  conversationId?: string | null
  brief?: WorkProjectBrief | null
}): Promise<ProjectMemoryContext> {
  const briefBlock = () =>
    formatProjectMemoryContextBlock(null, params.request.projectKey, params.brief)

  if (!params.memoryRetrieval) {
    const block = briefBlock()
    return { block, tokens: estimateMemoryContextTokens(block), memoryMode: 'degraded' }
  }

  const baseAudit = {
    actorType: 'agent' as const,
    actorId: params.actorId,
    agentVersion: params.agentVersion ?? null,
    action: 'memory.retrieve',
    targetType: 'memory',
    targetId: params.request.memoryId,
    modelUsed: null,
    tenantId: params.tenantId ?? null,
    ticketId: params.ticketId ?? null,
    conversationId: params.conversationId ?? null,
  }

  const startedAt = Date.now()
  try {
    const result = await params.memoryRetrieval.retrieveForRun(params.request)
    const latencyMs = Date.now() - startedAt
    const block = formatProjectMemoryContextBlock(result, params.request.projectKey, params.brief)
    const tokens = estimateMemoryContextTokens(block)

    memoryRetrieveTokens.observe(tokens, { projectKey: params.request.projectKey })
    memoryRetrievalLatencyMs.observe(latencyMs, { projectKey: params.request.projectKey })

    await params.audit.append({
      ...baseAudit,
      inputRef: `project:${params.request.projectKey}`,
      outputRef: `chunks:${result.chunks.length}`,
      policyDecision: 'allowed',
      metadata: {
        agentId: params.request.agentId,
        memoryId: params.request.memoryId,
        projectKey: params.request.projectKey,
        workstreamKey: params.request.workstreamKey ?? null,
        query: params.request.query,
        tokenBudget: params.request.tokenBudget,
        contextTokens: tokens,
        latencyMs,
        returnedChunkIds: result.chunks.map((c) => c.id),
        activeFocusChunkId: result.activeFocusChunkId ?? null,
        scores: result.scores,
        conflictSetIds: result.conflictSets.map((s) => s.chunkIds),
        memoryVersionId: result.memoryVersionId,
        queryMode: result.queryMode,
        memoryMode: 'retrieval',
        runRef: params.request.runRef,
      },
    })

    // §5.3/§7.3 — konfliktus esetén külön audit-esemény, a `memory.retrieve` soron felül.
    if (result.conflictSets.length > 0) {
      memoryConflictsTotal.inc({ resolution: 'retrieval_flagged' }, result.conflictSets.length)
      await params.audit.append({
        ...baseAudit,
        action: 'memory.conflict_detected',
        inputRef: `project:${params.request.projectKey}`,
        outputRef: `conflicts:${result.conflictSets.length}`,
        policyDecision: 'allowed',
        metadata: {
          agentId: params.request.agentId,
          memoryId: params.request.memoryId,
          projectKey: params.request.projectKey,
          conflictSets: result.conflictSets,
        },
      })
    }

    return { block, tokens, memoryMode: 'retrieval' }
  } catch {
    await params.audit.append({
      ...baseAudit,
      inputRef: `project:${params.request.projectKey}`,
      outputRef: 'error',
      policyDecision: 'allowed',
      metadata: {
        agentId: params.request.agentId,
        memoryId: params.request.memoryId,
        projectKey: params.request.projectKey,
        memoryMode: 'degraded',
      },
    })
    const block = briefBlock()
    return { block, tokens: estimateMemoryContextTokens(block), memoryMode: 'degraded' }
  }
}
