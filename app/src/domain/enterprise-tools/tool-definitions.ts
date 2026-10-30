import { z } from 'zod'

export const GOOGLE_DRIVE_SEARCH_TOOL = 'google_drive_search'
export const GOOGLE_DRIVE_READ_FILE_TOOL = 'google_drive_read_file'
export const GOOGLE_DRIVE_CREATE_FOLDER_TOOL = 'google_drive_create_folder'
export const GOOGLE_DRIVE_UPLOAD_FILE_TOOL = 'google_drive_upload_file'
export const GOOGLE_DRIVE_UPDATE_FILE_TOOL = 'google_drive_update_file'
export const GOOGLE_SHEETS_WRITE_RANGE_TOOL = 'google_sheets_write_range'

export const GMAIL_SEARCH_TOOL = 'gmail_search'
export const GMAIL_GET_MESSAGE_TOOL = 'gmail_get_message'
export const GMAIL_GET_THREAD_TOOL = 'gmail_get_thread'
export const GMAIL_LIST_LABELS_TOOL = 'gmail_list_labels'
export const GMAIL_LIST_DRAFTS_TOOL = 'gmail_list_drafts'
export const GMAIL_SEND_TOOL = 'gmail_send'
export const GMAIL_CREATE_DRAFT_TOOL = 'gmail_create_draft'
export const GMAIL_MODIFY_LABELS_TOOL = 'gmail_modify_labels'
export const GMAIL_TRASH_TOOL = 'gmail_trash'

export const HTTP_API_GET_TOOL = 'http_api_get'
export const HTTP_API_GET_ALL_TOOL = 'http_api_get_all'
export const HTTP_API_REQUEST_TOOL = 'http_api_request'

/** #1030: provider-független levelezés (AgentMail, Gmail, Microsoft 365). */
export const MAIL_LIST_ACCOUNTS_TOOL = 'mail_list_accounts'
export const MAIL_SEARCH_TOOL = 'mail_search'
export const MAIL_GET_MESSAGE_TOOL = 'mail_get_message'
export const MAIL_GET_THREAD_TOOL = 'mail_get_thread'
export const MAIL_GET_ATTACHMENT_TOOL = 'mail_get_attachment'
export const MAIL_SEND_TOOL = 'mail_send'
export const MAIL_CREATE_DRAFT_TOOL = 'mail_create_draft'
export const MAIL_MARK_TOOL = 'mail_mark'

export const ENTERPRISE_DRIVE_WRITE_TOOLS = [
  GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
  GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
  GOOGLE_DRIVE_UPDATE_FILE_TOOL,
  GOOGLE_SHEETS_WRITE_RANGE_TOOL,
] as const

export const ENTERPRISE_DRIVE_TOOLS = [
  GOOGLE_DRIVE_SEARCH_TOOL,
  GOOGLE_DRIVE_READ_FILE_TOOL,
  ...ENTERPRISE_DRIVE_WRITE_TOOLS,
] as const

export const ENTERPRISE_GMAIL_WRITE_TOOLS = [
  GMAIL_SEND_TOOL,
  GMAIL_CREATE_DRAFT_TOOL,
  GMAIL_MODIFY_LABELS_TOOL,
  GMAIL_TRASH_TOOL,
] as const

export const ENTERPRISE_GMAIL_TOOLS = [
  GMAIL_SEARCH_TOOL,
  GMAIL_GET_MESSAGE_TOOL,
  GMAIL_GET_THREAD_TOOL,
  GMAIL_LIST_LABELS_TOOL,
  GMAIL_LIST_DRAFTS_TOOL,
  ...ENTERPRISE_GMAIL_WRITE_TOOLS,
] as const

export const ENTERPRISE_HTTP_WRITE_TOOLS = [HTTP_API_REQUEST_TOOL] as const

export const ENTERPRISE_HTTP_TOOLS = [
  HTTP_API_GET_TOOL,
  HTTP_API_GET_ALL_TOOL,
  ...ENTERPRISE_HTTP_WRITE_TOOLS,
] as const

export const ENTERPRISE_MAIL_WRITE_TOOLS = [MAIL_SEND_TOOL, MAIL_CREATE_DRAFT_TOOL, MAIL_MARK_TOOL] as const

export const ENTERPRISE_MAIL_TOOLS = [
  MAIL_LIST_ACCOUNTS_TOOL,
  MAIL_SEARCH_TOOL,
  MAIL_GET_MESSAGE_TOOL,
  MAIL_GET_THREAD_TOOL,
  MAIL_GET_ATTACHMENT_TOOL,
  ...ENTERPRISE_MAIL_WRITE_TOOLS,
] as const

export const KB_SEARCH_TOOL = 'kb_search'
export const KB_LIST_INDEX_TOOL = 'kb_list_index'
export const KB_GET_PAGE_TOOL = 'kb_get_page'
export const KB_GET_DOCUMENT_TOOL = 'kb_get_document'
export const KB_INGEST_TOOL = 'kb_ingest'
/** #943: agent-wiki change-set (write-kind `wiki`, a mód a cél-kapcsolaton él). */
export const KB_WIKI_WRITE_TOOL = 'kb_wiki_write'
/** #978 §5.4: mi változott a wikin az agent legutóbbi átnézése óta (összefoglaló, diff nélkül). */
export const KB_WIKI_CHANGES_TOOL = 'kb_wiki_changes'
/** #978 §5.2: oldal / change-set visszaállítása — D2: MINDIG jóváhagyással. */
export const KB_WIKI_REVERT_TOOL = 'kb_wiki_revert'

