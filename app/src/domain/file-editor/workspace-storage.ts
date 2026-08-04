import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  isWorkspaceFileUserFacing,
  type WorkspaceFileAudience,
  WORKSPACE_FILE_AUDIENCE_MANIFEST,
  WORKSPACE_FILE_AUDIENCE_PREFIX,
} from '@/lib/workspace-file-visibility'
import { getGcpAccessToken, getGcpServiceAccountEmail } from '@/lib/gcp-metadata-token'

/**
 * GCS workspace storage adapter.
 * FILE_EDITOR_STUB=true → lokális stub (alapból lemez: `.data/workspace`, túléli a
 * Next restartot). FILE_EDITOR_STUB_MEMORY=true → tisztán memóriában (E2E/unit).
 * Production: GCS REST API via ambient Cloud Run service account.
 */

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024

/**
 * Egyszerre ennyi objektum-műveletet (olvasás/törlés) indítunk a tár felé.
 *
 * A workspace-műveletek java hálózati várakozás (GCS REST), nem CPU — sorosan
 * futtatva a keresés és az import a fájlszámmal lineárisan lassul (mért eset:
 * 659 fájl = 29,5 mp egyetlen `file_search`-re, a felhasználó közben a chatben
 * várt). Korlátozott párhuzamossággal ez másodpercekre esik, a korlát pedig
 * megvéd a socket-kimerüléstől és a szolgáltatói 429-től, amit egy korlátlan
 * `Promise.all` okozna.
 */
export const WORKSPACE_IO_CONCURRENCY = Number(process.env.WORKSPACE_IO_CONCURRENCY ?? 24)

function maxWorkspaceSizeBytes(): number {
  return Number(process.env.WORKSPACE_MAX_BYTES ?? 500 * 1024 * 1024)
}
const SIGNED_URL_TTL_SECONDS = 15 * 60

export class FileEditorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'FileEditorError'
  }
}

type StubEntry = { content: Buffer; updatedAt: Date }

// Tiszta memória-stub (FILE_EDITOR_STUB_MEMORY=true). Next dev alatt a
// server action-ök és az API route-ok külön modulpéldányt kaphatnak — ezért
// globalThis-en osztjuk a Map-et.
const globalStub = globalThis as typeof globalThis & {
  __workspaceStubStore__?: Map<string, StubEntry>
}
const stubStore: Map<string, StubEntry> = (globalStub.__workspaceStubStore__ ??= new Map<
  string,
  StubEntry
>())

function isStubEnabled(): boolean {
  return process.env.FILE_EDITOR_STUB === 'true'
}

/** E2E/unit: ne írjon lemezre, restart után üres legyen. */
function isMemoryStub(): boolean {
  return process.env.FILE_EDITOR_STUB_MEMORY === 'true'
}

function stubRootDir(): string {
  const configured = process.env.WORKSPACE_STUB_DIR?.trim()
  return path.resolve(configured && configured.length > 0 ? configured : path.join(process.cwd(), '.data', 'workspace'))
}

function stubKey(tenantId: string, ticketId: string, filePath: string): string {
  return `${tenantId}/${ticketId}/${filePath}`
}

function stubAbsolutePath(tenantId: string, ticketId: string, filePath: string): string {
  const root = stubRootDir()
  const absolute = path.resolve(root, tenantId, ticketId, filePath)
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  if (absolute !== root && !absolute.startsWith(rootPrefix)) {
    throw new FileEditorError('INVALID_PATH', 'Path escapes workspace stub root')
  }
  return absolute
}

async function walkFiles(dir: string, relativePrefix = ''): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: string[] = []
  for (const entry of entries) {
    const rel = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(absolute, rel)))
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out
}

/**
 * A token-feloldás lejárat-tudatosan CACHE-ELT (`@/lib/gcp-metadata-token`), így
 * egy fájlművelet-sorozat (repo-import, keresés) nem indít fájlonként egy-egy
 * metadata-körfordulót. A hibát a tár saját hibakódjára fordítjuk, hogy a hívók
 * eddigi `GCS_AUTH_FAILED` kezelése változatlan maradjon.
 */
async function resolveGcsToken(): Promise<string> {
  try {
    return await getGcpAccessToken()
  } catch (error) {
    throw new FileEditorError('GCS_AUTH_FAILED', error instanceof Error ? error.message : String(error))
  }
}

