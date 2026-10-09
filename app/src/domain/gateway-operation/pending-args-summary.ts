import { formatToolUiName } from '@/lib/tool-ui-labels'

/**
 * Human-readable summary of a pending GatewayOperation's args for HITL approval.
 * Must surface every field execute will use — otherwise the approver can rubber-stamp
 * a decoy (benign title/body) while replaceIds, query params, or Gmail recipients run.
 */

const CONTENT_PREVIEW = 800

export type PendingArgsLabels = {
  memoryKind: string
  parentRoot: string
  parentFolder: (id: string) => string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clip(text: string): string {
  if (text.length <= CONTENT_PREVIEW) return text
  return `${text.slice(0, CONTENT_PREVIEW)}\n…(${text.length} chars)`
}

/** Linked Gmail/Drive account handle from args — execute uses this grant. */
function accountLine(args: Record<string, unknown>): string | null {
  const account = str(args.account).trim()
  return account ? `account: ${account}` : null
}

/** Stable, human-readable query string from a scalar map (order: key sorted). */
export function formatScalarQuery(query: unknown): string {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return ''
  return Object.entries(query as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&')
}

function gmailComposeLines(args: Record<string, unknown>): string[] {
  const lines: string[] = []
  const account = accountLine(args)
  if (account) lines.push(account)
  if (str(args.draftId)) {
    lines.push(`draftId: ${str(args.draftId)}`)
    return lines
  }
  if (str(args.replyToMessageId)) {
    lines.push(
      `replyTo: ${str(args.replyToMessageId)}${args.replyAll === true ? ' (replyAll)' : ''}`,
    )
  } else {
    lines.push('new message')
  }
  if (str(args.to)) lines.push(`to: ${str(args.to)}`)
  if (str(args.cc)) lines.push(`cc: ${str(args.cc)}`)
  if (str(args.bcc)) lines.push(`bcc: ${str(args.bcc)}`)
  if (str(args.subject)) lines.push(`subject: ${str(args.subject)}`)
  if (str(args.body)) lines.push(clip(str(args.body)))
  return lines
}

function gmailItemLines(args: Record<string, unknown>): string[] {
  const lines: string[] = []
  const account = accountLine(args)
  if (account) lines.push(account)
  if (str(args.threadId)) lines.push(`threadId: ${str(args.threadId)}`)
  if (str(args.messageId)) lines.push(`messageId: ${str(args.messageId)}`)
  return lines
}

/**
 * One multi-line summary for the control-plane approval card / tests.
 * Prefer `toolName` over shape heuristics so Gmail never falls through to Drive chrome.
 */
export function pendingOperationHeadline(
  toolName: string,
  args: Record<string, unknown>,
  options?: { connectorName?: string },
): string {
  const connectorName = str(args.connectorName) || options?.connectorName || 'HTTP API'
  if (toolName === 'http_api_request') {
    const query = formatScalarQuery(args.query)
    return `${connectorName}: ${str(args.method)} ${str(args.path)}${query ? `?${query}` : ''}`
  }
  if (toolName === 'google_drive_upload_file') {
    const account = str(args.account).trim()
    return `Google Drive fájl: ${str(args.name) || '—'}${account ? ` (${account})` : ''}`
  }
  if (toolName === 'google_drive_create_folder') {
    const account = str(args.account).trim()
    return `Google Drive mappa: ${str(args.name) || '—'}${account ? ` (${account})` : ''}`
  }
  if (toolName === 'google_drive_update_file') {
    const account = str(args.account).trim()
    return `Google Drive fájl felülírása: ${str(args.fileId) || '—'}${account ? ` (${account})` : ''}`
  }
  if (toolName === 'gmail_send' || toolName === 'gmail_create_draft') {
    const account = str(args.account).trim()
    if (str(args.draftId)) {
      return `Gmail piszkozat elküldése: ${str(args.draftId)}${account ? ` (${account})` : ''}`
    }
    const parts = [
      str(args.replyToMessageId) ? `Gmail válasz` : 'Gmail új levél',
      account ? `fiók: ${account}` : '',
      str(args.subject) ? `tárgy: ${str(args.subject)}` : '',
    ].filter(Boolean)
    return parts.join(', ')
  }
  if (toolName === 'platform.project_memory.write') {
    return `${str(args.kind) || 'emlék'}: ${str(args.title) || '—'}`
  }
  return formatToolUiName(toolName)
}

export function pendingArgsSummary(
  toolName: string,
  args: Record<string, unknown>,
  labels: PendingArgsLabels,
): string {
  if (toolName === 'http_api_request') {
    const query = formatScalarQuery(args.query)
    const lines = [`${str(args.method)} ${str(args.path)}${query ? `?${query}` : ''}`]
    if (str(args.body)) lines.push(clip(str(args.body)))
    return lines.join('\n')
  }

  if (toolName === 'gmail_send' || toolName === 'gmail_create_draft') {
    return gmailComposeLines(args).join('\n')
  }
  if (toolName === 'gmail_modify_labels') {
    const lines = gmailItemLines(args)
    if (str(args.addLabelIds)) lines.push(`add: ${str(args.addLabelIds)}`)
    if (str(args.removeLabelIds)) lines.push(`remove: ${str(args.removeLabelIds)}`)
    return lines.join('\n')
  }
  if (toolName === 'gmail_trash') {
    return [...gmailItemLines(args), '→ trash'].join('\n')
  }

  if (toolName === 'platform.project_memory.write') {
    const kind = str(args.kind) || labels.memoryKind
    const project = str(args.projectKey) || '__general__'
    const lines = [`${kind}: ${str(args.title)} (${project})`]
    if (str(args.body)) lines.push(clip(str(args.body)))
    if (str(args.replaceId)) lines.push(`replaceId: ${str(args.replaceId)}`)
    if (str(args.mergeIds)) lines.push(`mergeIds: ${str(args.mergeIds)}`)
    if (str(args.artifactPath)) lines.push(`artifact: ${str(args.artifactPath)}`)
    return lines.join('\n')
  }

  if (toolName === 'google_sheets_write_range' || typeof args.range === 'string') {
    const lines: string[] = []
    const account = accountLine(args)
    if (account) lines.push(account)
    lines.push(`${str(args.fileId) || '—'} · ${str(args.range)}`)
    if (str(args.values)) lines.push(clip(str(args.values)))
    if (str(args.mode)) lines.push(`mode: ${str(args.mode)}`)
    return lines.join('\n')
  }

  if (toolName === 'google_drive_update_file') {
    const lines: string[] = []
    const account = accountLine(args)
    if (account) lines.push(account)
    lines.push(`${str(args.fileId) || '—'} (teljes tartalom felülírása)`)
    if (str(args.textContent)) lines.push(clip(str(args.textContent)))
    return lines.join('\n')
  }

  if (toolName === 'google_drive_upload_file') {
    const parent =
      str(args.parentFolderId)
        ? labels.parentFolder(str(args.parentFolderId))
        : labels.parentRoot
    const lines: string[] = []
    const account = accountLine(args)
    if (account) lines.push(account)
    lines.push(`${str(args.name) || '—'} (${parent})`)
    if (str(args.textContent)) lines.push(clip(str(args.textContent)))
    if (str(args.contentBase64)) lines.push(`[base64 tartalom, ${str(args.contentBase64).length} karakter]`)
    return lines.join('\n')
  }

  if (toolName === 'google_drive_create_folder' || typeof args.name === 'string') {
    const parent =
      str(args.parentFolderId)
        ? labels.parentFolder(str(args.parentFolderId))
        : labels.parentRoot
    const account = accountLine(args)
    const lines = [account, `${str(args.name) || '—'} (${parent})`].filter(Boolean) as string[]
    return lines.join('\n')
  }

  // Last resort: never invent Drive-root chrome for unknown tools.
  if (str(args.path)) return str(args.path)
  if (str(args.title)) {
    const kind = str(args.kind) || labels.memoryKind
    return `${kind}: ${str(args.title)}`
  }
  return Object.entries(args)
    .filter(([key]) => key !== 'definitionId' && key !== 'idempotencyKey' && key !== 'withUserId')
    .slice(0, 8)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? clip(value) : JSON.stringify(value)}`)
    .join('\n')
}
