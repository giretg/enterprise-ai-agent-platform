import { createHash } from 'node:crypto'
import { buildTree, type BuiltTree, type TreeFileInput, type TreeManifestEntry } from './tree'

/**
 * Sandbox verziózás tárrétege (Feature-spec §2.1/§2.2).
 *
 * Két külön, immutable object-store sín:
 *  - CodeTreeStore: per-commit teljes fa-snapshot (§13/1. nyitott döntés: MVP-ben
 *    teljes fa, később content-addressed dedup). A DB SOSEM tárol nyers fájltartalmat,
 *    csak `tree_ref + tree_hash + méret` (invariáns: F-SV-1 elfogadás).
 *  - DataSnapshotStore: point-in-time adat-dump (§4.5). A kód-sínnel SOHA nem keveredik.
 *
 * Prod: GCS REST az ambient Cloud Run service accounttal (WorkspaceStorage minta).
 * Dev/test: SANDBOX_VERSIONING_STUB=true (vagy FILE_EDITOR_STUB=true) → process-global
 * memóriatár. A ref ilyenkor is path, NEM inline tartalom.
 */

export class SandboxStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SandboxStoreError'
  }
}

interface StubTree {
  manifest: TreeManifestEntry[]
  files: Record<string, string>
  treeHash: string
  fileCount: number
  totalSizeBytes: number
}

const globalStub = globalThis as typeof globalThis & {
  __sandboxCodeTreeStub__?: Map<string, StubTree>
  __sandboxDataSnapshotStub__?: Map<string, { schemaHash: string; rowCount: number; sizeBytes: number }>
}
const codeStub: Map<string, StubTree> = (globalStub.__sandboxCodeTreeStub__ ??= new Map())
const dataStub = (globalStub.__sandboxDataSnapshotStub__ ??= new Map())

export function commitTreePath(params: {
  tenantId: string | null
  projectId: string
  seq: number
}): string {
  const tenant = params.tenantId ?? '_global'
  return `sandbox-code/${tenant}/${params.projectId}/commits/${params.seq}/tree.json`
}

export function dataSnapshotPath(params: {
  tenantId: string | null
  projectId: string
  snapshotId: string
}): string {
  const tenant = params.tenantId ?? '_global'
  return `sandbox-data/${tenant}/${params.projectId}/snapshots/${params.snapshotId}/dump.json`
}

// ── Kód-fa store ────────────────────────────────────────────────────────────

export interface StoredTree {
  treeRef: string
  treeHash: string
  fileCount: number
  totalSizeBytes: number
  entries: TreeManifestEntry[]
}

export interface CodeTreeStore {
  /** Immutable fa feltöltés. A visszaadott ref a commit object-path-e (NEM tartalom). */
  putTree(params: {
    tenantId: string | null
    projectId: string
    seq: number
    files: TreeFileInput[]
  }): Promise<StoredTree>
  /** A fa manifestje (path → hash/méret/bináris) tartalom nélkül. */
  getManifest(treeRef: string): Promise<TreeManifestEntry[]>
  /** Egy fájl tartalma a fából (diff/export). */
  getFile(treeRef: string, path: string): Promise<string | null>
}

async function resolveGcsToken(): Promise<string> {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  )
  if (!res.ok) throw new SandboxStoreError('GCS_AUTH_FAILED', `Metadata server returned ${res.status}`)
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

function isStub(): boolean {
  return process.env.SANDBOX_VERSIONING_STUB === 'true' || process.env.FILE_EDITOR_STUB === 'true'
}

export class GcsCodeTreeStore implements CodeTreeStore {
  constructor(private readonly bucket: string) {}

  async putTree(params: {
    tenantId: string | null
    projectId: string
    seq: number
    files: TreeFileInput[]
  }): Promise<StoredTree> {
    const built: BuiltTree = buildTree(params.files)
    const treeRef = commitTreePath(params)
    const filesByPath: Record<string, string> = {}
    for (const f of params.files) filesByPath[f.path.trim()] = f.content.replace(/\r\n/g, '\n')

    const payload: StubTree = {
      manifest: built.entries,
      files: filesByPath,
      treeHash: built.treeHash,
      fileCount: built.fileCount,
      totalSizeBytes: built.totalSizeBytes,
    }

    if (isStub()) {
      codeStub.set(treeRef, payload)
    } else {
      await this.writeObject(treeRef, JSON.stringify(payload))
    }

    return {
      treeRef,
      treeHash: built.treeHash,
      fileCount: built.fileCount,
      totalSizeBytes: built.totalSizeBytes,
      entries: built.entries,
    }
  }

  async getManifest(treeRef: string): Promise<TreeManifestEntry[]> {
    return (await this.loadTree(treeRef)).manifest
  }

  async getFile(treeRef: string, path: string): Promise<string | null> {
    const tree = await this.loadTree(treeRef)
    return tree.files[path] ?? null
  }