async function resolveServiceAccountEmail(): Promise<string> {
  try {
    return await getGcpServiceAccountEmail()
  } catch (error) {
    throw new FileEditorError('GCS_AUTH_FAILED', error instanceof Error ? error.message : String(error))
  }
}

function workspacePrefix(tenantId: string, ticketId: string): string {
  return `${tenantId}/${ticketId}/`
}

/** Fájl elérési út → bájtméret. Kvóta-számoláshoz és listázáshoz. */
export type WorkspaceFileSizes = Record<string, number>

/**
 * Egy import/írás-sorozat kvóta-könyvelése EGYETLEN kezdeti listázásból.
 *
 * Miért: a `write()` alapból minden egyes híváskor lekérdezte a teljes workspace
 * méretét (= teljes objektum-listázás, lapozva) ÉS a célfájl méretét. Egy 660
 * fájlos repo-import így ~1300 felesleges GCS-körfordulót indított, és a
 * költsége NÉGYZETESEN nőtt a repo méretével: minél nagyobb a repo, annál lassabb
 * lett benne MINDEN egyes fájl kiírása. Üzleti hatás: a `repo_prepare` 44
 * másodpercig tartott, amíg a felhasználó a chatben várt — és nagyobb repónál ez
 * a percek felé nő.
 *
 * A session egyszer olvassa be a fájl→méret képet, utána memóriában könyvel. A
 * kvóta-plafon ugyanaz marad, csak nem hálózatról számoljuk újra fájlonként.
 * Fontos: a session pillanatkép — párhuzamosan futó MÁSIK írás (más folyamat)
 * nem látszik benne, ezért csak egy összefüggő művelet (import) idejére nyisd.
 */
export class WorkspaceQuotaSession {
  private constructor(
    private total: number,
    private readonly sizes: WorkspaceFileSizes,
  ) {}

  static fromSizes(sizes: WorkspaceFileSizes): WorkspaceQuotaSession {
    const total = Object.values(sizes).reduce((sum, size) => sum + size, 0)
    return new WorkspaceQuotaSession(total, { ...sizes })
  }

  /** Aktuális (könyvelt) workspace-méret bájtban. */
  get totalBytes(): number {
    return this.total
  }

  /**
   * Egy írás elkönyvelése. Túllépésnél ugyanazt a hibát dobja, mint a
   * fájlonkénti ellenőrzés — a hívó szempontjából a viselkedés változatlan.
   */
  reserve(filePath: string, newSize: number): void {
    const existing = this.sizes[filePath] ?? 0
    const projected = this.total - existing + newSize
    if (projected > maxWorkspaceSizeBytes()) {
      throw new FileEditorError(
        'WORKSPACE_TOO_LARGE',
        `Workspace would exceed 500 MB limit (${projected} bytes projected)`,
      )
    }
    this.total = projected
    this.sizes[filePath] = newSize
  }

  /** Törlés elkönyvelése (a felszabaduló hely azonnal újra kiosztható). */
  release(filePath: string): void {
    const existing = this.sizes[filePath]
    if (existing === undefined) return
    this.total -= existing
    delete this.sizes[filePath]
  }
}

function toHex(buffer: Buffer): string {
  return buffer.toString('hex')
}

