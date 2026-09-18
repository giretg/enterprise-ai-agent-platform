/**
 * Workspace HTML előnézet betöltése fetch-csel, gateway-hiba felismeréssel.
 *
 * Az iframe `src={apiUrl}` a Cloud Run/Envoy
 * „upstream connect error … connection termination" hiboldalát riportként
 * jelenítené meg: a böngésző a 503 törzsét is dokumentumként rendereli, és
 * nem próbálkozik újra. A fetch ugyanazt a same-origin kérést küldi (sütivel),
 * de a proxy hibáját felismeri, hideg instance esetén újrapróbálja, és soha
 * nem adja tovább a gateway szövegét HTML-ként.
 */

export const WORKSPACE_HTML_PREVIEW_GATEWAY_MESSAGE =
  'A riport most nem nyílt meg, mert a kapcsolat a megnyitás közben megszakadt. Próbáld újra.'

export const WORKSPACE_HTML_PREVIEW_NOT_FOUND_MESSAGE = 'A riport fájl nem található.'

export const WORKSPACE_HTML_PREVIEW_UNAUTHORIZED_MESSAGE =
  'A riport megnyitásához be kell jelentkezned.'

export const WORKSPACE_HTML_PREVIEW_INVALID_MESSAGE = 'A riport nem jeleníthető meg.'

export type WorkspaceHtmlPreviewErrorCode =
  | 'gateway'
  | 'not_found'
  | 'unauthorized'
  | 'invalid'
  | 'network'

export class WorkspaceHtmlPreviewError extends Error {
  readonly code: WorkspaceHtmlPreviewErrorCode
  readonly retryable: boolean

  constructor(code: WorkspaceHtmlPreviewErrorCode, message: string, retryable: boolean) {
    super(message)
    this.name = 'WorkspaceHtmlPreviewError'
    this.code = code
    this.retryable = retryable
  }
}

const GATEWAY_TERMINATION_RE =
  /upstream connect error|disconnect\/reset before headers|reset reason:\s*connection termination/i

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

export function isGatewayTerminationBody(body: string): boolean {
  return GATEWAY_TERMINATION_RE.test(body)
}

export type LoadWorkspaceHtmlPreviewOptions = {
  fetch?: typeof globalThis.fetch
  /** Összes próbálkozás, az első kérést is beleértve. */
  attempts?: number
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

function errorForStatus(status: number): WorkspaceHtmlPreviewError {
  if (status === 401 || status === 403) {
    return new WorkspaceHtmlPreviewError(
      'unauthorized',
      WORKSPACE_HTML_PREVIEW_UNAUTHORIZED_MESSAGE,
      false,
    )
  }
  if (status === 404) {
    return new WorkspaceHtmlPreviewError('not_found', WORKSPACE_HTML_PREVIEW_NOT_FOUND_MESSAGE, false)
  }
  if (RETRYABLE_STATUS.has(status)) {
    return new WorkspaceHtmlPreviewError('gateway', WORKSPACE_HTML_PREVIEW_GATEWAY_MESSAGE, true)
  }
  return new WorkspaceHtmlPreviewError('invalid', WORKSPACE_HTML_PREVIEW_INVALID_MESSAGE, false)
}

function lookLikeHtml(body: string, contentType: string): boolean {
  if (/text\/html/i.test(contentType)) return true
  const trimmed = body.trimStart()
  return /^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)
}

async function readAttempt(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  let response: Response
  try {
    response = await fetchImpl(url, { credentials: 'same-origin', signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new WorkspaceHtmlPreviewError('network', WORKSPACE_HTML_PREVIEW_GATEWAY_MESSAGE, true)
  }

  const body = await response.text()
  if (isGatewayTerminationBody(body)) {
    throw new WorkspaceHtmlPreviewError('gateway', WORKSPACE_HTML_PREVIEW_GATEWAY_MESSAGE, true)
  }

  if (!response.ok) throw errorForStatus(response.status)

  const contentType = response.headers.get('content-type') ?? ''
  if (/application\/json/i.test(contentType) || body.trimStart().startsWith('{')) {
    throw new WorkspaceHtmlPreviewError('invalid', WORKSPACE_HTML_PREVIEW_INVALID_MESSAGE, false)
  }
  if (!lookLikeHtml(body, contentType)) {
    throw new WorkspaceHtmlPreviewError('invalid', WORKSPACE_HTML_PREVIEW_INVALID_MESSAGE, false)
  }
  return body
}

export async function loadWorkspaceHtmlPreview(
  url: string,
  opts: LoadWorkspaceHtmlPreviewOptions = {},
): Promise<string> {
  const fetchImpl = opts.fetch ?? fetch
  const attempts = Math.max(1, opts.attempts ?? 3)
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  let lastError: WorkspaceHtmlPreviewError | undefined
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
    try {
      return await readAttempt(fetchImpl, url, opts.signal)
    } catch (error) {
      if (opts.signal?.aborted) throw error
      if (!(error instanceof WorkspaceHtmlPreviewError) || !error.retryable) throw error
      lastError = error
      if (attempt + 1 >= attempts) break
      await sleep(300 * 2 ** attempt)
    }
  }
  throw lastError ?? new WorkspaceHtmlPreviewError('gateway', WORKSPACE_HTML_PREVIEW_GATEWAY_MESSAGE, true)
}