export const ENTERPRISE_KB_TOOLS = [
  KB_SEARCH_TOOL,
  KB_LIST_INDEX_TOOL,
  KB_GET_PAGE_TOOL,
  KB_GET_DOCUMENT_TOOL,
  KB_INGEST_TOOL,
  KB_WIKI_WRITE_TOOL,
  KB_WIKI_CHANGES_TOOL,
  KB_WIKI_REVERT_TOOL,
] as const

export const SANDBOX_RUN_TOOL = 'sandbox_run'
export const ENTERPRISE_SANDBOX_TOOLS = [SANDBOX_RUN_TOOL] as const

/** #395 D1: két fix eszköz minden külső MCP-szerverhez — a nevek futásidőben nem változnak. */
export const MCP_LIST_TOOLS_TOOL = 'mcp_list_tools'
export const MCP_CALL_TOOL = 'mcp_call'
export const ENTERPRISE_MCP_TOOLS = [MCP_LIST_TOOLS_TOOL, MCP_CALL_TOOL] as const

export const ENTERPRISE_WRITE_TOOLS = [
  ...ENTERPRISE_DRIVE_WRITE_TOOLS,
  ...ENTERPRISE_MAIL_WRITE_TOOLS,
  ...ENTERPRISE_GMAIL_WRITE_TOOLS,
  ...ENTERPRISE_HTTP_WRITE_TOOLS,
] as const

export const ENTERPRISE_TOOLS = [
  ...ENTERPRISE_DRIVE_TOOLS,
  ...ENTERPRISE_MAIL_TOOLS,
  ...ENTERPRISE_GMAIL_TOOLS,
  ...ENTERPRISE_HTTP_TOOLS,
  ...ENTERPRISE_KB_TOOLS,
  ...ENTERPRISE_SANDBOX_TOOLS,
  ...ENTERPRISE_MCP_TOOLS,
] as const

/**
 * Csak olvasó eszközök: újrapublikálás után a régi definitionId-val érkező hívás az
 * aktuális verzión lefuthat (`withDefinitionUpdatedNotice`). Írás és külső hívás nem.
 */
export const ENTERPRISE_READ_ONLY_TOOLS = [
  GOOGLE_DRIVE_SEARCH_TOOL,
  GOOGLE_DRIVE_READ_FILE_TOOL,
  GMAIL_SEARCH_TOOL,
  GMAIL_GET_MESSAGE_TOOL,
  GMAIL_GET_THREAD_TOOL,
  GMAIL_LIST_LABELS_TOOL,
  GMAIL_LIST_DRAFTS_TOOL,
  MAIL_LIST_ACCOUNTS_TOOL,
  MAIL_SEARCH_TOOL,
  MAIL_GET_MESSAGE_TOOL,
  MAIL_GET_THREAD_TOOL,
  MAIL_GET_ATTACHMENT_TOOL,
  HTTP_API_GET_TOOL,
  HTTP_API_GET_ALL_TOOL,
  KB_SEARCH_TOOL,
  KB_LIST_INDEX_TOOL,
  KB_GET_PAGE_TOOL,
  KB_GET_DOCUMENT_TOOL,
  KB_WIKI_CHANGES_TOOL,
  MCP_LIST_TOOLS_TOOL,
] as const

export type EnterpriseDriveWriteTool = (typeof ENTERPRISE_DRIVE_WRITE_TOOLS)[number]
export type EnterpriseDriveTool = (typeof ENTERPRISE_DRIVE_TOOLS)[number]
export type EnterpriseGmailTool = (typeof ENTERPRISE_GMAIL_TOOLS)[number]
export type EnterpriseGmailWriteTool = (typeof ENTERPRISE_GMAIL_WRITE_TOOLS)[number]
export type EnterpriseHttpWriteTool = (typeof ENTERPRISE_HTTP_WRITE_TOOLS)[number]
export type EnterpriseHttpTool = (typeof ENTERPRISE_HTTP_TOOLS)[number]
export type EnterpriseMailWriteTool = (typeof ENTERPRISE_MAIL_WRITE_TOOLS)[number]
export type EnterpriseMailTool = (typeof ENTERPRISE_MAIL_TOOLS)[number]
export type EnterpriseKbTool = (typeof ENTERPRISE_KB_TOOLS)[number]
export type EnterpriseSandboxTool = (typeof ENTERPRISE_SANDBOX_TOOLS)[number]
export type EnterpriseMcpTool = (typeof ENTERPRISE_MCP_TOOLS)[number]
export type EnterpriseWriteTool = (typeof ENTERPRISE_WRITE_TOOLS)[number]
export type EnterpriseTool = (typeof ENTERPRISE_TOOLS)[number]

const ENTERPRISE_DRIVE_TOOL_SET = new Set<string>(ENTERPRISE_DRIVE_TOOLS)
const ENTERPRISE_DRIVE_WRITE_TOOL_SET = new Set<string>(ENTERPRISE_DRIVE_WRITE_TOOLS)
const ENTERPRISE_GMAIL_TOOL_SET = new Set<string>(ENTERPRISE_GMAIL_TOOLS)
const ENTERPRISE_GMAIL_WRITE_TOOL_SET = new Set<string>(ENTERPRISE_GMAIL_WRITE_TOOLS)
const ENTERPRISE_HTTP_TOOL_SET = new Set<string>(ENTERPRISE_HTTP_TOOLS)
const ENTERPRISE_HTTP_WRITE_TOOL_SET = new Set<string>(ENTERPRISE_HTTP_WRITE_TOOLS)
const ENTERPRISE_MAIL_TOOL_SET = new Set<string>(ENTERPRISE_MAIL_TOOLS)
const ENTERPRISE_MAIL_WRITE_TOOL_SET = new Set<string>(ENTERPRISE_MAIL_WRITE_TOOLS)
const ENTERPRISE_KB_TOOL_SET = new Set<string>(ENTERPRISE_KB_TOOLS)
const ENTERPRISE_SANDBOX_TOOL_SET = new Set<string>(ENTERPRISE_SANDBOX_TOOLS)
const ENTERPRISE_WRITE_TOOL_SET = new Set<string>(ENTERPRISE_WRITE_TOOLS)
const ENTERPRISE_TOOL_SET = new Set<string>(ENTERPRISE_TOOLS)
const ENTERPRISE_READ_ONLY_TOOL_SET = new Set<string>(ENTERPRISE_READ_ONLY_TOOLS)