async function signStringWithIam(stringToSign: string): Promise<string> {
  const email = await resolveServiceAccountEmail()
  const token = await resolveGcsToken()
  const res = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:signBlob`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ payload: Buffer.from(stringToSign, 'utf8').toString('base64') }),
    },
  )
  if (!res.ok) {
    throw new FileEditorError('GCS_SIGN_FAILED', `IAM signBlob failed: HTTP ${res.status}`)
  }
  const data = (await res.json()) as { signedBlob: string }
  return toHex(Buffer.from(data.signedBlob, 'base64'))
}

export class WorkspaceStorage {
  constructor(private readonly bucket: string) {}

  private isStub(): boolean {
    return isStubEnabled()
  }

  private usesMemoryStub(): boolean {
    return this.isStub() && isMemoryStub()
  }

  async getFileSize(tenantId: string, ticketId: string, filePath: string): Promise<number> {
    if (this.usesMemoryStub()) {
      return stubStore.get(stubKey(tenantId, ticketId, filePath))?.content.length ?? 0
    }
    if (this.isStub()) {
      try {
        const stat = await fs.stat(stubAbsolutePath(tenantId, ticketId, filePath))
        return stat.isFile() ? stat.size : 0
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw error
      }
    }

    const token = await resolveGcsToken()
    const objectName = encodeURIComponent(`${workspacePrefix(tenantId, ticketId)}${filePath}`)
    const url = `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${objectName}?fields=size`
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 404) return 0
    if (!res.ok) throw new FileEditorError('GCS_READ_FAILED', `GCS metadata failed: HTTP ${res.status}`)
    const data = (await res.json()) as { size?: string }
    return Number(data.size ?? 0)
  }

  /**
   * GCS objektum-listázás LAPOZVA (név + méret). A korábbi listázás egyetlen,
   * `maxResults=1000`-es oldalt kért és a `nextPageToken`-t eldobta: 1000 fájl
   * fölött NÉMÁN csonkolt. Mivel a repo-import alapértelmezett plafonja 1200
   * fájl, egy nagyobb repo importálása után a `file_search` és a PR-diff a
   * fájlok egy részét egyszerűen nem látta — hibaüzenet nélkül, hiányos válasz
   * vagy hiányos pull request formájában.
   */
  private async listGcsObjects(prefix: string): Promise<Array<{ name: string; size: number }>> {
    const token = await resolveGcsToken()
    const out: Array<{ name: string; size: number }> = []
    let pageToken: string | undefined

    do {
      const params = new URLSearchParams({
        prefix,
        maxResults: '1000',
        fields: 'items(name,size),nextPageToken',
      })
      if (pageToken) params.set('pageToken', pageToken)
      const url = `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o?${params}`
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
      if (!res.ok) throw new FileEditorError('GCS_LIST_FAILED', `GCS list failed: HTTP ${res.status}`)
      const data = (await res.json()) as {
        items?: Array<{ name: string; size?: string }>
        nextPageToken?: string
      }
      for (const item of data.items ?? []) {
        out.push({ name: item.name, size: Number(item.size ?? 0) })
      }
      pageToken = data.nextPageToken
    } while (pageToken)

    return out
  }

  /** Fájl → méret kép egy workspace-ről, EGYETLEN (lapozott) listázásból. */
  async listFileSizes(tenantId: string, ticketId: string): Promise<WorkspaceFileSizes> {
    const prefix = workspacePrefix(tenantId, ticketId)

    if (this.usesMemoryStub()) {
      const sizes: WorkspaceFileSizes = {}
      for (const [key, entry] of stubStore) {
        if (key.startsWith(prefix)) sizes[key.slice(prefix.length)] = entry.content.length
      }
      return sizes
    }
    if (this.isStub()) {
      const ticketRoot = path.join(stubRootDir(), tenantId, ticketId)
      const files = await walkFiles(ticketRoot)
      const sizes: WorkspaceFileSizes = {}
      await Promise.all(
        files.map(async (filePath) => {
          try {
            const stat = await fs.stat(path.join(ticketRoot, filePath))
            sizes[filePath] = stat.isFile() ? stat.size : 0
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }),
      )
      return sizes
    }

    const items = await this.listGcsObjects(prefix)
    const sizes: WorkspaceFileSizes = {}
    for (const item of items) sizes[item.name.slice(prefix.length)] = item.size
    return sizes
  }

  /**
   * Kvóta-session nyitása egy összefüggő írás-sorozathoz (pl. repo-import). A
   * hívó ezt adja át a `write`-nak, így a kvóta-ellenőrzés nem indít fájlonként
   * teljes workspace-listázást.
   */
  async openQuotaSession(tenantId: string, ticketId: string): Promise<WorkspaceQuotaSession> {
    return WorkspaceQuotaSession.fromSizes(await this.listFileSizes(tenantId, ticketId))
  }

  async getWorkspaceSize(tenantId: string, ticketId: string): Promise<number> {
    const sizes = await this.listFileSizes(tenantId, ticketId)
    return Object.values(sizes).reduce((sum, size) => sum + size, 0)
  }

  private async ensureWorkspaceQuota(
    tenantId: string,
    ticketId: string,
    filePath: string,
    newSize: number,
  ): Promise<void> {
    const [currentTotal, existingSize] = await Promise.all([
      this.getWorkspaceSize(tenantId, ticketId),
      this.getFileSize(tenantId, ticketId, filePath),
    ])
    const projected = currentTotal - existingSize + newSize
    if (projected > maxWorkspaceSizeBytes()) {
      throw new FileEditorError(
        'WORKSPACE_TOO_LARGE',
        `Workspace would exceed 500 MB limit (${projected} bytes projected)`,
      )
    }
  }

  async read(tenantId: string, ticketId: string, filePath: string): Promise<Buffer | null> {
    if (this.usesMemoryStub()) {
      return stubStore.get(stubKey(tenantId, ticketId, filePath))?.content ?? null
    }
    if (this.isStub()) {
      try {
        const buf = await fs.readFile(stubAbsolutePath(tenantId, ticketId, filePath))
        if (buf.length > MAX_FILE_SIZE_BYTES) {
          throw new FileEditorError('FILE_TOO_LARGE', 'File exceeds 50 MB read limit')
        }
        return buf
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    }

    const token = await resolveGcsToken()
    const objectName = encodeURIComponent(`${workspacePrefix(tenantId, ticketId)}${filePath}`)
    const url = `https://storage.googleapis.com/download/storage/v1/b/${this.bucket}/o/${objectName}?alt=media`
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 404) return null
    if (!res.ok) throw new FileEditorError('GCS_READ_FAILED', `GCS read failed: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_FILE_SIZE_BYTES) {
      throw new FileEditorError('FILE_TOO_LARGE', 'File exceeds 50 MB read limit')
    }
    return buf
  }

  async write(
    tenantId: string,
    ticketId: string,
    filePath: string,
    data: Buffer,
    opts: { quota?: WorkspaceQuotaSession } = {},
  ): Promise<void> {
    if (data.length > MAX_FILE_SIZE_BYTES) {
      throw new FileEditorError('FILE_TOO_LARGE', 'File exceeds 50 MB write limit')
    }
    if (opts.quota) {
      // Köteg-mód: a kvótát a session könyveli memóriában (egyetlen kezdeti
      // listázásból), nem fájlonkénti hálózati újraszámolásból.
      opts.quota.reserve(filePath, data.length)
    } else {
      await this.ensureWorkspaceQuota(tenantId, ticketId, filePath, data.length)
    }

    if (this.usesMemoryStub()) {
      stubStore.set(stubKey(tenantId, ticketId, filePath), { content: data, updatedAt: new Date() })
      return
    }
    if (this.isStub()) {
      const absolute = stubAbsolutePath(tenantId, ticketId, filePath)
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, data)
      return
    }

    const token = await resolveGcsToken()
    const objectName = `${workspacePrefix(tenantId, ticketId)}${filePath}`
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`
    const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
      },
      body,
    })
    if (!res.ok) throw new FileEditorError('GCS_WRITE_FAILED', `GCS write failed: HTTP ${res.status}`)
  }

  async delete(tenantId: string, ticketId: string, filePath: string): Promise<void> {
    if (this.usesMemoryStub()) {
      stubStore.delete(stubKey(tenantId, ticketId, filePath))
      return
    }
    if (this.isStub()) {
      try {
        await fs.unlink(stubAbsolutePath(tenantId, ticketId, filePath))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      return
    }

    const token = await resolveGcsToken()
    const objectName = encodeURIComponent(`${workspacePrefix(tenantId, ticketId)}${filePath}`)
    const url = `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${objectName}`
    const res = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
    if (res.status === 404) return
    if (!res.ok) throw new FileEditorError('GCS_DELETE_FAILED', `GCS delete failed: HTTP ${res.status}`)
  }

  async deleteTicketWorkspace(tenantId: string, ticketId: string): Promise<number> {
    const paths = await this.list(tenantId, ticketId)
    if (this.isStub() && !this.usesMemoryStub()) {
      try {
        await fs.rm(path.join(stubRootDir(), tenantId, ticketId), { recursive: true, force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return paths.length
    }
    for (const filePath of paths) {
      await this.delete(tenantId, ticketId, filePath)
    }
    return paths.length
  }

  async deleteTenantWorkspaces(tenantId: string): Promise<number> {
    const prefix = `${tenantId}/`

    if (this.usesMemoryStub()) {
      let deleted = 0
      for (const key of [...stubStore.keys()]) {
        if (key.startsWith(prefix)) {
          stubStore.delete(key)
          deleted++
        }
      }
      return deleted
    }
    if (this.isStub()) {
      const tenantDir = path.join(stubRootDir(), tenantId)
      const files = await walkFiles(tenantDir)
      try {
        await fs.rm(tenantDir, { recursive: true, force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return files.length
    }

    const token = await resolveGcsToken()
    let pageToken: string | undefined
    let deleted = 0

    do {
      const params = new URLSearchParams({ prefix, maxResults: '1000' })
      if (pageToken) params.set('pageToken', pageToken)
      const listUrl = `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o?${params}`
      const listRes = await fetch(listUrl, { headers: { authorization: `Bearer ${token}` } })
      if (!listRes.ok) {
        throw new FileEditorError('GCS_LIST_FAILED', `GCS tenant list failed: HTTP ${listRes.status}`)
      }
      const data = (await listRes.json()) as {
        items?: Array<{ name: string }>
        nextPageToken?: string
      }
      for (const item of data.items ?? []) {
        const objectName = encodeURIComponent(item.name)
        const delUrl = `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${objectName}`
        const delRes = await fetch(delUrl, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        })
        if (delRes.ok || delRes.status === 404) deleted++
      }
      pageToken = data.nextPageToken
    } while (pageToken)

    return deleted
  }

  async list(tenantId: string, ticketId: string, subpath?: string): Promise<string[]> {
    const prefix = workspacePrefix(tenantId, ticketId) + (subpath ? `${subpath}/` : '')
    const prefixLen = workspacePrefix(tenantId, ticketId).length

    if (this.usesMemoryStub()) {
      const results: string[] = []
      for (const key of stubStore.keys()) {
        if (key.startsWith(prefix)) {
          results.push(key.slice(prefixLen))
        }
      }
      return results.sort()
    }
    if (this.isStub()) {
      const ticketRoot = path.join(stubRootDir(), tenantId, ticketId)
      const walkRoot = subpath ? path.join(ticketRoot, subpath) : ticketRoot
      const relativePrefix = subpath ?? ''
      const files = await walkFiles(walkRoot, relativePrefix)
      return files.sort()
    }

    const items = await this.listGcsObjects(prefix)
    return items.map((item) => item.name.slice(prefixLen)).sort()
  }

  /**
   * Törlés kötegelve, KORLÁTOZOTT párhuzamossággal. A hívók korábban egy
   * `Promise.all(...)`-lal indították az összes törlést egyszerre — 660 fájlnál
   * ez 660 egyidejű HTTPS-kapcsolat, ami socket-kimerülést és GCS-oldali 429-et
   * hoz. A pool a párhuzamosság előnyét megtartja, a torlódást nem.
   */
  async deleteMany(tenantId: string, ticketId: string, filePaths: string[]): Promise<number> {
    let nextIndex = 0
    let deleted = 0
    const worker = async (): Promise<void> => {
      while (nextIndex < filePaths.length) {
        const filePath = filePaths[nextIndex]
        nextIndex += 1
        await this.delete(tenantId, ticketId, filePath)
        deleted += 1
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(WORKSPACE_IO_CONCURRENCY, filePaths.length) }, () => worker()),
    )
    return deleted
  }

  /**
   * A fájl eredetét fájlonkénti, rejtett marker tartja nyilván. Ez párhuzamos
   * feltöltés/agent-írás esetén sem írja felül egy másik fájl besorolását.
   */
  async setFileAudience(
    tenantId: string,
    ticketId: string,
    filePath: string,
    audience: WorkspaceFileAudience,
  ): Promise<void> {
    await this.write(
      tenantId,
      ticketId,
      `${WORKSPACE_FILE_AUDIENCE_PREFIX}${Buffer.from(filePath, 'utf8').toString('base64url')}`,
      Buffer.from(audience, 'utf8'),
    )
  }

  async listUserFacing(tenantId: string, ticketId: string): Promise<string[]> {
    const [files, audiences] = await Promise.all([
      this.list(tenantId, ticketId),
      this.readFileAudiences(tenantId, ticketId),
    ])
    return files.filter((path) => isWorkspaceFileUserFacing(path, audiences[path]))
  }

  private async readFileAudiences(
    tenantId: string,
    ticketId: string,
  ): Promise<Record<string, WorkspaceFileAudience>> {
    const audiences = await this.readLegacyFileAudiences(tenantId, ticketId)
    try {
      const markers = await this.list(tenantId, ticketId, WORKSPACE_FILE_AUDIENCE_PREFIX.slice(0, -1))
      await Promise.all(
        markers.map(async (marker) => {
          const encodedPath = marker.split('/').pop()
          if (!encodedPath) return
          const path = Buffer.from(encodedPath, 'base64url').toString('utf8')
          const value = await this.read(tenantId, ticketId, marker)
          const audience = value?.toString('utf8')
          if (audience === 'user' || audience === 'internal') audiences[path] = audience
        }),
      )
      return audiences
    } catch {
      return audiences
    }
  }

  private async readLegacyFileAudiences(
    tenantId: string,
    ticketId: string,
  ): Promise<Record<string, WorkspaceFileAudience>> {
    const manifest = await this.read(tenantId, ticketId, WORKSPACE_FILE_AUDIENCE_MANIFEST)
    if (!manifest) return {}
    try {
      const parsed: unknown = JSON.parse(manifest.toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return Object.fromEntries(
        Object.entries(parsed).filter(
          ([, audience]) => audience === 'user' || audience === 'internal',
        ),
      ) as Record<string, WorkspaceFileAudience>
    } catch {
      return {}
    }
  }

  async getSignedDownloadUrl(
    tenantId: string,
    ticketId: string,
    filePath: string,
    opts: { expiresInSeconds?: number; stubDownloadPath?: string } = {},
  ): Promise<{ url: string; expiresAt: Date }> {
    const expiresInSeconds = opts.expiresInSeconds ?? SIGNED_URL_TTL_SECONDS
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000)

    if (this.isStub()) {
      // Stubban nincs GCS — a kliens a saját route stream-ágát hívja. A hívó
      // route adja meg a saját letöltési útját (ticket vagy conversation),
      // különben tévútra (más erőforrásra) mutatna a link.
      const base = opts.stubDownloadPath ?? `/api/v1/tickets/${ticketId}/workspace/files`
      return {
        url: `${base}?path=${encodeURIComponent(filePath)}`,
        expiresAt,
      }
    }

    const objectPath = `${workspacePrefix(tenantId, ticketId)}${filePath}`
    const host = 'storage.googleapis.com'
    const now = new Date()
    const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '')
    const requestTimestamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
    const credential = await resolveServiceAccountEmail()
    const credentialScope = `${dateStamp}/auto/storage/goog4_request`

    const canonicalQuery = new URLSearchParams({
      'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
      'X-Goog-Credential': `${credential}/${credentialScope}`,
      'X-Goog-Date': requestTimestamp,
      'X-Goog-Expires': String(expiresInSeconds),
      'X-Goog-SignedHeaders': 'host',
    })
    const sortedQuery = [...canonicalQuery.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')

    const canonicalRequest = [
      'GET',
      `/${this.bucket}/${objectPath}`,
      sortedQuery,
      `host:${host}`,
      '',
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n')

    const stringToSign = [
      'GOOG4-RSA-SHA256',
      requestTimestamp,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n')

    const signature = await signStringWithIam(stringToSign)
    const url = `https://${host}/${this.bucket}/${objectPath}?${sortedQuery}&X-Goog-Signature=${signature}`
    return { url, expiresAt }
  }

  async streamToClient(
    tenantId: string,
    ticketId: string,
    filePath: string,
  ): Promise<{ stream: ReadableStream; contentType: string; size: number } | null> {
    if (this.isStub()) {
      const buf = this.usesMemoryStub()
        ? stubStore.get(stubKey(tenantId, ticketId, filePath))?.content ?? null
        : await this.read(tenantId, ticketId, filePath)
      if (!buf) return null
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue(buf)
            controller.close()
          },
        }),
        contentType: 'application/octet-stream',
        size: buf.length,
      }
    }

    const token = await resolveGcsToken()
    const objectName = encodeURIComponent(`${workspacePrefix(tenantId, ticketId)}${filePath}`)
    const url = `https://storage.googleapis.com/download/storage/v1/b/${this.bucket}/o/${objectName}?alt=media`
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 404) return null
    if (!res.ok) throw new FileEditorError('GCS_READ_FAILED', `GCS stream failed: HTTP ${res.status}`)
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    const size = Number(res.headers.get('content-length') ?? '0')
    return { stream: res.body!, contentType, size }
  }
}
