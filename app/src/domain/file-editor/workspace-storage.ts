import { createHash } from 'node:crypto'

/**
 * GCS workspace storage adapter.
 * FILE_EDITOR_STUB=true → in-memory store (test/dev).
 * Production: GCS REST API via ambient Cloud Run service account.
 */

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024

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
const stubStore = new Map<string, StubEntry>()

function stubKey(tenantId: string, ticketId: string, filePath: string): string {
  return `${tenantId}/${ticketId}/${filePath}`
}

function ticketStubPrefix(tenantId: string, ticketId: string): string {
  return `${tenantId}/${ticketId}/`
}

async function resolveGcsToken(): Promise<string> {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  )
  if (!res.ok) throw new FileEditorError('GCS_AUTH_FAILED', `Metadata server returned ${res.status}`)
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

async function resolveServiceAccountEmail(): Promise<string> {
  if (process.env.GCS_SERVICE_ACCOUNT_EMAIL?.trim()) {
    return process.env.GCS_SERVICE_ACCOUNT_EMAIL.trim()
  }
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email',
    { headers: { 'Metadata-Flavor': 'Google' } },
  )
  if (!res.ok) throw new FileEditorError('GCS_AUTH_FAILED', `Metadata server returned ${res.status}`)
  return res.text()
}

function workspacePrefix(tenantId: string, ticketId: string): string {
  return `${tenantId}/${ticketId}/`
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
    return process.env.FILE_EDITOR_STUB === 'true'
  }

  async getFileSize(tenantId: string, ticketId: string, filePath: string): Promise<number> {
    if (this.isStub()) {
      return stubStore.get(stubKey(tenantId, ticketId, filePath))?.content.length ?? 0
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

  async getWorkspaceSize(tenantId: string, ticketId: string): Promise<number> {
    const prefix = ticketStubPrefix(tenantId, ticketId)

    if (this.isStub()) {
      let total = 0
      for (const [key, entry] of stubStore) {
        if (key.startsWith(prefix)) total += entry.content.length
      }
      return total
    }

    const token = await resolveGcsToken()
    let pageToken: string | undefined
    let total = 0

    do {
      const params = new URLSearchParams({
        prefix: workspacePrefix(tenantId, ticketId),
        maxResults: '1000',
        fields: 'items/size,nextPageToken',
      })
      if (pageToken) params.set('pageToken', pageToken)
      const url = `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o?${params}`
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
      if (!res.ok) throw new FileEditorError('GCS_LIST_FAILED', `GCS list failed: HTTP ${res.status}`)
      const data = (await res.json()) as { items?: Array<{ size?: string }>; nextPageToken?: string }
      for (const item of data.items ?? []) {
        total += Number(item.size ?? 0)
      }
      pageToken = data.nextPageToken
    } while (pageToken)

    return total
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
    if (this.isStub()) {
      return stubStore.get(stubKey(tenantId, ticketId, filePath))?.content ?? null
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

  async write(tenantId: string, ticketId: string, filePath: string, data: Buffer): Promise<void> {
    if (data.length > MAX_FILE_SIZE_BYTES) {
      throw new FileEditorError('FILE_TOO_LARGE', 'File exceeds 50 MB write limit')
    }
    await this.ensureWorkspaceQuota(tenantId, ticketId, filePath, data.length)

    if (this.isStub()) {
      stubStore.set(stubKey(tenantId, ticketId, filePath), { content: data, updatedAt: new Date() })
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
    if (this.isStub()) {
      stubStore.delete(stubKey(tenantId, ticketId, filePath))
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
    for (const filePath of paths) {
      await this.delete(tenantId, ticketId, filePath)
    }
    return paths.length
  }

  async deleteTenantWorkspaces(tenantId: string): Promise<number> {
    const prefix = `${tenantId}/`

    if (this.isStub()) {
      let deleted = 0
      for (const key of [...stubStore.keys()]) {
        if (key.startsWith(prefix)) {
          stubStore.delete(key)
          deleted++
        }
      }
      return deleted
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

    if (this.isStub()) {
      const results: string[] = []
      for (const key of stubStore.keys()) {
        if (key.startsWith(prefix)) {
          results.push(key.slice(prefixLen))
        }
      }
      return results.sort()
    }

    const token = await resolveGcsToken()
    const url = `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o?prefix=${encodeURIComponent(prefix)}&maxResults=1000`
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) throw new FileEditorError('GCS_LIST_FAILED', `GCS list failed: HTTP ${res.status}`)
    const data = (await res.json()) as { items?: Array<{ name: string }> }
    return (data.items ?? []).map((item) => item.name.slice(prefixLen)).sort()
  }

  async getSignedDownloadUrl(
    tenantId: string,
    ticketId: string,
    filePath: string,
    expiresInSeconds = SIGNED_URL_TTL_SECONDS,
  ): Promise<{ url: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000)

    if (this.isStub()) {
      return {
        url: `/api/v1/tickets/${ticketId}/workspace/files?path=${encodeURIComponent(filePath)}`,
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
      const entry = stubStore.get(stubKey(tenantId, ticketId, filePath))
      if (!entry) return null
      const buf = entry.content
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