export function isEnterpriseDriveTool(toolName: string): toolName is EnterpriseDriveTool {
  return ENTERPRISE_DRIVE_TOOL_SET.has(toolName)
}

export function isEnterpriseDriveWriteTool(toolName: string): toolName is EnterpriseDriveWriteTool {
  return ENTERPRISE_DRIVE_WRITE_TOOL_SET.has(toolName)
}

export function isEnterpriseGmailTool(toolName: string): toolName is EnterpriseGmailTool {
  return ENTERPRISE_GMAIL_TOOL_SET.has(toolName)
}

export function isEnterpriseGmailWriteTool(toolName: string): toolName is EnterpriseGmailWriteTool {
  return ENTERPRISE_GMAIL_WRITE_TOOL_SET.has(toolName)
}

export function isEnterpriseHttpTool(toolName: string): toolName is EnterpriseHttpTool {
  return ENTERPRISE_HTTP_TOOL_SET.has(toolName)
}

export function isEnterpriseHttpWriteTool(toolName: string): toolName is EnterpriseHttpWriteTool {
  return ENTERPRISE_HTTP_WRITE_TOOL_SET.has(toolName)
}

export function isEnterpriseMailTool(toolName: string): toolName is EnterpriseMailTool {
  return ENTERPRISE_MAIL_TOOL_SET.has(toolName)
}

export function isEnterpriseMailWriteTool(toolName: string): toolName is EnterpriseMailWriteTool {
  return ENTERPRISE_MAIL_WRITE_TOOL_SET.has(toolName)
}

export function isEnterpriseKbTool(toolName: string): toolName is EnterpriseKbTool {
  return ENTERPRISE_KB_TOOL_SET.has(toolName)
}

export function isEnterpriseSandboxTool(toolName: string): toolName is EnterpriseSandboxTool {
  return ENTERPRISE_SANDBOX_TOOL_SET.has(toolName)
}

export function isEnterpriseMcpTool(toolName: string): toolName is EnterpriseMcpTool {
  return toolName === MCP_LIST_TOOLS_TOOL || toolName === MCP_CALL_TOOL
}

export function isEnterpriseReadOnlyTool(toolName: string): boolean {
  return ENTERPRISE_READ_ONLY_TOOL_SET.has(toolName)
}

export function isEnterpriseWriteTool(toolName: string): toolName is EnterpriseWriteTool {
  return ENTERPRISE_WRITE_TOOL_SET.has(toolName)
}

export function isEnterpriseTool(toolName: string): toolName is EnterpriseTool {
  return ENTERPRISE_TOOL_SET.has(toolName)
}

const definitionId = z
  .string()
  .uuid()
  .optional()
  .describe(
    'Published agent definition id from platform.agent.get_definition. Omit it when this client sends X-Excellence-Agent-Id — the server uses the current published definition. Unbound clients must pass it.',
  )
const optionalAgentId = z
  .string()
  .uuid()
  .optional()
  .describe(
    'Optional consistency check against the published definition. Omit it — definitionId already selects the agent. The platform injects X-Agent-Id; do not pass trace headers.',
  )
const optionalConnectorId = z
  .string()
  .uuid()
  .optional()
  .describe('Required when the agent has more than one matching connector and path/name routing is ambiguous')
const optionalConnectorName = z
  .string()
  .max(200)
  .optional()
  .describe(
    'Human connector name from the published agent definition (connectors[].name). Prefer this over connectorId when several HTTP APIs or mailboxes (e.g. the user\'s own Gmail and a shared company mailbox) are bound.',
  )
const optionalLinkedAccount = z
  .string()
  .max(80)
  .optional()
  .describe(
    'Nickname or email of the linked account from platform.whoami linkedAccounts (e.g. magán, céges). Required when the user has more than one account for this connector (Gmail, Drive, Calendar, or other delegated HTTP APIs).',
  )
const optionalMailAccount = z
  .string()
  .max(80)
  .optional()
  .describe(
    'Mailbox address or nickname from mail_list_accounts. Omit to use the agent\'s own address. Pass "all" on mail_search to search every reachable mailbox.',
  )
const scalarMap = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
const callerHeaders = z
  .record(z.string(), z.string())
  .optional()
  .describe(
    'Only headers the endpoint declares (get_definition → endpoints[].headers), for example If-Match with the version you read. Never credentials or trace headers; undeclared headers are rejected (header_not_allowed).',
  )

/** Largest JSON body the model may send in one http_api_request (characters). */
export const HTTP_API_REQUEST_BODY_MAX_CHARS = 200_000

export const googleDriveSearchInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    account: optionalLinkedAccount,
    query: z
      .string()
      .max(1000)
      .optional()
      .describe(
        "Plain words search file names and contents (e.g. 'Birtok árlista'). Drive query syntax (name contains 'x') also works. Omit with nameContains to list recent files.",
      ),
    nameContains: z.string().max(200).optional().describe('Substring match on file name.'),
    // ponytail: string not string[] — Claude.ai drops MCP tools whose advertised schema has arrays
    mimeTypes: z
      .string()
      .max(1300)
      .optional()
      .describe('Comma-separated MIME types, e.g. application/pdf,image/png'),
    modifiedAfter: z.string().max(40).optional(),
    driveId: z.string().optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    pageToken: z.string().optional(),
  })
  .passthrough()

