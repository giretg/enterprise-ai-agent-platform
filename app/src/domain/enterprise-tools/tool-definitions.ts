import { z } from 'zod'

export const GOOGLE_DRIVE_SEARCH_TOOL = 'google_drive_search'
export const GOOGLE_DRIVE_READ_FILE_TOOL = 'google_drive_read_file'
export const GOOGLE_DRIVE_CREATE_FOLDER_TOOL = 'google_drive_create_folder'
export const GOOGLE_DRIVE_UPLOAD_FILE_TOOL = 'google_drive_upload_file'
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

export const ENTERPRISE_DRIVE_WRITE_TOOLS = [
  GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
  GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
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

export const KB_SEARCH_TOOL = 'kb_search'
export const KB_LIST_INDEX_TOOL = 'kb_list_index'
export const KB_GET_PAGE_TOOL = 'kb_get_page'
export const KB_GET_DOCUMENT_TOOL = 'kb_get_document'
export const KB_INGEST_TOOL = 'kb_ingest'

export const ENTERPRISE_KB_TOOLS = [
  KB_SEARCH_TOOL,
  KB_LIST_INDEX_TOOL,
  KB_GET_PAGE_TOOL,
  KB_GET_DOCUMENT_TOOL,
  KB_INGEST_TOOL,
] as const

export const ENTERPRISE_WRITE_TOOLS = [
  ...ENTERPRISE_DRIVE_WRITE_TOOLS,
  ...ENTERPRISE_GMAIL_WRITE_TOOLS,
  ...ENTERPRISE_HTTP_WRITE_TOOLS,
] as const

export const ENTERPRISE_TOOLS = [
  ...ENTERPRISE_DRIVE_TOOLS,
  ...ENTERPRISE_GMAIL_TOOLS,
  ...ENTERPRISE_HTTP_TOOLS,
  ...ENTERPRISE_KB_TOOLS,
] as const

export type EnterpriseDriveWriteTool = (typeof ENTERPRISE_DRIVE_WRITE_TOOLS)[number]
export type EnterpriseDriveTool = (typeof ENTERPRISE_DRIVE_TOOLS)[number]
export type EnterpriseGmailTool = (typeof ENTERPRISE_GMAIL_TOOLS)[number]
export type EnterpriseGmailWriteTool = (typeof ENTERPRISE_GMAIL_WRITE_TOOLS)[number]
export type EnterpriseHttpWriteTool = (typeof ENTERPRISE_HTTP_WRITE_TOOLS)[number]
export type EnterpriseHttpTool = (typeof ENTERPRISE_HTTP_TOOLS)[number]
export type EnterpriseKbTool = (typeof ENTERPRISE_KB_TOOLS)[number]
export type EnterpriseWriteTool = (typeof ENTERPRISE_WRITE_TOOLS)[number]
export type EnterpriseTool = (typeof ENTERPRISE_TOOLS)[number]

const ENTERPRISE_DRIVE_TOOL_SET = new Set<string>(ENTERPRISE_DRIVE_TOOLS)
const ENTERPRISE_DRIVE_WRITE_TOOL_SET = new Set<string>(ENTERPRISE_DRIVE_WRITE_TOOLS)
const ENTERPRISE_GMAIL_TOOL_SET = new Set<string>(ENTERPRISE_GMAIL_TOOLS)
const ENTERPRISE_GMAIL_WRITE_TOOL_SET = new Set<string>(ENTERPRISE_GMAIL_WRITE_TOOLS)
const ENTERPRISE_HTTP_TOOL_SET = new Set<string>(ENTERPRISE_HTTP_TOOLS)
const ENTERPRISE_HTTP_WRITE_TOOL_SET = new Set<string>(ENTERPRISE_HTTP_WRITE_TOOLS)
const ENTERPRISE_KB_TOOL_SET = new Set<string>(ENTERPRISE_KB_TOOLS)
const ENTERPRISE_WRITE_TOOL_SET = new Set<string>(ENTERPRISE_WRITE_TOOLS)
const ENTERPRISE_TOOL_SET = new Set<string>(ENTERPRISE_TOOLS)

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

export function isEnterpriseKbTool(toolName: string): toolName is EnterpriseKbTool {
  return ENTERPRISE_KB_TOOL_SET.has(toolName)
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
  .describe('Published agent definition id — from platform.agent.get_definition for the chosen agentId (required on every enterprise tool)')
const optionalAgentId = z.string().uuid().optional()
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
    'Human connector name from the published agent definition (connectors[].name). Prefer this over connectorId when several HTTP APIs are bound.',
  )
const scalarMap = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

export const googleDriveSearchInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    query: z
      .string()
      .max(1000)
      .optional()
      .describe('Google Drive search query. Omit with nameContains to list recent files.'),
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
    name: z.string().min(1).max(500),
    parentFolderId: z.string().max(200).optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .passthrough()

export const googleDriveUploadFileInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    name: z.string().min(1).max(500),
    textContent: z
      .string()
      .min(1)
      .max(200_000)
      .describe('File body as text. For HTML reports, CSV, JSON, or plain text.'),
    mimeType: z.string().max(200).optional(),
    parentFolderId: z.string().max(200).optional(),
    convertToGoogleType: z.enum(['doc', 'sheet', 'slides']).optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .passthrough()

export const googleSheetsWriteRangeInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
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
    id: z.string().min(1).max(200).describe('Gmail message id from gmail_search'),
  })
  .passthrough()

