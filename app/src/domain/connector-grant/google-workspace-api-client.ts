/**
 * Google Docs / Sheets / Slides REST adapter — issue #378 §4.2 native edit toolok.
 * Stub mód: GOOGLE_WORKSPACE_API_STUB=true vagy GOOGLE_DRIVE_API_STUB=true.
 */
export type DocsEditOperation = Record<string, unknown>
export type SlidesEditOperation = Record<string, unknown>

const DOCS_BASE = 'https://docs.googleapis.com/v1'
const SHEETS_BASE = 'https://sheets.googleapis.com/v4'
const SLIDES_BASE = 'https://slides.googleapis.com/v1'

export class GoogleWorkspaceApiAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'GoogleWorkspaceApiAuthError'
  }
}

export class GoogleWorkspaceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'GoogleWorkspaceApiError'
  }
}

function workspaceApiError(operation: string, status: number, body?: string): Error {
  if (status === 401 || status === 403) {
    return new GoogleWorkspaceApiAuthError(`${operation} auth failed: ${status}`, status)
  }
  return new GoogleWorkspaceApiError(
    `${operation} failed: ${status}${body ? ` · ${body.slice(0, 200)}` : ''}`,
    status,
  )
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

function validateDocsOperation(op: DocsEditOperation): void {
  const keys = Object.keys(op)
  if (keys.length !== 1) {
    throw new Error('DocsEditOperation must have exactly one top-level key')
  }
  const allowed = new Set(['insertText', 'replaceAllText', 'deleteContentRange'])
  if (!allowed.has(keys[0])) {
    throw new Error(`Unsupported DocsEditOperation: ${keys[0]}`)
  }
}

function validateSlidesOperation(op: SlidesEditOperation): void {
  const keys = Object.keys(op)
  if (keys.length !== 1) {
    throw new Error('SlidesEditOperation must have exactly one top-level key')
  }
  const allowed = new Set(['replaceAllText', 'deleteObject', 'insertText'])
  if (!allowed.has(keys[0])) {
    throw new Error(`Unsupported SlidesEditOperation: ${keys[0]}`)
  }
}

export class GoogleWorkspaceApiClient {
  constructor(private readonly accessToken: string) {}

  private isStub(): boolean {
    return (
      process.env.GOOGLE_WORKSPACE_API_STUB === 'true' ||
      process.env.GOOGLE_DRIVE_API_STUB === 'true'
    )
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` }
  }

  async applyDocsEdits(fileId: string, operations: DocsEditOperation[]): Promise<void> {
    if (operations.length === 0) throw new Error('google_docs_apply_edits requires operations')
    for (const op of operations) validateDocsOperation(op)
    if (this.isStub()) return

    const url = `${DOCS_BASE}/documents/${encodeURIComponent(fileId)}:batchUpdate`
    const res = await fetchWithBackoff('google_docs_apply_edits', url, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ requests: operations }),
    })
    if (!res.ok) {
      throw workspaceApiError('google_docs_apply_edits', res.status, await res.text())
    }
  }

  async writeSheetsRange(params: {
    fileId: string
    range: string
    values: unknown[][]
    mode?: 'replace' | 'append'
  }): Promise<{ updatedCells?: number }> {
    if (params.values.length === 0) {
      throw new Error('google_sheets_write_range requires values')
    }
    if (this.isStub()) {
      const cells = params.values.reduce((sum, row) => sum + row.length, 0)
      return { updatedCells: cells }
    }

    const mode = params.mode ?? 'replace'
    const encodedRange = encodeURIComponent(params.range)
    const base = `${SHEETS_BASE}/spreadsheets/${encodeURIComponent(params.fileId)}/values/${encodedRange}`
    const url =
      mode === 'append'
        ? `${base}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
        : `${base}?valueInputOption=USER_ENTERED`

    const res = await fetchWithBackoff('google_sheets_write_range', url, {
      method: mode === 'append' ? 'POST' : 'PUT',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ values: params.values }),
    })
    if (!res.ok) {
      throw workspaceApiError('google_sheets_write_range', res.status, await res.text())
    }
    const data = (await res.json()) as { updatedCells?: number }
    return { updatedCells: data.updatedCells }
  }

  async applySlidesEdits(fileId: string, operations: SlidesEditOperation[]): Promise<void> {
    if (operations.length === 0) throw new Error('google_slides_apply_edits requires operations')
    for (const op of operations) validateSlidesOperation(op)
    if (this.isStub()) return

    const url = `${SLIDES_BASE}/presentations/${encodeURIComponent(fileId)}:batchUpdate`
    const res = await fetchWithBackoff('google_slides_apply_edits', url, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ requests: operations }),
    })
    if (!res.ok) {
      throw workspaceApiError('google_slides_apply_edits', res.status, await res.text())
    }
  }
}