export const googleDriveReadFileInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    account: optionalLinkedAccount,
    fileId: z.string().min(1).max(200).describe('Drive file id from google_drive_search.'),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(20_000_000)
      .optional()
      .describe(
        'Maximum allowed file size in bytes (default 10MB). Larger files fail with 413 file_too_large. Smaller values reject more, never truncate.',
      ),
  })
  .passthrough()

export const googleDriveCreateFolderInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    account: optionalLinkedAccount,
    name: z.string().min(1).max(500),
    parentFolderId: z.string().max(200).optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .passthrough()

export const googleDriveUploadFileInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    account: optionalLinkedAccount,
    name: z.string().min(1).max(500),
    textContent: z
      .string()
      .min(1)
      .max(200_000)
      .optional()
      .describe('File body as text. For HTML reports, CSV, JSON, or plain text.'),
    // ponytail: plain string, not a union — Claude.ai drops MCP tools whose schema has arrays/unions.
    contentBase64: z
      .string()
      .max(14_000_000)
      .optional()
      .describe(
        'Base64-encoded file bytes instead of textContent (image, PDF, HTML). Pass exactly one of textContent or contentBase64.',
      ),
    mimeType: z.string().max(200).optional(),
    parentFolderId: z.string().max(200).optional(),
    convertToGoogleType: z.enum(['doc', 'sheet', 'slides']).optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .passthrough()

export const googleDriveUpdateFileInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    account: optionalLinkedAccount,
    fileId: z.string().min(1).max(200).describe('Drive file id from google_drive_search.'),
    textContent: z
      .string()
      .min(1)
      .max(200_000)
      .describe('The complete new text of the file. It replaces the whole current content.'),
    expectedModifiedTime: z
      .string()
      .max(40)
      .optional()
      .describe(
        'modifiedTime of the file as you last read it (google_drive_read_file → file.modifiedTime). If the file changed since, nothing is written (drive_file_modified). Always pass it when you read the file first.',
      ),
    idempotencyKey: z.string().min(1).max(200),
  })
  .passthrough()

export const googleSheetsWriteRangeInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    account: optionalLinkedAccount,
    fileId: z.string().min(1).max(200),
    range: z.string().min(1).max(200).describe('A1 range, e.g. Sheet1!A1'),
    // ponytail: JSON string not unknown[][] — Claude.ai drops advertised array schemas
    values: z
      .string()
      .min(1)
      .max(200_000)
      .describe('JSON 2D array of cell values, e.g. [["Name","Qty"],["A",1]]'),
    mode: z.enum(['replace', 'append']).optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .passthrough()

export const gmailSearchInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    connectorId: optionalConnectorId,
    connectorName: optionalConnectorName,
    account: optionalLinkedAccount,
    query: z
      .string()
      .min(1)
      .max(500)
      .describe('Gmail search syntax, e.g. is:unread newer_than:7d'),
    maxResults: z.number().int().min(1).max(50).optional(),
  })
  .passthrough()

export const gmailGetMessageInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    connectorId: optionalConnectorId,
    connectorName: optionalConnectorName,
    account: optionalLinkedAccount,
    id: z.string().min(1).max(200).describe('Gmail message id from gmail_search'),
  })
  .passthrough()

export const gmailGetThreadInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    connectorId: optionalConnectorId,
    connectorName: optionalConnectorName,
    account: optionalLinkedAccount,
    threadId: z.string().min(1).max(200).describe('Gmail threadId from gmail_search or gmail_get_message'),
  })
  .passthrough()

export const gmailListLabelsInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    connectorId: optionalConnectorId,
    connectorName: optionalConnectorName,
    account: optionalLinkedAccount,
  })
  .passthrough()

export const gmailListDraftsInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    connectorId: optionalConnectorId,
    connectorName: optionalConnectorName,
    account: optionalLinkedAccount,
    maxResults: z.number().int().min(1).max(25).optional(),
  })
  .passthrough()

// ponytail: comma-separated strings not string[] — Claude.ai drops advertised array schemas
const emailList = (what: string) =>
  z.string().max(2000).optional().describe(`${what}: comma-separated addresses, e.g. "Anna <anna@x.hu>, bela@y.hu"`)

const composeFields = {
  definitionId,
  agentId: optionalAgentId,
  connectorId: optionalConnectorId,
  connectorName: optionalConnectorName,
  account: optionalLinkedAccount,
  to: emailList('Recipients. Omit when replying — defaults to the original sender (all participants with replyAll)'),
  cc: emailList('Cc'),
  bcc: emailList('Bcc'),
  subject: z.string().max(1000).optional().describe('Required for a new message; omit when replying ("Re: <original>")'),
  body: z.string().max(100_000).optional().describe('Plain-text message body'),
  replyToMessageId: z
    .string()
    .max(200)
    .optional()
    .describe('Gmail message id (from gmail_search/gmail_get_message) to reply to — keeps the reply in the same thread'),
  replyAll: z.boolean().optional().describe('With replyToMessageId: also address the original To/Cc recipients'),
  idempotencyKey: z.string().min(1).max(200),
}

const gmailSendObject = z
  .object({
    ...composeFields,
    draftId: z.string().max(200).optional().describe('Send an existing draft (from gmail_create_draft / gmail_list_drafts) instead of composing'),
  })
  .passthrough()

function composeIssue(args: { to?: string; subject?: string; body?: string; replyToMessageId?: string }): string | null {
  if (!args.body?.trim()) return 'body is required'
  if (args.replyToMessageId) return null
  if (!args.to?.trim()) return 'to is required for a new message'
  if (!args.subject?.trim()) return 'subject is required for a new message'
  return null
}

