import type { AuditRepository, MemoryChunkRepository, MemoryVersionRepository } from '@/repositories/interfaces'
import { snapshotMemoryManifest } from './memory-versioning'

export type MemoryRollbackResult =
  | {
      ok: true
      fromVersion: number
      toVersion: number
      newVersion: number
      archivedChunkIds: string[]
      restoredChunkIds: string[]
    }
  | { ok: false; reason: string }

/**
 * agent-memory-persistent-cross-conversation-spec.md §9.3/§17/§20 (WP-8) —
 * manifest-alapú, append-only rollback. Egy "rollback N-re" SOSEM mutálja a
 * korábbi `MemoryVersion` sorokat: a cél manifest (N) `activeChunkIds`
 * halmazát a JELENLEGI aktív halmazzal set-diffeli, a chunk-státuszokat
 * ennek megfelelően billenti, majd egy ÚJ (N+1) manifesztet ír. A `focus`
 * scope-onkénti "legfeljebb 1 aktív" invariánsa emiatt automatikusan
 * helyreáll — a set-diff pontosan azokat a chunkokat billenti, amik N óta
 * ténylegesen változtak (§9.3).
 */
export class MemoryRollbackService {
  constructor(
    private readonly chunks: MemoryChunkRepository,
    private readonly versions: MemoryVersionRepository,
    private readonly audit: AuditRepository,
  ) {}

  async rollback(params: {
    memoryId: string
    projectKey: string
    workstreamKey: string | null
    toVersion: number
    actorId: string
    tenantId: string | null
  }): Promise<MemoryRollbackResult> {
    const target = await this.versions.findByVersion({ memoryId: params.memoryId, version: params.toVersion })
    if (!target) return { ok: false, reason: 'version_not_found' }
    if (target.projectKey !== params.projectKey) return { ok: false, reason: 'version_scope_mismatch' }

    const targetActiveIds = new Set(((target.activeChunkIds as string[] | null) ?? []).map(String))
    const currentActiveIds = new Set(
      await this.chunks.listActiveIds({
        memoryId: params.memoryId,
        projectKey: params.projectKey,
        workstreamKey: params.workstreamKey,
      }),
    )

    const toArchive = [...currentActiveIds].filter((id) => !targetActiveIds.has(id))
    const toReactivate = [...targetActiveIds].filter((id) => !currentActiveIds.has(id))

    await this.chunks.setStatusMany(toArchive, 'archived')
    await this.chunks.setStatusMany(toReactivate, 'active')

    const latest = await this.versions.findLatestForScope({
      memoryId: params.memoryId,
      projectKey: params.projectKey,
      workstreamKey: params.workstreamKey,
    })

    const newVersion = await snapshotMemoryManifest({
      chunks: this.chunks,
      versions: this.versions,
      memoryId: params.memoryId,
      projectKey: params.projectKey,
      workstreamKey: params.workstreamKey,
      changeSet: {
        operation: 'rollback',
        toVersion: params.toVersion,
        archivedChunkIds: toArchive,
        restoredChunkIds: toReactivate,
      },
      sourceCandidateIds: [],
      approvedById: params.actorId,
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'memory.rollback',
      targetType: 'memory',
      targetId: params.memoryId,
      modelUsed: null,
      inputRef: String(latest?.version ?? target.version),
      outputRef: String(newVersion.version),
      policyDecision: 'rollback',
      tenantId: params.tenantId,
      metadata: {
        memoryId: params.memoryId,
        projectKey: params.projectKey,
        workstreamKey: params.workstreamKey,
        toVersion: params.toVersion,
        newVersion: newVersion.version,
        archivedChunkIds: toArchive,
        restoredChunkIds: toReactivate,
      },
    })

    return {
      ok: true,
      fromVersion: latest?.version ?? target.version,
      toVersion: params.toVersion,
      newVersion: newVersion.version,
      archivedChunkIds: toArchive,
      restoredChunkIds: toReactivate,
    }
  }
}