export const gmailGetThreadInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    threadId: z.string().min(1).max(200).describe('Gmail threadId from gmail_search or gmail_get_message'),
  })
  .passthrough()

export const gmailListLabelsInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
  })
  .passthrough()

export const gmailListDraftsInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    maxResults: z.number().int().min(1).max(25).optional(),
  })
  .passthrough()

// ponytail: comma-separated strings not string[] — Claude.ai drops advertised array schemas
const emailList = (what: string) =>
  z.string().max(2000).optional().describe(`${what}: comma-separated addresses, e.g. "Anna <anna@x.hu>, bela@y.hu"`)

const composeFields = {
  definitionId,
  agentId: optionalAgentId,
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

export const httpApiGetInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    connectorId: optionalConnectorId,
    connectorName: optionalConnectorName,
    path: z
      .string()
      .min(1)
      .max(1000)
      .describe('Path relative to the connector baseUrl. Auth and host come from the connector.'),
    query: scalarMap.optional().describe('Query params documented on the connector endpoint'),
  })
  .passthrough()

export const httpApiGetAllInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    connectorId: optionalConnectorId,
    connectorName: optionalConnectorName,
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
    method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().min(1).max(1000),
    query: scalarMap.optional(),
    body: z
      .string()
      .max(50_000)
      .optional()
      .describe('JSON request body as a string. Required for POST/PUT/PATCH when the endpoint expects a body.'),
    idempotencyKey: z.string().min(1).max(200),
  })
  .passthrough()

export function schemaForEnterpriseDriveTool(toolName: EnterpriseDriveTool) {
  if (toolName === GOOGLE_DRIVE_READ_FILE_TOOL) return googleDriveReadFileInputSchema
  if (toolName === GOOGLE_DRIVE_CREATE_FOLDER_TOOL) return googleDriveCreateFolderInputSchema
  if (toolName === GOOGLE_DRIVE_UPLOAD_FILE_TOOL) return googleDriveUploadFileInputSchema
  if (toolName === GOOGLE_SHEETS_WRITE_RANGE_TOOL) return googleSheetsWriteRangeInputSchema
  return googleDriveSearchInputSchema
}

export const kbSearchInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    query: z.string().min(1).max(1000),
    k: z.number().int().min(1).max(20).optional(),
  })
  .passthrough()

export const kbListIndexInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    pathPrefix: z.string().max(200).optional(),
    maxDepth: z.number().int().min(1).max(8).optional(),
    artifactId: z.string().uuid().optional(),
  })
  .passthrough()

export const kbGetPageInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    path: z.string().min(1).max(400),
    artifactId: z.string().uuid().optional(),
  })
  .passthrough()

export const kbGetDocumentInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    documentId: z.string().uuid(),
    section: z.string().max(200).optional(),
  })
  .passthrough()

export const kbIngestInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    filename: z.string().min(1).max(255),
    processingMode: z.enum(['raw_text_only', 'okf']),
    mimeType: z.string().max(200).optional(),
    purpose: z.string().max(240).optional(),
    content: z.string().max(2_000_000).optional(),
    contentBase64: z.string().max(2_800_000).optional(),
  })
  .passthrough()

export function schemaForEnterpriseKbTool(toolName: EnterpriseKbTool) {
  if (toolName === KB_LIST_INDEX_TOOL) return kbListIndexInputSchema
  if (toolName === KB_GET_PAGE_TOOL) return kbGetPageInputSchema
  if (toolName === KB_GET_DOCUMENT_TOOL) return kbGetDocumentInputSchema
  if (toolName === KB_INGEST_TOOL) return kbIngestInputSchema
  return kbSearchInputSchema
}

export function schemaForEnterpriseTool(toolName: string) {
  if (isEnterpriseDriveTool(toolName)) return schemaForEnterpriseDriveTool(toolName)
  if (isEnterpriseKbTool(toolName)) return schemaForEnterpriseKbTool(toolName)
  if (toolName === GMAIL_GET_MESSAGE_TOOL) return gmailGetMessageInputSchema
  if (toolName === GMAIL_SEARCH_TOOL) return gmailSearchInputSchema
  if (toolName === GMAIL_GET_THREAD_TOOL) return gmailGetThreadInputSchema
  if (toolName === GMAIL_LIST_LABELS_TOOL) return gmailListLabelsInputSchema
  if (toolName === GMAIL_LIST_DRAFTS_TOOL) return gmailListDraftsInputSchema
  if (toolName === GMAIL_SEND_TOOL) return gmailSendInputSchema
  if (toolName === GMAIL_CREATE_DRAFT_TOOL) return gmailCreateDraftInputSchema
  if (toolName === GMAIL_MODIFY_LABELS_TOOL) return gmailModifyLabelsInputSchema
  if (toolName === GMAIL_TRASH_TOOL) return gmailTrashInputSchema
  if (toolName === HTTP_API_GET_ALL_TOOL) return httpApiGetAllInputSchema
  if (toolName === HTTP_API_REQUEST_TOOL) return httpApiRequestInputSchema
  if (toolName === HTTP_API_GET_TOOL) return httpApiGetInputSchema
  return null
}