export const gmailSendInputSchema = gmailSendObject.superRefine((args, ctx) => {
  if (args.draftId) return
  const issue = composeIssue(args)
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue })
})

const gmailCreateDraftObject = z.object(composeFields).passthrough()

export const gmailCreateDraftInputSchema = gmailCreateDraftObject.superRefine((args, ctx) => {
  const issue = composeIssue(args)
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue })
})

const messageOrThread = {
  definitionId,
  agentId: optionalAgentId,
  connectorId: optionalConnectorId,
  connectorName: optionalConnectorName,
  account: optionalLinkedAccount,
  messageId: z.string().max(200).optional().describe('One Gmail message id'),
  threadId: z.string().max(200).optional().describe('Whole thread id (use instead of messageId)'),
  idempotencyKey: z.string().min(1).max(200),
}

function exactlyOneTarget(args: { messageId?: string; threadId?: string }, ctx: z.RefinementCtx) {
  if (Boolean(args.messageId) === Boolean(args.threadId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pass exactly one of messageId or threadId' })
  }
}

const gmailModifyLabelsObject = z
  .object({
    ...messageOrThread,
    addLabelIds: z
      .string()
      .max(1000)
      .optional()
      .describe('Comma-separated label ids to add, e.g. STARRED, IMPORTANT, UNREAD, or a user label id from gmail_list_labels'),
    removeLabelIds: z
      .string()
      .max(1000)
      .optional()
      .describe('Comma-separated label ids to remove. Archive = INBOX, mark read = UNREAD'),
  })
  .passthrough()

export const gmailModifyLabelsInputSchema = gmailModifyLabelsObject.superRefine((args, ctx) => {
  exactlyOneTarget(args, ctx)
  if (!args.addLabelIds?.trim() && !args.removeLabelIds?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'addLabelIds or removeLabelIds is required' })
  }
})

const gmailTrashObject = z.object(messageOrThread).passthrough()

export const gmailTrashInputSchema = gmailTrashObject.superRefine(exactlyOneTarget)

/** MCP `registerTool` needs a plain object schema; refinements run in `schemaForEnterpriseTool`. */
export const GMAIL_MCP_INPUT_SCHEMAS = {
  [GMAIL_SEND_TOOL]: gmailSendObject,
  [GMAIL_CREATE_DRAFT_TOOL]: gmailCreateDraftObject,
  [GMAIL_MODIFY_LABELS_TOOL]: gmailModifyLabelsObject,
  [GMAIL_TRASH_TOOL]: gmailTrashObject,
} as const

export const mailListAccountsInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
  })
  .passthrough()

export const mailSearchInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    account: optionalMailAccount,
    query: z.string().max(500).optional().describe('Free-text search (sender, subject, body)'),
    from: z.string().max(200).optional(),
    to: z.string().max(200).optional(),
    subject: z.string().max(200).optional(),
    unread: z.boolean().optional(),
    after: z.string().max(40).optional().describe('ISO date (inclusive), e.g. 2026-01-01'),
    before: z.string().max(40).optional().describe('ISO date (exclusive)'),
    label: z.string().max(100).optional(),
    maxResults: z.number().int().min(1).max(50).optional(),
  })
  .passthrough()

export const mailGetMessageInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    account: optionalMailAccount,
    id: z.string().min(1).max(200).describe('messageId from mail_search'),
  })
  .passthrough()

export const mailGetThreadInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    account: optionalMailAccount,
    threadId: z.string().min(1).max(200),
  })
  .passthrough()

export const mailGetAttachmentInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    account: optionalMailAccount,
    messageId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200).describe('From mail_get_message attachments[]'),
  })
  .passthrough()

const mailComposeFields = {
  definitionId,
  agentId: optionalAgentId,
  account: optionalMailAccount,
  to: emailList('Recipients. Omit when replying — defaults to the original sender (all participants with replyAll)'),
  cc: emailList('Cc'),
  bcc: emailList('Bcc'),
  subject: z.string().max(1000).optional().describe('Required for a new message; omit when replying ("Re: <original>")'),
  body: z.string().max(100_000).optional().describe('Plain-text message body'),
  replyToMessageId: z
    .string()
    .max(200)
    .optional()
    .describe('messageId from mail_search/mail_get_message — keeps the reply in the same thread'),
  replyAll: z.boolean().optional(),
  idempotencyKey: z.string().min(1).max(200),
}

const mailSendObject = z
  .object({
    ...mailComposeFields,
    draftId: z.string().max(200).optional().describe('Send an existing draft instead of composing'),
  })
  .passthrough()

export const mailSendInputSchema = mailSendObject.superRefine((args, ctx) => {
  if (args.draftId) return
  const issue = composeIssue(args)
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue })
})

const mailCreateDraftObject = z.object(mailComposeFields).passthrough()

export const mailCreateDraftInputSchema = mailCreateDraftObject.superRefine((args, ctx) => {
  const issue = composeIssue(args)
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue })
})

const mailMarkObject = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    account: optionalMailAccount,
    messageId: z.string().max(200).optional(),
    threadId: z.string().max(200).optional(),
    read: z.boolean().optional().describe('Mark read'),
    unread: z.boolean().optional().describe('Mark unread'),
    archive: z.boolean().optional(),
    label: z.string().max(200).optional().describe('Add this label / folder (provider-specific id or name)'),
    idempotencyKey: z.string().min(1).max(200),
  })
  .passthrough()

