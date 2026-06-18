/**
 * GCS workspace storage adapter.
 * FILE_EDITOR_STUB=true → in-memory store (test/dev).
 * Production: GCS REST API via ambient Cloud Run service account.
 */

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024

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

async function resolveGcsToken(): Promise<string> {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  )
  if (!res.ok) throw new FileEditorError('GCS_AUTH_FAILED', `Metadata server returned ${res.status}`)
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

function workspacePrefix(tenantId: string, ticketId: string): string {
  return `${tenantId}/${ticketId}/`
}

export class WorkspaceStorage {
  constructor(private readonly bucket: string) {}

  private isStub(): boolean {
    return process.env.FILE_EDITOR_STUB === 'true'
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

    if (this.isStub()) {
      stubStore.set(stubKey(tenantId, ticketId, filePath), { content: data, updatedAt: new Date() })
      return
    }

    const token = await resolveGcsToken()
    const objectName = `${workspacePrefix(tenantId, ticketId)}${filePath}`
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
      },
      body: data,
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
