/**
 * Google Drive REST API v3 thin adapter — a Tool Broker mögött (issue #378).
 * Stub mód acceptance / dev tesztekhez (GOOGLE_DRIVE_API_STUB=true).
 */
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'

export type DriveFileSummary = {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  size?: string
  webViewLink?: string
  driveId?: string
  trashed?: boolean
  parents?: string[]
}

export type DriveReadResult = {
  file: DriveFileSummary
  contentType: string
  text?: string
  truncated: boolean
  warnings: string[]
}

const STUB_FILES: DriveFileSummary[] = [
  {
    id: 'stub-file-1',
    name: 'Platform acceptance stub dokumentum',
    mimeType: 'application/vnd.google-apps.document',
    modifiedTime: new Date().toISOString(),
    webViewLink: 'https://drive.google.com/file/d/stub-file-1/view',
  },
  {
    id: 'stub-file-2',
    name: 'Teszt táblázat.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    modifiedTime: new Date().toISOString(),
    size: '4096',
  },
]

const GOOGLE_WORKSPACE_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
}

const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024
const MAX_TEXT_CHARS = 200_000

export class GoogleDriveApiAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'GoogleDriveApiAuthError'
  }
}

export class GoogleDriveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'GoogleDriveApiError'
  }
}

function driveApiError(operation: string, status: number, body?: string): Error {
  if (status === 401 || status === 403) {
    return new GoogleDriveApiAuthError(`${operation} auth failed: ${status}`, status)
  }
  return new GoogleDriveApiError(`${operation} failed: ${status}${body ? ` · ${body.slice(0, 200)}` : ''}`, status)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithBackoff(
  operation: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const delays = [250, 750]
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const res = await fetch(input, init)
    if (res.ok || res.status === 401 || res.status === 403 || res.status === 404) return res
    if (![429, 500, 502, 503, 504].includes(res.status) || attempt === delays.length) {
      return res
    }
    await sleep(delays[attempt])
  }
  throw new Error(`${operation} failed before response`)
}

function parseFileSummary(raw: Record<string, unknown>): DriveFileSummary | null {
  const id = String(raw.id ?? '')
  if (!id) return null
  return {
    id,
    name: String(raw.name ?? ''),
    mimeType: String(raw.mimeType ?? ''),
    modifiedTime: raw.modifiedTime ? String(raw.modifiedTime) : undefined,
    size: raw.size != null ? String(raw.size) : undefined,
    webViewLink: raw.webViewLink ? String(raw.webViewLink) : undefined,
    driveId: raw.driveId ? String(raw.driveId) : undefined,
    trashed: raw.trashed === true,
    parents: Array.isArray(raw.parents) ? raw.parents.map(String) : undefined,
  }
}

function sharedDriveParams(extra?: Record<string, string>): Record<string, string> {
  return {
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    ...extra,
  }
}

export class GoogleDriveApiClient {
  constructor(private accessToken: string) {}

