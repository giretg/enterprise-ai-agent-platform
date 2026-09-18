import type { MemoryChunkRepository, MemoryVersionRepository } from '@/repositories/interfaces'
import { memoryChunksActive } from '@/lib/observability/metrics'

/**
 * agent-memory-persistent-cross-conversation-spec.md §9.3/§10.1 (WP-8) —
 * minden T2-írás (create/update/supersede/archive/delete_request/demote/…)
 * után a scope teljes aktív-halmazának pillanatképe egy ÚJ `MemoryVersion`
 * manifesztbe kerül. Append-only: a hívó SOSEM mutálja a korábbi manifeszteket
 * ezen aúton — a rollback (memory-rollback-service.ts) is csak újat hoz létre.
 */
export async function snapshotMemoryManifest(params: {
  chunks: MemoryChunkRepository
  versions: MemoryVersionRepository
  memoryId: string
  projectKey: string
  workstreamKey: string | null
  changeSet: unknown
  sourceCandidateIds: string[]
  approvedById: string | null
}) {
  const activeChunkIds = await params.chunks.listActiveIds({
    memoryId: params.memoryId,
    projectKey: params.projectKey,
    workstreamKey: params.workstreamKey,
  })
  memoryChunksActive.set(activeChunkIds.length, { projectKey: params.projectKey })
  const version = await params.versions.nextVersionNumber(params.memoryId)
  return params.versions.create({
    memoryId: params.memoryId,
    version,
    projectKey: params.projectKey,
    workstreamKey: params.workstreamKey,
    activeChunkIds,
    changeSet: params.changeSet,
    sourceCandidateIds: params.sourceCandidateIds,
    approvedById: params.approvedById,
  })
}