export const mailMarkInputSchema = mailMarkObject.superRefine((args, ctx) => {
  if (Boolean(args.messageId) === Boolean(args.threadId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pass exactly one of messageId or threadId' })
  }
  if (args.read !== true && args.unread !== true && args.archive !== true && !args.label?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pass read, unread, archive, or label' })
  }
})

export const MAIL_MCP_INPUT_SCHEMAS = {
  [MAIL_SEND_TOOL]: mailSendObject,
  [MAIL_CREATE_DRAFT_TOOL]: mailCreateDraftObject,
  [MAIL_MARK_TOOL]: mailMarkObject,
} as const

export const httpApiGetInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    connectorId: optionalConnectorId,
    connectorName: optionalConnectorName,
    account: optionalLinkedAccount,
    path: z
      .string()
      .min(1)
      .max(1000)
      .describe('Path relative to the connector baseUrl. Auth and host come from the connector.'),
    query: scalarMap.optional().describe('Query params documented on the connector endpoint'),
    headers: callerHeaders,
  })
  .passthrough()

export const httpApiGetAllInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    connectorId: optionalConnectorId,
    connectorName: optionalConnectorName,
    account: optionalLinkedAccount,
    path: z.string().min(1).max(1000),
    query: scalarMap.optional(),
    pageSize: z.number().int().min(1).max(500).optional(),
    maxPages: z.number().int().min(1).max(200).optional(),
  })
  .passthrough()

export const httpApiRequestInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    connectorId: optionalConnectorId,
    connectorName: optionalConnectorName,
    account: optionalLinkedAccount,
    method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().min(1).max(1000),
    query: scalarMap.optional(),
    body: z
      .string()
      .max(HTTP_API_REQUEST_BODY_MAX_CHARS)
      .optional()
      .describe(
        `JSON request body as a string (compact, at most ${HTTP_API_REQUEST_BODY_MAX_CHARS} characters). Required for POST/PUT/PATCH when the endpoint expects a body.`,
      ),
    headers: callerHeaders,
    idempotencyKey: z.string().min(1).max(200),
  })
  .passthrough()

export function schemaForEnterpriseDriveTool(toolName: EnterpriseDriveTool) {
  if (toolName === GOOGLE_DRIVE_READ_FILE_TOOL) return googleDriveReadFileInputSchema
  if (toolName === GOOGLE_DRIVE_CREATE_FOLDER_TOOL) return googleDriveCreateFolderInputSchema
  if (toolName === GOOGLE_DRIVE_UPLOAD_FILE_TOOL) return googleDriveUploadFileInputSchema
  if (toolName === GOOGLE_DRIVE_UPDATE_FILE_TOOL) return googleDriveUpdateFileInputSchema
  if (toolName === GOOGLE_SHEETS_WRITE_RANGE_TOOL) return googleSheetsWriteRangeInputSchema
  return googleDriveSearchInputSchema
}

const optionalWikiId = z.string().uuid().optional()

export const kbSearchInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    wikiId: optionalWikiId,
    query: z.string().min(1).max(1000),
    k: z.number().int().min(1).max(20).optional(),
  })
  .passthrough()

export const kbListIndexInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    wikiId: optionalWikiId,
    pathPrefix: z.string().max(200).optional(),
    maxDepth: z.number().int().min(1).max(8).optional(),
    artifactId: z.string().uuid().optional(),
    /** #943: a tálca (fel nem dolgozott wiki-források) listája + köteg-összesítő. */
    inbox: z.boolean().optional(),
    batchId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .passthrough()

export const kbGetPageInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    wikiId: optionalWikiId,
    path: z.string().min(1).max(400),
    artifactId: z.string().uuid().optional(),
    /** #978 §5.3: a wiki korábbi állapota — change-szám (pl. "97") vagy ISO-dátum ("2026-10-01"). */
    asOf: z
      .union([z.string().trim().min(1).max(40), z.number().int().min(0)])
      .optional()
      .describe('Agent wiki only: read the page as it was at a change number ("97") or date ("2026-10-01"). Read-only; never use its version for writing.'),
  })
  .passthrough()

export const kbGetDocumentInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    documentId: z.string().uuid(),
    section: z.string().max(200).optional(),
    pageImages: z.boolean().optional().describe('Return original PDF pages as PNG images; max 5 pages per call.'),
    pages: z.string().min(1).max(100).optional().describe('1-based PDF pages, e.g. "1-3,7". Defaults to page 1.'),
    /** #943: tálca-tétel foglalása a hívó agentre (2 óra), csak írási joggal. */
    claimForWiki: z.boolean().optional(),
  })
  .passthrough()

/** MCP `registerTool` sima objektum-sémát kér; a finomítások a `kbIngestInputSchema`-ban. */
export const kbIngestObject = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    /** `kind: note` mellett elhagyható (a szerver ad nevet). */
    filename: z.string().min(1).max(255).optional(),
    processingMode: z.enum(['raw_text_only', 'okf', 'wiki']),
    mimeType: z.string().max(200).optional(),
    purpose: z.string().max(240).optional(),
    content: z.string().max(2_000_000).optional(),
    contentBase64: z.string().max(2_800_000).optional(),
    /** #943 wiki mód: cél-wiki (több beküldhető / írható wikinél kötelező). */
    wikiId: optionalWikiId,
    /** Tálcára tesz azonnali feldolgozás helyett (csak ha a felhasználó kérte, D6). */
    defer: z.boolean().optional(),
    /** `note`: rövid szöveges forrás egy beszélgetésből (D9); a szerver bélyegzi. */
    kind: z.enum(['file', 'note']).optional(),
  })
  .passthrough()

export const kbIngestInputSchema = kbIngestObject
  .refine((value) => value.kind === 'note' || !!value.filename, { path: ['filename'] })
  .refine((value) => value.processingMode === 'wiki' || (value.defer === undefined && value.kind !== 'note'), {
    path: ['processingMode'],
  })