  private async loadTree(treeRef: string): Promise<StubTree> {
    if (isStub()) {
      const tree = codeStub.get(treeRef)
      if (!tree) throw new SandboxStoreError('TREE_NOT_FOUND', `Tree not found: ${treeRef}`)
      return tree
    }
    const raw = await this.readObject(treeRef)
    return JSON.parse(raw) as StubTree
  }

  private async writeObject(objectPath: string, body: string): Promise<void> {
    const token = await resolveGcsToken()
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(
      objectPath,
    )}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    })
    if (!res.ok) throw new SandboxStoreError('GCS_WRITE_FAILED', `GCS upload failed: HTTP ${res.status}`)
  }

  private async readObject(objectPath: string): Promise<string> {
    const token = await resolveGcsToken()
    const url = `https://storage.googleapis.com/download/storage/v1/b/${this.bucket}/o/${encodeURIComponent(
      objectPath,
    )}?alt=media`
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 404) throw new SandboxStoreError('TREE_NOT_FOUND', `Tree not found: ${objectPath}`)
    if (!res.ok) throw new SandboxStoreError('GCS_READ_FAILED', `GCS read failed: HTTP ${res.status}`)
    return res.text()
  }
}

// ── Adat-snapshot store ─────────────────────────────────────────────────────

export interface CreatedSnapshot {
  snapshotRef: string
  schemaHash: string
  rowCount: number
  sizeBytes: number
}

/**
 * Point-in-time adat-snapshot (§3.5/§4.5). A koncepció szerint ez a modul üzleti
 * adatát (pl. CRM-sorok + séma) menti; MVP-ben a `data_binding` alapján determinisztikus,
 * hordozható logikai dump referenciát ad (§13/2. nyitott döntés: logikai dump).
 * A séma állapotát a `schema_hash` a kód-fától FÜGGETLENÜL követi (kettős sín).
 */
export interface DataSnapshotStore {
  snapshot(params: {
    tenantId: string | null
    projectId: string
    env: 'test' | 'live'
    snapshotId: string
    dataBinding: unknown
  }): Promise<CreatedSnapshot>
  /** Egy korábbi snapshot visszaírása a cél-környezetbe (adat-sín, kódot nem érint). */
  restore(params: { snapshotRef: string; targetEnv: 'test' | 'live' }): Promise<void>
}

export class GcsDataSnapshotStore implements DataSnapshotStore {
  constructor(private readonly bucket: string) {}

  async snapshot(params: {
    tenantId: string | null
    projectId: string
    env: 'test' | 'live'
    snapshotId: string
    dataBinding: unknown
  }): Promise<CreatedSnapshot> {
    const snapshotRef = dataSnapshotPath(params)
    const bindingJson = JSON.stringify(params.dataBinding ?? {})
    const schemaHash = `sha256:${createHash('sha256').update(bindingJson).digest('hex')}`
    // MVP: a tényleges sor-dump a `data_binding` store-jaiból jönne; itt determinisztikus
    // méret/darab a bindingből származtatva, hogy a mérés (§8.3) és a checksum stabil legyen.
    const rowCount = Array.isArray((params.dataBinding as { stores?: unknown[] })?.stores)
      ? ((params.dataBinding as { stores?: unknown[] }).stores as unknown[]).length
      : 0
    const sizeBytes = Buffer.byteLength(bindingJson, 'utf8')

    if (isStub()) {
      dataStub.set(snapshotRef, { schemaHash, rowCount, sizeBytes })
    } else {
      await this.writeObject(snapshotRef, JSON.stringify({ schemaHash, dataBinding: params.dataBinding }))
    }
    return { snapshotRef, schemaHash, rowCount, sizeBytes }
  }

  async restore(params: { snapshotRef: string; targetEnv: 'test' | 'live' }): Promise<void> {
    if (isStub()) {
      if (!dataStub.has(params.snapshotRef)) {
        throw new SandboxStoreError('SNAPSHOT_NOT_FOUND', `Snapshot not found: ${params.snapshotRef}`)
      }
      return
    }
    // Prod: a dump visszaírása a cél-környezet adat-store-jába (Fázis 2 IaC).
    const token = await resolveGcsToken()
    const url = `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(
      params.snapshotRef,
    )}`
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 404) {
      throw new SandboxStoreError('SNAPSHOT_NOT_FOUND', `Snapshot not found: ${params.snapshotRef}`)
    }
    if (!res.ok) throw new SandboxStoreError('GCS_READ_FAILED', `Snapshot read failed: HTTP ${res.status}`)
  }

  private async writeObject(objectPath: string, body: string): Promise<void> {
    const token = await resolveGcsToken()
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(
      objectPath,
    )}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    })
    if (!res.ok) throw new SandboxStoreError('GCS_WRITE_FAILED', `GCS upload failed: HTTP ${res.status}`)
  }
}
