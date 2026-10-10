/**
 * Agentenként, írás típusonként: emberi jóváhagyás (alap) vagy azonnali írás.
 * A kliensek még nem tudják jól a chatben jóváhagyni — ezért kapcsolható ki.
 *
 * A tool-név listák szándékosan másolatok a tool-definitions WRITE halmazairól,
 * hogy ez a modul ne húzza be az enterprise-tools kört. A gateway/MCP target
 * graph a `@/domain/agent/*` importot tiltja, ezért ez a lib alatt él.
 */

export const WRITE_APPROVAL_MODES = ['approval', 'direct'] as const
export type WriteApprovalMode = (typeof WRITE_APPROVAL_MODES)[number]
export type WriteKind = 'memory' | 'httpApi' | 'gmail' | 'drive'

export type AgentWriteApprovalModes = Record<WriteKind, WriteApprovalMode>

export const DEFAULT_WRITE_APPROVAL_MODES: AgentWriteApprovalModes = {
  memory: 'approval',
  httpApi: 'approval',
  gmail: 'approval',
  drive: 'approval',
}

const HTTP_WRITE_TOOLS = new Set(['http_api_request'])
const GMAIL_WRITE_TOOLS = new Set([
  'gmail_send',
  'gmail_create_draft',
  'gmail_modify_labels',
  'gmail_trash',
])
const DRIVE_WRITE_TOOLS = new Set([
  'google_drive_create_folder',
  'google_drive_upload_file',
  'google_drive_update_file',
  'google_sheets_write_range',
])

export function isWriteApprovalMode(value: unknown): value is WriteApprovalMode {
  return value === 'approval' || value === 'direct'
}

export function writeKindForTool(toolName: string): WriteKind | null {
  if (toolName === 'platform.project_memory.write') return 'memory'
  if (HTTP_WRITE_TOOLS.has(toolName)) return 'httpApi'
  if (GMAIL_WRITE_TOOLS.has(toolName)) return 'gmail'
  if (DRIVE_WRITE_TOOLS.has(toolName)) return 'drive'
  return null
}

/** Hiányzó / ismeretlen mód = jóváhagyás kell (fail-closed). */
export function skipsWriteApproval(
  toolName: string,
  modes: AgentWriteApprovalModes | null | undefined,
): boolean {
  const kind = writeKindForTool(toolName)
  if (!kind) return false
  return modes?.[kind] === 'direct'
}

export function modesFromAgentRow(row: {
  memoryWriteMode?: unknown
  httpApiWriteMode?: unknown
  gmailWriteMode?: unknown
  driveWriteMode?: unknown
}): AgentWriteApprovalModes {
  return {
    memory: isWriteApprovalMode(row.memoryWriteMode) ? row.memoryWriteMode : 'approval',
    httpApi: isWriteApprovalMode(row.httpApiWriteMode) ? row.httpApiWriteMode : 'approval',
    gmail: isWriteApprovalMode(row.gmailWriteMode) ? row.gmailWriteMode : 'approval',
    drive: isWriteApprovalMode(row.driveWriteMode) ? row.driveWriteMode : 'approval',
  }
}