const wikiSourceRefSchema = z
  .object({
    documentId: z.string().uuid(),
    filename: z.string().max(255).optional(),
    page: z.number().int().min(1).optional(),
    section: z.string().max(200).optional(),
    cell: z.string().max(64).optional(),
  })
  .strict()

const wikiPatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('appendToSection'), section: z.string().min(1).max(200), text: z.string().min(1).max(20_000) }),
  z.object({ op: z.literal('replaceSection'), section: z.string().min(1).max(200), text: z.string().max(20_000) }),
  z.object({ op: z.literal('addSource'), source: wikiSourceRefSchema }),
])

const wikiPathSchema = z.string().min(1).max(200)

export const kbWikiPageInputSchema = z
  .object({
    path: wikiPathSchema,
    action: z.enum(['upsert', 'patch', 'archive', 'move']),
    title: z.string().max(200).optional(),
    type: z.enum(['source', 'entity', 'concept', 'analysis', 'overview']).optional(),
    summary: z.string().max(400).optional(),
    category: z.string().max(120).optional(),
    frontmatter: z.record(z.string(), z.unknown()).optional(),
    body: z.string().max(40_000).optional(),
    /** Az utoljára olvasott tartalom hash-e (`kb_get_page` `baseVersion`). */
    baseVersion: z.string().max(128).optional(),
    patch: z.array(wikiPatchOpSchema).min(1).max(20).optional(),
    /** `move` cél-path. */
    newPath: wikiPathSchema.optional(),
  })
  .strict()

export type KbWikiPageInput = z.infer<typeof kbWikiPageInputSchema>

const kbWikiLogEntrySchema = z.object({
  op: z.enum(['ingest', 'query', 'lint', 'note']),
  title: z.string().min(1).max(200),
  note: z.string().max(2000).optional(),
})

/**
 * MCP-n hirdetett alak. Claude.ai eldobja a tömb-sémás eszközt, ezért a `pages`
 * JSON-szöveg, a `sourceDocumentIds` vesszővel elválasztott lista; a szerver bontja ki.
 */
export const kbWikiWriteObject = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    wikiId: optionalWikiId,
    pages: z
      .string()
      .min(2)
      .max(2_000_000)
      .describe(
        'JSON array of page changes (max 50), e.g. [{"path":"entities/teya.md","action":"upsert","type":"entity","title":"Teya","summary":"…","category":"Providers","frontmatter":{"sources":[{"documentId":"…"}]},"body":"…"}] or [{"path":"entities/teya.md","action":"patch","patch":[{"op":"appendToSection","section":"Fees","text":"| Foreign | 1.5% |"}]}]',
      ),
    sourceDocumentIds: z.string().max(2000).optional().describe('Comma-separated raw source documentIds'),
    logEntry: kbWikiLogEntrySchema.optional(),
    inboxItemId: z.string().uuid().optional(),
    final: z.boolean().optional(),
  })
  .passthrough()

function parseJsonText(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function splitIdList(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

/** Az elemzett alak: a szövegként érkező listák tömbbé bontva (tömböt is elfogad). */
export const kbWikiWriteInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    wikiId: optionalWikiId,
    pages: z.preprocess(parseJsonText, z.array(kbWikiPageInputSchema).min(1).max(50)),
    sourceDocumentIds: z.preprocess(splitIdList, z.array(z.string().uuid()).max(50).optional()),
    logEntry: kbWikiLogEntrySchema.optional(),
    inboxItemId: z.string().uuid().optional(),
    final: z.boolean().optional(),
  })
  .passthrough()

/**
 * #943: a jóváhagyási sorba tett `kb_wiki_write` argumentuma. A tartalom a
 * `WikiChangeSet`-ben él; itt csak azonosítók és (közös wikinél) path-összesítő.
 */
export const kbWikiWriteOperationArgsSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    idempotencyKey: z.string().min(1).max(200),
    connectorId: z.string().uuid(),
    wikiId: z.string().uuid(),
    changeSetId: z.string().uuid(),
    pageCount: z.number().int().min(0).max(50),
    pages: z
      .array(z.object({ path: z.string().max(200), action: z.string().max(16) }).strict())
      .max(50)
      .optional(),
  })
  .strict()

const seqNumber = z.preprocess(
  (value) => (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value),
  z.number().int().min(1),
)

/** MCP-n hirdetett alak (transzformáció nélkül); az elemzés a `…InputSchema`-val megy. */
export const kbWikiChangesObject = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    wikiId: optionalWikiId,
    since: z
      .union([z.string().max(20), z.number().int().min(0)])
      .optional()
      .describe('Change number to list after, or "last_seen" (default): changes since you last looked.'),
    limit: z.number().int().min(1).max(50).optional(),
    markSeen: z.boolean().optional().describe('Default true: remember that you have seen these changes.'),
  })
  .passthrough()

export const kbWikiChangesInputSchema = kbWikiChangesObject.extend({
  since: z
    .preprocess(
      (value) => (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value),
      z.union([z.literal('last_seen'), z.number().int().min(0)]),
    )
    .optional(),
})

/** Egy oldal egy korábbi verzióra, vagy egy teljes change-set (sorszám) visszavonása. */
export const kbWikiRevertObject = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    wikiId: optionalWikiId,
    changeSeq: z
      .union([z.number().int().min(1), z.string().max(20)])
      .optional()
      .describe('Revert a whole change (its number from kb_wiki_changes).'),
    path: z.string().min(1).max(200).optional().describe('Restore one page (together with version).'),
    version: z
      .union([z.number().int().min(1), z.string().max(20)])
      .optional()
      .describe('The page version to restore (from kb_get_page asOf).'),
    note: z.string().max(2000).optional().describe('Why — shown to the approver.'),
  })
  .passthrough()

