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
/** Az Agent táblán élő módok. */
export type AgentWriteKind = 'memory' | 'httpApi' | 'gmail' | 'drive'
/**
 * #942 D1: a `wiki` mód nem az Agent táblán, hanem a cél-wiki
 * `AgentConnector.wikiWriteMode`-ján él — ezért nincs az `AgentWriteApprovalModes`-ban.
 */
export type WriteKind = AgentWriteKind | 'wiki'

export type AgentWriteApprovalModes = Record<AgentWriteKind, WriteApprovalMode>

export const DEFAULT_WRITE_APPROVAL_MODES: AgentWriteApprovalModes = {
  memory: 'approval',
  httpApi: 'approval',
  gmail: 'approval',
  drive: 'approval',
}

// mcp_call: csak a `write` besorolású MCP-eszköz kérdezi; `danger` mindig jóváhagyás (#395 §3.3).
const HTTP_WRITE_TOOLS = new Set(['http_api_request', 'mcp_call'])
const GMAIL_WRITE_TOOLS = new Set([
  'gmail_send',
  'gmail_create_draft',
  'gmail_modify_labels',
  'gmail_trash',
  // #1030: a mail_* írás a meglévő gmail jóváhagyási módot használja (nincs külön DB-oszlop).
  'mail_send',
  'mail_create_draft',
  'mail_mark',
])
const WIKI_WRITE_TOOLS = new Set(['kb_wiki_write', 'kb_wiki_revert'])
/** #978 D2: a visszaállítás a wiki közvetlen írási módjától függetlenül mindig jóváhagyásra vár. */
const ALWAYS_APPROVAL_TOOLS = new Set(['kb_wiki_revert'])
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
  if (WIKI_WRITE_TOOLS.has(toolName)) return 'wiki'
  return null
}

/**
 * Hiányzó / ismeretlen mód = jóváhagyás kell (fail-closed). A `wiki` kind a
 * cél-kapcsolat módját nézi (`wikiTarget.wikiWriteMode`), az agent-szintű módokat nem.
 */
export function skipsWriteApproval(
  toolName: string,
  modes: AgentWriteApprovalModes | null | undefined,
  wikiTarget?: { wikiWriteMode?: unknown } | null,
): boolean {
  const kind = writeKindForTool(toolName)
  if (!kind || ALWAYS_APPROVAL_TOOLS.has(toolName)) return false
  if (kind === 'wiki') return wikiTarget?.wikiWriteMode === 'direct'
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
