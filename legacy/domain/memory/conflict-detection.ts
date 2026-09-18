import type { ConflictRisk, ConflictSet } from './memory-types'

export type { ConflictRisk }

/**
 * agent-memory-persistent-cross-conversation-spec.md §7 — determinisztikus
 * konfliktus-előszűrés. PURE: nincs DB-hívás, nincs audit — a hívó
 * (MemoryRetrievalService retrieval-oldalon, MemoryApprovalService
 * publikálás-oldalon) adja át a scope-beli chunk-poolt és auditál, ha talál
 * valamit (§5.3/§7.3 `memory.conflict_detected`).
 */

export type ConflictScanChunk = {
  id: string
  type: string
  path: string
  tags: string[]
  status: string
  supersedes: string | null
}

function tagOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const setA = new Set(a)
  return b.some((t) => setA.has(t))
}

/**
 * §7.1 bullet 1+2 — a visszaadott (retrieval) pool önmagában vizsgálva: két
 * aktív chunk azonos path-on, vagy azonos type + átfedő tags de eltérő path-on.
 * A "hasonló artifact/workstream scope-ban eltérő állítást tesz" bullet
 * szándékosan nincs külön kódolva — a path/type/tags három jelzés lefedi a
 * gyakorlati eseteket, a szabad szöveges "eltérő állítás" NLP-elemzés nélkül
 * nem dönthető el determinisztikusan (§7.3: a modell dolga, nem a szűrőé).
 */
export function detectConflictsInPool(chunks: ConflictScanChunk[]): ConflictSet[] {
  const active = chunks.filter((c) => c.status === 'active')
  const conflicts: ConflictSet[] = []

  const byPath = new Map<string, ConflictScanChunk[]>()
  for (const chunk of active) {
    const bucket = byPath.get(chunk.path)
    if (bucket) bucket.push(chunk)
    else byPath.set(chunk.path, [chunk])
  }
  for (const bucket of byPath.values()) {
    if (bucket.length < 2) continue
    conflicts.push({
      chunkIds: bucket.map((c) => c.id).sort(),
      reason: `azonos path (${bucket[0].path}) alatt ${bucket.length} aktív emlék, nincs egymást superseding kapcsolat`,
      risk: 'high',
    })
  }

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]
      const b = active[j]
      if (a.path === b.path) continue // már lefedve a path-bucket ágban
      if (a.type !== b.type) continue
      if (!tagOverlap(a.tags, b.tags)) continue
      conflicts.push({
        chunkIds: [a.id, b.id].sort(),
        reason: `azonos típus (${a.type}) + átfedő tag-ek, eltérő path (${a.path} / ${b.path})`,
        risk: 'medium',
      })
    }
  }

  return conflicts
}

/**
 * §7.1 bullet 3 — publikálás-időben: az új chunk `supersedes` nélkül
 * ellentmond egy aktív, azonos path+type chunknak. A hívó (MemoryApprovalService)
 * ezt a `payload.type`/`payload.path`/`payload.tags` és a scope aktív chunkjai
 * ellen futtatja, MIELŐTT a T2-írás megtörténne — nem blokkol (a human approver
 * már döntött), csak auditál (§7.3 vége).
 */
export function detectPublishConflict(
  candidate: { type: string; path: string; tags: string[]; supersedes: string | null },
  activeScopeChunks: ConflictScanChunk[],
): ConflictSet | null {
  const others = activeScopeChunks.filter((c) => c.id !== candidate.supersedes)
  const samePath = others.filter((c) => c.path === candidate.path && c.type === candidate.type)
  if (samePath.length > 0) {
    return {
      chunkIds: samePath.map((c) => c.id).sort(),
      reason: `új "${candidate.type}" chunk azonos path-on (${candidate.path}) mint ${samePath.length} aktív emlék, supersedes nélkül`,
      risk: 'high',
    }
  }
  const tagMatches = others.filter((c) => c.type === candidate.type && tagOverlap(c.tags, candidate.tags))
  if (tagMatches.length > 0) {
    return {
      chunkIds: tagMatches.map((c) => c.id).sort(),
      reason: `azonos típus (${candidate.type}) + átfedő tag-ek ${tagMatches.length} aktív emlékkel, supersedes nélkül`,
      risk: 'medium',
    }
  }
  return null
}