export const kbWikiRevertInputSchema = kbWikiRevertObject
  .extend({ changeSeq: seqNumber.optional(), version: seqNumber.optional() })
  .refine((value) => (value.changeSeq !== undefined) !== (value.path !== undefined && value.version !== undefined), {
    path: ['changeSeq'],
    message: 'Pass either changeSeq, or path and version.',
  })

export function schemaForEnterpriseKbTool(toolName: EnterpriseKbTool) {
  if (toolName === KB_LIST_INDEX_TOOL) return kbListIndexInputSchema
  if (toolName === KB_GET_PAGE_TOOL) return kbGetPageInputSchema
  if (toolName === KB_GET_DOCUMENT_TOOL) return kbGetDocumentInputSchema
  if (toolName === KB_INGEST_TOOL) return kbIngestInputSchema
  if (toolName === KB_WIKI_WRITE_TOOL) return kbWikiWriteInputSchema
  if (toolName === KB_WIKI_CHANGES_TOOL) return kbWikiChangesInputSchema
  if (toolName === KB_WIKI_REVERT_TOOL) return kbWikiRevertInputSchema
  return kbSearchInputSchema
}

export const sandboxRunInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    skillVersionId: z
      .string()
      .uuid()
      .describe('Pinned skill version id from platform.agent.get_definition → snapshot.skills[].skillVersionId'),
    entry: z
      .string()
      .min(1)
      .max(300)
      .describe('Skill-relative script path, e.g. scripts/run_napi_marketing_riport.py'),
    // ponytail: string not string[] — Claude.ai drops MCP tools whose advertised schema has arrays
    args: z
      .string()
      .max(2000)
      .optional()
      .describe('Whitespace-separated argv for the script. Do not put credentials here.'),
    inputs: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'Comma-separated work-file paths from this project (platform.work_file.list). Copied to /work/in/<path>. The sandbox has no network and no credentials. Do not pass local machine paths.',
      ),
    projectKey: z
      .string()
      .max(120)
      .optional()
      .describe('Work-file project for outputs and for inputs. Omit for __general__.'),
  })
  .passthrough()

export function schemaForEnterpriseSandboxTool(_toolName: EnterpriseSandboxTool) {
  return sandboxRunInputSchema
}

const optionalMcpConnectorId = z
  .string()
  .uuid()
  .optional()
  .describe('MCP connector id from mcp_list_tools (connectors[].connectorId). Required when several MCP servers are bound.')

export const mcpListToolsInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    connectorId: optionalMcpConnectorId,
    connectorName: optionalConnectorName,
    query: z.string().max(200).optional().describe('Filter tools by name or description substring.'),
  })
  .passthrough()

export const mcpCallInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    connectorId: optionalMcpConnectorId,
    connectorName: optionalConnectorName,
    account: optionalLinkedAccount,
    tool: z.string().min(1).max(200).describe('Tool name exactly as returned by mcp_list_tools.'),
    arguments: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Arguments object matching the tool inputSchema from mcp_list_tools.'),
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Required for tools whose risk is write or danger (they go to human approval).'),
  })
  .passthrough()

export function schemaForEnterpriseTool(toolName: string) {
  if (toolName === MCP_LIST_TOOLS_TOOL) return mcpListToolsInputSchema
  if (toolName === MCP_CALL_TOOL) return mcpCallInputSchema
  if (isEnterpriseDriveTool(toolName)) return schemaForEnterpriseDriveTool(toolName)
  if (isEnterpriseKbTool(toolName)) return schemaForEnterpriseKbTool(toolName)
  if (isEnterpriseSandboxTool(toolName)) return schemaForEnterpriseSandboxTool(toolName)
  if (toolName === GMAIL_GET_MESSAGE_TOOL) return gmailGetMessageInputSchema
  if (toolName === GMAIL_SEARCH_TOOL) return gmailSearchInputSchema
  if (toolName === GMAIL_GET_THREAD_TOOL) return gmailGetThreadInputSchema
  if (toolName === GMAIL_LIST_LABELS_TOOL) return gmailListLabelsInputSchema
  if (toolName === GMAIL_LIST_DRAFTS_TOOL) return gmailListDraftsInputSchema
  if (toolName === GMAIL_SEND_TOOL) return gmailSendInputSchema
  if (toolName === GMAIL_CREATE_DRAFT_TOOL) return gmailCreateDraftInputSchema
  if (toolName === GMAIL_MODIFY_LABELS_TOOL) return gmailModifyLabelsInputSchema
  if (toolName === GMAIL_TRASH_TOOL) return gmailTrashInputSchema
  if (toolName === MAIL_LIST_ACCOUNTS_TOOL) return mailListAccountsInputSchema
  if (toolName === MAIL_SEARCH_TOOL) return mailSearchInputSchema
  if (toolName === MAIL_GET_MESSAGE_TOOL) return mailGetMessageInputSchema
  if (toolName === MAIL_GET_THREAD_TOOL) return mailGetThreadInputSchema
  if (toolName === MAIL_GET_ATTACHMENT_TOOL) return mailGetAttachmentInputSchema
  if (toolName === MAIL_SEND_TOOL) return mailSendInputSchema
  if (toolName === MAIL_CREATE_DRAFT_TOOL) return mailCreateDraftInputSchema
  if (toolName === MAIL_MARK_TOOL) return mailMarkInputSchema
  if (toolName === HTTP_API_GET_ALL_TOOL) return httpApiGetAllInputSchema
  if (toolName === HTTP_API_REQUEST_TOOL) return httpApiRequestInputSchema
  if (toolName === HTTP_API_GET_TOOL) return httpApiGetInputSchema
  return null
}