  private isStub(): boolean {
    return process.env.GOOGLE_DRIVE_API_STUB === 'true' || this.accessToken.startsWith('stub-')
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.accessToken}`, ...extra }
  }

  async search(params: {
    query?: string
    nameContains?: string
    mimeTypes?: string[]
    modifiedAfter?: string
    driveId?: string
    pageSize?: number
    pageToken?: string
    signal?: AbortSignal
  }): Promise<{ files: DriveFileSummary[]; nextPageToken?: string }> {
    if (this.isStub()) {
      const q = (params.query ?? params.nameContains ?? '').toLowerCase()
      const hits = STUB_FILES.filter((f) => !q || f.name.toLowerCase().includes(q))
      return { files: hits.slice(0, params.pageSize ?? 25) }
    }

    const qParts: string[] = ['trashed = false']
    if (params.query) qParts.push(`(${params.query})`)
    if (params.nameContains) qParts.push(`name contains '${params.nameContains.replace(/'/g, "\\'")}'`)
    if (params.mimeTypes?.length) {
      const mimeQ = params.mimeTypes.map((m) => `mimeType='${m}'`).join(' or ')
      qParts.push(`(${mimeQ})`)
    }
    if (params.modifiedAfter) qParts.push(`modifiedTime > '${params.modifiedAfter}'`)

    const url = new URL(`${DRIVE_BASE}/files`)
    url.searchParams.set('q', qParts.join(' and '))
    url.searchParams.set('pageSize', String(params.pageSize ?? 25))
    url.searchParams.set(
      'fields',
      'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,driveId,trashed,parents)',
    )
    if (params.pageToken) url.searchParams.set('pageToken', params.pageToken)
    if (params.driveId) {
      url.searchParams.set('corpora', 'drive')
      url.searchParams.set('driveId', params.driveId)
    }
    for (const [key, value] of Object.entries(sharedDriveParams())) {
      url.searchParams.set(key, value)
    }

    const res = await fetchWithBackoff('google_drive.search', url, { headers: this.authHeaders(), signal: params.signal })
    if (!res.ok) throw driveApiError('google_drive.search', res.status, await res.text())
    const data = (await res.json()) as { files?: Record<string, unknown>[]; nextPageToken?: string }
    const files = (data.files ?? [])
      .map((raw) => parseFileSummary(raw))
      .filter((f): f is DriveFileSummary => f !== null)
    return { files, ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}) }
  }

  async getFile(params: { fileId: string }): Promise<DriveFileSummary> {
    if (this.isStub()) {
      const hit = STUB_FILES.find((f) => f.id === params.fileId) ?? STUB_FILES[0]
      return hit
    }

    const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(params.fileId)}`)
    url.searchParams.set(
      'fields',
      'id,name,mimeType,modifiedTime,size,webViewLink,driveId,trashed,parents',
    )
    for (const [key, value] of Object.entries(sharedDriveParams())) {
      url.searchParams.set(key, value)
    }

    const res = await fetchWithBackoff('google_drive.get_file', url, { headers: this.authHeaders() })
    if (!res.ok) throw driveApiError('google_drive.get_file', res.status, await res.text())
    const raw = (await res.json()) as Record<string, unknown>
    const file = parseFileSummary(raw)
    if (!file) throw new Error('google_drive.get_file: invalid payload')
    return file
  }

  async listDrives(params: {
    pageSize?: number
    pageToken?: string
  }): Promise<{ drives: Array<{ id: string; name: string }>; nextPageToken?: string }> {
    if (this.isStub()) {
      return { drives: [{ id: 'stub-drive-1', name: 'Stub Shared Drive' }] }
    }

    const url = new URL(`${DRIVE_BASE}/drives`)
    url.searchParams.set('pageSize', String(params.pageSize ?? 25))
    url.searchParams.set('fields', 'nextPageToken,drives(id,name)')
    if (params.pageToken) url.searchParams.set('pageToken', params.pageToken)

    const res = await fetchWithBackoff('google_drive.list_drives', url, { headers: this.authHeaders() })
    if (!res.ok) throw driveApiError('google_drive.list_drives', res.status, await res.text())
    const data = (await res.json()) as {
      drives?: Array<{ id?: string; name?: string }>
      nextPageToken?: string
    }
    const drives = (data.drives ?? [])
      .filter((d) => d.id && d.name)
      .map((d) => ({ id: d.id!, name: d.name! }))
    return { drives, ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}) }
  }

  async readFile(params: {
    fileId: string
    maxBytes?: number
  }): Promise<DriveReadResult> {
    const file = await this.getFile({ fileId: params.fileId })
    const maxBytes = params.maxBytes ?? MAX_DOWNLOAD_BYTES
    const warnings: string[] = []

    if (this.isStub()) {
      return {
        file,
        contentType: 'text/plain',
        text: `Stub tartalom: ${file.name}`,
        truncated: false,
        warnings,
      }
    }

    const exportMime = GOOGLE_WORKSPACE_EXPORT[file.mimeType]
    if (exportMime) {
      const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(params.fileId)}/export`)
      url.searchParams.set('mimeType', exportMime)
      for (const [key, value] of Object.entries(sharedDriveParams())) {
        url.searchParams.set(key, value)
      }
      const res = await fetchWithBackoff('google_drive.export', url, { headers: this.authHeaders() })
      if (!res.ok) throw driveApiError('google_drive.export', res.status, await res.text())
      let text = await res.text()
      let truncated = false
      if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS)
        truncated = true
        warnings.push('A kinyert szöveg csonkolva lett a méretkorlát miatt.')
      }
      return { file, contentType: exportMime, text, truncated, warnings }
    }

    if (file.size && Number(file.size) > maxBytes) {
      throw new GoogleDriveApiError(
        `A fájl túl nagy (${file.size} bájt, max ${maxBytes}).`,
        413,
        'file_too_large',
      )
    }

    const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(params.fileId)}`)
    url.searchParams.set('alt', 'media')
    for (const [key, value] of Object.entries(sharedDriveParams())) {
      url.searchParams.set(key, value)
    }
    const res = await fetchWithBackoff('google_drive.download', url, { headers: this.authHeaders() })
    if (!res.ok) throw driveApiError('google_drive.download', res.status, await res.text())

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    if (contentType.startsWith('text/') || contentType.includes('json')) {
      let text = await res.text()
      let truncated = false
      if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS)
        truncated = true
        warnings.push('A kinyert szöveg csonkolva lett a méretkorlát miatt.')
      }
      return { file, contentType, text, truncated, warnings }
    }

    warnings.push(
      'A bináris fájltípus közvetlen szövegként nem olvasható — használd a workspace dokumentum-olvasó eszközöket artifactRef-fel.',
    )
    return { file, contentType, truncated: false, warnings }
  }

  async createFolder(params: {
    name: string
    parentFolderId?: string
    signal?: AbortSignal
  }): Promise<{ file: DriveFileSummary; created: boolean }> {
    if (this.isStub()) {
      return {
        file: {
          id: `stub-folder-${Date.now()}`,
          name: params.name,
          mimeType: 'application/vnd.google-apps.folder',
          modifiedTime: new Date().toISOString(),
        },
        created: true,
      }
    }

    const metadata: Record<string, unknown> = {
      name: params.name,
      mimeType: 'application/vnd.google-apps.folder',
    }
    if (params.parentFolderId) metadata.parents = [params.parentFolderId]

    const url = new URL(`${DRIVE_BASE}/files`)
    for (const [key, value] of Object.entries(sharedDriveParams())) {
      url.searchParams.set(key, value)
    }
    url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size,webViewLink,driveId,parents')

    const res = await fetchWithBackoff('google_drive.create_folder', url, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(metadata),
      signal: params.signal,
    })
    if (!res.ok) throw driveApiError('google_drive.create_folder', res.status, await res.text())
    const raw = (await res.json()) as Record<string, unknown>
    const file = parseFileSummary(raw)
    if (!file) throw new Error('google_drive.create_folder: invalid payload')
    return { file, created: true }
  }

  async renameFile(params: { fileId: string; newName: string }): Promise<DriveFileSummary> {
    return this.patchMetadata(params.fileId, { name: params.newName })
  }

  async moveFile(params: {
    fileId: string
    destinationFolderId: string
  }): Promise<DriveFileSummary> {
    const existing = await this.getFile({ fileId: params.fileId })
    const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(params.fileId)}`)
    url.searchParams.set('addParents', params.destinationFolderId)
    if (existing.parents?.[0]) url.searchParams.set('removeParents', existing.parents[0])
    for (const [key, value] of Object.entries(sharedDriveParams())) {
      url.searchParams.set(key, value)
    }
    url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size,webViewLink,driveId,parents')

    const res = await fetchWithBackoff('google_drive.move_file', url, {
      method: 'PATCH',
      headers: this.authHeaders(),
    })
    if (!res.ok) throw driveApiError('google_drive.move_file', res.status, await res.text())
    const raw = (await res.json()) as Record<string, unknown>
    const file = parseFileSummary(raw)
    if (!file) throw new Error('google_drive.move_file: invalid payload')
    return file
  }

  async copyFile(params: {
    fileId: string
    newName?: string
    parentFolderId?: string
  }): Promise<{ file: DriveFileSummary; created: boolean }> {
    if (this.isStub()) {
      return {
        file: {
          id: `stub-copy-${Date.now()}`,
          name: params.newName ?? 'Másolat',
          mimeType: 'application/vnd.google-apps.document',
          modifiedTime: new Date().toISOString(),
        },
        created: true,
      }
    }

    const body: Record<string, unknown> = {}
    if (params.newName) body.name = params.newName
    if (params.parentFolderId) body.parents = [params.parentFolderId]

    const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(params.fileId)}/copy`)
    for (const [key, value] of Object.entries(sharedDriveParams())) {
      url.searchParams.set(key, value)
    }
    url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size,webViewLink,driveId,parents')

    const res = await fetchWithBackoff('google_drive.copy_file', url, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw driveApiError('google_drive.copy_file', res.status, await res.text())
    const raw = (await res.json()) as Record<string, unknown>
    const file = parseFileSummary(raw)
    if (!file) throw new Error('google_drive.copy_file: invalid payload')
    return { file, created: true }
  }

  async trashFile(params: { fileId: string; signal?: AbortSignal }): Promise<DriveFileSummary> {
    return this.patchMetadata(params.fileId, { trashed: true }, params.signal)
  }

  async restoreFile(params: { fileId: string }): Promise<DriveFileSummary> {
    return this.patchMetadata(params.fileId, { trashed: false })
  }

  async updateTextContent(params: {
    fileId: string
    textContent: string
    expectedModifiedTime?: string
  }): Promise<{ file: DriveFileSummary; conflict: boolean }> {
    if (params.expectedModifiedTime) {
      const existing = await this.getFile({ fileId: params.fileId })
      if (existing.modifiedTime && existing.modifiedTime !== params.expectedModifiedTime) {
        return { file: existing, conflict: true }
      }
    }

    if (this.isStub()) {
      const file = await this.getFile({ fileId: params.fileId })
      return { file, conflict: false }
    }

    const metadata = await this.getFile({ fileId: params.fileId })
    const url = new URL(`${UPLOAD_BASE}/files/${encodeURIComponent(params.fileId)}`)
    url.searchParams.set('uploadType', 'media')
    for (const [key, value] of Object.entries(sharedDriveParams())) {
      url.searchParams.set(key, value)
    }
    url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size,webViewLink,driveId,parents')

    const res = await fetchWithBackoff('google_drive.update_file', url, {
      method: 'PATCH',
      headers: {
        ...this.authHeaders(),
        'content-type': metadata.mimeType || 'text/plain',
      },
      body: params.textContent,
    })
    if (!res.ok) throw driveApiError('google_drive.update_file', res.status, await res.text())
    const raw = (await res.json()) as Record<string, unknown>
    const file = parseFileSummary(raw)
    if (!file) throw new Error('google_drive.update_file: invalid payload')
    return { file, conflict: false }
  }

  async shareFile(params: {
    fileId: string
    recipientType: 'user' | 'group'
    emailAddress: string
    role: 'reader' | 'commenter' | 'writer'
    sendNotificationEmail?: boolean
  }): Promise<{ permissionId: string }> {
    if (this.isStub()) {
      return { permissionId: `stub-perm-${Date.now()}` }
    }

    const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(params.fileId)}/permissions`)
    for (const [key, value] of Object.entries(sharedDriveParams())) {
      url.searchParams.set(key, value)
    }
    url.searchParams.set('fields', 'id')
    if (params.sendNotificationEmail === false) {
      url.searchParams.set('sendNotificationEmail', 'false')
    }

    const body = {
      type: params.recipientType,
      role: params.role,
      emailAddress: params.emailAddress,
    }

    const res = await fetchWithBackoff('google_drive.share_file', url, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw driveApiError('google_drive.share_file', res.status, await res.text())
    const data = (await res.json()) as { id?: string }
    return { permissionId: data.id ?? 'unknown' }
  }

  private async patchMetadata(
    fileId: string,
    patch: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<DriveFileSummary> {
    if (this.isStub()) {
      const existing = await this.getFile({ fileId })
      return { ...existing, ...patch } as DriveFileSummary
    }

    const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`)
    for (const [key, value] of Object.entries(sharedDriveParams())) {
      url.searchParams.set(key, value)
    }
    url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size,webViewLink,driveId,trashed,parents')

    const res = await fetchWithBackoff('google_drive.patch', url, {
      method: 'PATCH',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(patch),
      signal,
    })
    if (!res.ok) throw driveApiError('google_drive.patch', res.status, await res.text())
    const raw = (await res.json()) as Record<string, unknown>
    const file = parseFileSummary(raw)
    if (!file) throw new Error('google_drive.patch: invalid payload')
    return file
  }
}
